import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  listRecentDiscordThreads,
  readActiveWork,
  readCron,
  readGatewayState,
  readKanban,
  resolveThreadSession,
} from "../src/hermes-status.js";

async function tmpFile(name) {
  const dir = await mkdtemp(join(tmpdir(), "hermes-status-test-"));
  return join(dir, name);
}

function seedStateDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT, chat_type TEXT, thread_id TEXT, chat_id TEXT,
      title TEXT, archived INTEGER DEFAULT 0, last_activity_at REAL, started_at REAL,
      message_count INTEGER
    );
    CREATE TABLE gateway_routing (
      scope TEXT NOT NULL DEFAULT '', session_key TEXT NOT NULL,
      entry_json TEXT NOT NULL, updated_at REAL NOT NULL,
      PRIMARY KEY (scope, session_key)
    );
    CREATE TABLE async_delegations (delegation_id TEXT, state TEXT);
    CREATE TABLE delivery_obligations (obligation_id TEXT, state TEXT);
  `);
  const insert = db.prepare(
    `INSERT INTO sessions (id, source, chat_type, thread_id, chat_id, title, archived, last_activity_at, started_at, message_count)
     VALUES (?, 'discord', 'thread', ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Two sessions for one thread: the older one and the current one.
  insert.run("sess_old", "111", "111", "Old fork", 0, null, 100, 50);
  insert.run("sess_new", "111", "111", "Kokoro API", 0, null, 200, 129);
  // An archived session for another thread must never resolve.
  insert.run("sess_archived", "222", "222", "Archived", 1, null, 300, 10);
  db.prepare(
    `INSERT INTO gateway_routing (scope, session_key, entry_json, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(
    "/home/alex/.hermes/sessions",
    "agent:main:discord:thread:111:111",
    JSON.stringify({ session_id: "sess_routed_tip" }),
    1,
  );
  db.prepare(`INSERT INTO async_delegations VALUES ('d1', 'running'), ('d2', 'completed')`).run();
  db.prepare(`INSERT INTO delivery_obligations VALUES ('o1', 'pending'), ('o2', 'delivered')`).run();
  db.close();
  return path;
}

test("resolveThreadSession prefers the routing tip over the newest sessions row", async () => {
  const dbPath = seedStateDb(await tmpFile("state.db"));
  const resolved = resolveThreadSession(dbPath, "111");
  assert.ok(resolved);
  assert.equal(resolved.sessionId, "sess_routed_tip");
  assert.equal(resolved.title, "Kokoro API"); // newest row's metadata
  assert.equal(resolved.messageCount, 129);
});

test("resolveThreadSession falls back to the newest row without routing, and rejects archived/unknown", async () => {
  const dbPath = seedStateDb(await tmpFile("state.db"));
  const db = new DatabaseSync(dbPath);
  db.prepare("DELETE FROM gateway_routing").run();
  db.close();
  assert.equal(resolveThreadSession(dbPath, "111").sessionId, "sess_new");
  assert.equal(resolveThreadSession(dbPath, "222"), null); // archived
  assert.equal(resolveThreadSession(dbPath, "999"), null); // unknown
  assert.equal(resolveThreadSession("/nonexistent/state.db", "111"), null); // unreadable db
});

test("readActiveWork counts only live work", async () => {
  const dbPath = seedStateDb(await tmpFile("state.db"));
  const work = readActiveWork(dbPath);
  assert.equal(work.delegations, 1);
  assert.equal(work.pendingDeliveries, 1);
  assert.equal(work.activeTurns, 0); // no active_turn_token in the seeded entry
});

test("readCron reports the latest result per job, names joined from jobs.json", async () => {
  const dbPath = await tmpFile("executions.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE executions (job_id TEXT, status TEXT, finished_at REAL, error TEXT)`);
  const now = Date.now() / 1000;
  const ins = db.prepare(`INSERT INTO executions VALUES (?, ?, ?, ?)`);
  ins.run("j1", "failed", now - 100, "Traceback:\n  SyntaxError: bad");
  ins.run("j1", "completed", now - 5000, null); // older run must lose
  ins.run("j2", "completed", now - 200, null);
  ins.run("j3", "completed", now - 999_999, null); // outside the window
  db.close();
  const jobsPath = await tmpFile("jobs.json");
  await writeFile(jobsPath, JSON.stringify([{ id: "j1", name: "review loop" }, { id: "j2", name: "journal" }]));
  const cron = readCron(dbPath, jobsPath, 12);
  assert.equal(cron.length, 2);
  assert.equal(cron[0].name, "review loop"); // failure sorts first
  assert.equal(cron[0].ok, false);
  assert.equal(cron[0].error, "Traceback:");
  assert.equal(cron[1].name, "journal");
});

test("readKanban summarizes open work and readGatewayState parses platforms", async () => {
  const dbPath = await tmpFile("kanban.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE tasks (title TEXT, status TEXT)`);
  db.prepare(`INSERT INTO tasks VALUES ('Build gate', 'in_progress'), ('Old', 'done'), ('Queue it', 'todo')`).run();
  db.close();
  const kanban = readKanban(dbPath);
  assert.deepEqual(kanban.counts, { in_progress: 1, todo: 1 });
  assert.deepEqual(kanban.inProgress, ["Build gate"]);

  const gwPath = await tmpFile("gateway_state.json");
  await writeFile(
    gwPath,
    JSON.stringify({
      gateway_state: "running",
      active_agents: 0,
      platforms: { discord: { state: "connected" }, api_server: { state: "connected" }, slack: { state: "down" } },
    }),
  );
  const gw = readGatewayState(gwPath);
  assert.equal(gw.state, "running");
  assert.deepEqual(gw.platforms, ["discord", "api_server"]);
  assert.equal(readGatewayState("/nonexistent.json"), null);
});

test("listRecentDiscordThreads falls back to SQLite when the gateway is unreachable", async () => {
  const dbPath = seedStateDb(await tmpFile("state.db"));
  const threads = await listRecentDiscordThreads({
    hlvUrl: "ws://127.0.0.1:1/v1/live", // nothing listens here
    stateDbPath: dbPath,
    limit: 5,
  });
  assert.equal(threads.length, 2); // archived row excluded
  assert.equal(threads[0].sessionId, "sess_new"); // newest first
  assert.equal(threads[0].title, "Kokoro API");
});
