// Read-only views of Hermes state for the voice brief and /focus resolution.
//
// Everything here is best-effort: any reader that cannot answer returns
// null/[] instead of throwing, so a locked database or a moved file degrades
// the brief to omission rather than breaking the call path. All reads are
// same-user, read-only opens against live WAL databases — never immutable=1,
// always a short busy_timeout.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

function withDb(path, fn) {
  let db = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 250");
    return fn(db);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // already closed or never opened
    }
  }
}

// Resolve a Discord thread id to the Hermes session that thread chats in.
// Newest matching sessions row wins; when gateway_routing knows a current tip
// for the thread's session key (compression forks move the id), prefer it.
export function resolveThreadSession(stateDbPath, threadId) {
  return withDb(stateDbPath, (db) => {
    const row = db
      .prepare(
        `SELECT id, title, chat_id, thread_id, message_count
         FROM sessions
         WHERE source='discord' AND chat_type='thread' AND thread_id = ? AND archived = 0
         ORDER BY COALESCE(last_activity_at, started_at) DESC
         LIMIT 1`,
      )
      .get(String(threadId));
    if (!row) return null;
    let sessionId = row.id;
    try {
      const key = `agent:main:discord:thread:${row.chat_id}:${row.thread_id}`;
      const routed = db
        .prepare(`SELECT entry_json FROM gateway_routing WHERE session_key = ?`)
        .get(key);
      const tip = routed ? JSON.parse(routed.entry_json)?.session_id : null;
      if (typeof tip === "string" && tip) sessionId = tip;
    } catch {
      // routing row missing or unparsable: the sessions row is still correct
    }
    return {
      sessionId,
      title: row.title ?? null,
      chatId: row.chat_id,
      threadId: row.thread_id,
      messageCount: row.message_count ?? null,
    };
  });
}

export function readGatewayState(path) {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    const platforms = Object.entries(data.platforms ?? {})
      .filter(([, v]) => v?.state === "connected")
      .map(([name]) => name);
    return {
      state: data.gateway_state ?? "unknown",
      activeAgents: data.active_agents ?? 0,
      platforms,
    };
  } catch {
    return null;
  }
}

export function readKanban(dbPath) {
  return withDb(dbPath, (db) => {
    const counts = {};
    for (const row of db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM tasks
         WHERE status NOT IN ('done','archived','cancelled') GROUP BY status`,
      )
      .all()) {
      counts[row.status] = row.n;
    }
    let inProgress = [];
    try {
      inProgress = db
        .prepare(
          `SELECT title FROM tasks WHERE status IN ('running','in_progress','claimed')
           ORDER BY rowid DESC LIMIT 3`,
        )
        .all()
        .map((r) => r.title);
    } catch {
      // schema drift on the titles query loses examples, not the counts
    }
    return { counts, inProgress };
  });
}

function jobNames(jobsJsonPath) {
  try {
    const data = JSON.parse(readFileSync(jobsJsonPath, "utf8"));
    const entries = Array.isArray(data) ? data : Array.isArray(data.jobs) ? data.jobs : null;
    const names = {};
    if (entries) {
      for (const job of entries) {
        if (job?.id) names[job.id] = job.name ?? job.id;
      }
    } else if (data && typeof data === "object") {
      for (const [id, job] of Object.entries(data)) names[id] = job?.name ?? id;
    }
    return names;
  } catch {
    return {};
  }
}

// Latest result per cron job in the window, failures first.
export function readCron(execDbPath, jobsJsonPath, windowHours = 12) {
  const names = jobNames(jobsJsonPath);
  return withDb(execDbPath, (db) => {
    const since = (Date.now() - windowHours * 3600_000) / 1000;
    const rows = db
      .prepare(
        `SELECT job_id, status, finished_at, error FROM executions
         WHERE finished_at > ? ORDER BY finished_at DESC LIMIT 50`,
      )
      .all(since);
    const latest = new Map();
    for (const row of rows) {
      if (!latest.has(row.job_id)) latest.set(row.job_id, row);
    }
    const results = [...latest.values()].map((row) => ({
      name: names[row.job_id] ?? row.job_id,
      ok: row.status === "completed",
      finishedAt: row.finished_at ? row.finished_at * 1000 : null,
      error: row.error ? String(row.error).split("\n")[0].slice(0, 120) : null,
    }));
    results.sort((a, b) => Number(a.ok) - Number(b.ok));
    return results;
  });
}

export function readActiveWork(stateDbPath) {
  return withDb(stateDbPath, (db) => {
    const one = (sql) => {
      try {
        return db.prepare(sql).get()?.n ?? 0;
      } catch {
        return 0;
      }
    };
    return {
      delegations: one(
        `SELECT COUNT(*) AS n FROM async_delegations
         WHERE state NOT IN ('completed','failed','cancelled','delivered')`,
      ),
      pendingDeliveries: one(
        `SELECT COUNT(*) AS n FROM delivery_obligations WHERE state = 'pending'`,
      ),
      activeTurns: one(
        `SELECT COUNT(*) AS n FROM gateway_routing
         WHERE json_extract(entry_json, '$.active_turn_token') IS NOT NULL`,
      ),
    };
  });
}

function threadsFromDb(stateDbPath, limit) {
  return (
    withDb(stateDbPath, (db) =>
      db
        .prepare(
          `SELECT id, title, COALESCE(last_activity_at, started_at) AS last_active
           FROM sessions
           WHERE source='discord' AND chat_type='thread' AND archived = 0
           ORDER BY last_active DESC LIMIT ?`,
        )
        .all(limit)
        .map((r) => ({
          sessionId: r.id,
          title: r.title ?? r.id,
          lastActive: r.last_active ? r.last_active * 1000 : null,
        })),
    ) ?? []
  );
}

// Recent Discord thread conversations, titles first-class. HLV's HTTP listing
// is preferred (it orders by real last activity); direct SQLite is the fallback.
export async function listRecentDiscordThreads({ hlvUrl, hlvToken, stateDbPath, limit = 6 }) {
  try {
    const base = new URL(hlvUrl);
    const scheme = base.protocol === "wss:" ? "https" : "http";
    const headers = {};
    if (hlvToken) headers.Authorization = `Bearer ${hlvToken}`;
    const res = await fetch(
      `${scheme}://${base.host}/v1/conversations?limit=${limit}&source=discord`,
      { headers, signal: AbortSignal.timeout(1500) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const items = Array.isArray(body) ? body : (body.conversations ?? body.sessions ?? []);
    const threads = items
      .map((c) => ({
        sessionId: c.sessionId ?? c.id,
        title: c.title ?? c.sessionId ?? c.id,
        lastActive: c.last_active ? Date.parse(c.last_active) || null : null,
      }))
      .filter((c) => c.sessionId);
    if (threads.length > 0) return threads.slice(0, limit);
  } catch {
    // gateway down or shape changed: fall through to SQLite
  }
  return threadsFromDb(stateDbPath, limit);
}
