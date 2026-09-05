import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StatusReader } from "../src/status-reader.js";
import { readActiveWork } from "../src/hermes-status.js";
import { buildBrief } from "../src/brief.js";

const paths = { stateDb: "/missing", kanbanDb: "/missing", gatewayState: "/missing", cronDb: "/missing", cronJobs: "/missing" };
class FakeWorker extends EventEmitter {
  postMessage({ id, method }) { queueMicrotask(() => this.emit("message", { id, value: method === "snapshot" ? { gateway: { state: "ok" } } : null })); }
  terminate() { return Promise.resolve(); }
  unref() {}
}
test("snapshot cache refreshes, expires, and survives a failed worker refresh", async (t) => {
  let worker;
  const reader = new StatusReader({ paths, maxAgeMs: 20, workerFactory: () => (worker = new FakeWorker()) });
  t.after(() => reader.close());
  await reader.refresh(); assert.equal((await reader.snapshot()).gateway.state, "ok");
  worker.postMessage = () => {}; reader.timeoutMs = 10;
  await reader.refresh(); assert.equal((await reader.snapshot()).gateway.state, "ok");
  reader.cachedAt -= 100; assert.deepEqual(await reader.snapshot(), {});
  await reader.refresh(); assert.equal((await reader.snapshot()).gateway.state, "ok");
});
test("blocked worker is terminated without blocking the audio/event-loop cadence", async (t) => {
  let count = 0;
  const reader = new StatusReader({ paths, timeoutMs: 100, workerFactory: () => {
    count++;
    return new Worker('const {parentPort}=require("node:worker_threads");parentPort.on("message",()=>{while(true){}})', { eval: true });
  } });
  t.after(() => reader.close());
  let ticks = 0; const timer = setInterval(() => ticks++, 10);
  await reader.refresh(); clearInterval(timer);
  assert.ok(ticks >= 3, `event loop only ticked ${ticks} times`);
  assert.equal(reader.worker, null);
  await reader.refresh(); assert.equal(count, 2);
});
test("worker reads a locked database off-thread and reports unavailable data", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "voice-status-"));
  const path = join(dir, "state.db"); const db = new DatabaseSync(path);
  db.exec("CREATE TABLE gateway_routing(entry_json TEXT); BEGIN EXCLUSIVE;");
  const reader = new StatusReader({ paths: { ...paths, stateDb: path }, hlvUrl: "invalid", timeoutMs: 1500 });
  t.after(async () => { db.exec("ROLLBACK"); db.close(); await reader.close(); await rm(dir, { recursive: true, force: true }); });
  let ticks = 0; const timer = setInterval(() => ticks++, 10);
  await reader.refresh(); clearInterval(timer);
  assert.ok(ticks >= 3);
  const snapshot = await reader.snapshot();
  assert.ok(!snapshot.activeWork || Object.values(snapshot.activeWork).every((n) => n === null));
});
test("missing tables cannot become Background: quiet", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "voice-status-schema-")); const path = join(dir, "state.db");
  const db = new DatabaseSync(path); db.exec("CREATE TABLE unrelated(value TEXT)"); db.close();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const work = readActiveWork(path); assert.ok(Object.values(work).every((n) => n === null));
  assert.match(buildBrief({ activeWork: work }), /Background: status unavailable/);
});
