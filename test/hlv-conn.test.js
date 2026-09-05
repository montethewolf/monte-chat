import test from "node:test";
import assert from "node:assert/strict";
import { FakeGateway } from "./fake-gateway.js";
import { HlvConnection } from "../src/hlv-conn.js";

const FAST = { backoffBaseMs: 25, backoffMaxMs: 200, jitterMs: 0 };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function event(emitter, type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const done = (value) => { clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { emitter.off(type, done); reject(new Error(`Timed out: ${type}`)); }, timeout);
    emitter.once(type, done);
  });
}
async function setup(t, options = {}, connection = {}) {
  const gw = new FakeGateway(options); await gw.listen();
  const conn = new HlvConnection({ url: gw.url, ...FAST, ...connection });
  t.after(async () => { await conn.stop(); await gw.close(); });
  return { gw, conn };
}
async function connect(conn) { const ready = event(conn, "ready"); await conn.start(); return ready; }

test("connects and commits readiness before exposing the session", async (t) => {
  let committed;
  const { conn } = await setup(t, {}, { commitSession: async (ready) => { committed = ready.conversation.sessionId; } });
  const ready = await connect(conn);
  assert.equal(conn.sessionId, committed);
  assert.equal(ready.conversation.sessionId, committed);
  assert.equal(conn.connected, true);
});
test("authenticates with header only", async (t) => {
  const { conn, gw } = await setup(t, {}, { token: "test-token" });
  await connect(conn);
  assert.equal(gw.authHeaders[0], "Bearer test-token");
  assert.ok(!gw.upgradeUrls[0].includes("token="));
});
test("resumes an exact saved id even when listing omits it", async (t) => {
  const { conn, gw } = await setup(t, { conversations: [] }, { sessionId: "old-session" });
  await connect(conn);
  assert.deepEqual(gw.starts[0].conversation, { mode: "resume", sessionId: "old-session" });
});
test("ambiguous rejected resume retries the same session and retains its pin", async (t) => {
  const { conn, gw } = await setup(t, { behavior: { failResumeOnce: true } }, { sessionId: "saved", pinnedSessionId: "saved" });
  await connect(conn);
  assert.equal(gw.starts.length, 2);
  assert.ok(gw.starts.every((m) => m.conversation.mode === "resume" && m.conversation.sessionId === "saved"));
  assert.equal(conn.pinnedSessionId, "saved");
});
test("backs off on recoverable start failure", async (t) => {
  const { conn, gw } = await setup(t, { behavior: { failStartTimes: 2 } });
  const delays = []; conn.on("backoff", (e) => delays.push(e.delayMs));
  await connect(conn);
  assert.equal(gw.starts.length, 3); assert.deepEqual(delays, [25, 50]);
});
test("honors HTTP Retry-After", async (t) => {
  const { conn, gw } = await setup(t, { behavior: { capacity503Times: 1, retryAfterSeconds: 1 } });
  const start = Date.now(); await connect(conn);
  assert.ok(Date.now() - start >= 950); assert.equal(gw.upgradeUrls.length, 2);
});
test("halts, closes sockets, and preserves session on fatal startup", async (t) => {
  const { conn } = await setup(t, { behavior: { fatalStart: true } }, { sessionId: "saved" });
  const halted = event(conn, "halted"); await conn.start(); await halted;
  assert.equal(conn.state, "halted"); assert.equal(conn.desired, false); assert.equal(conn.sessionId, "saved");
  await conn.start(); assert.equal(conn.state, "halted");
});
test("established 1008 close halts and notifies teardown", async (t) => {
  const { conn, gw } = await setup(t); await connect(conn);
  const halted = event(conn, "halted"); const disconnected = event(conn, "disconnected");
  gw.kick(1008, "policy"); await halted; await disconnected;
  assert.equal(conn.connected, false);
});
test("nonfatal established drop reconnects", async (t) => {
  const { conn, gw } = await setup(t); await connect(conn);
  const ready = event(conn, "ready"); gw.kick(1012, "restart"); await ready;
  assert.equal(gw.starts.length, 2); assert.equal(gw.starts[1].conversation.mode, "resume");
});
test("unanswered ping terminates and reconnects", async (t) => {
  const { conn, gw } = await setup(t, {}, { pingIntervalMs: 30, pongTimeoutMs: 50 });
  await connect(conn); const ready = event(conn, "ready"); const timeout = event(conn, "ping-timeout");
  gw.pauseAll(); await timeout; await ready; assert.equal(gw.starts.length, 2);
});
test("stop while preparing a session cannot resurrect the connection", async (t) => {
  let release; let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const { conn, gw } = await setup(t, {}, { prepareSession: async () => { entered(); return new Promise((r) => { release = r; }); } });
  let ready = 0; conn.on("ready", () => ready++);
  await conn.start(); await waiting; await conn.stop(); release("stale"); await tick();
  assert.equal(ready, 0); assert.equal(gw.starts.length, 0); assert.equal(conn.state, "idle");
});
test("late commit cannot emit ready after stop", async (t) => {
  let release; let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const { conn } = await setup(t, {}, { commitSession: async (_ready, signal) => {
    entered(); await new Promise((r) => { release = r; }); signal.throwIfAborted();
  } });
  let ready = 0; conn.on("ready", () => ready++);
  await conn.start(); await waiting; await conn.stop(); release(); await tick();
  assert.equal(ready, 0); assert.equal(conn.sessionId, null);
});
test("new attempt supersedes old preparation and failure callbacks", async (t) => {
  let rejectOld; let entered; let n = 0;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const { conn, gw } = await setup(t, {}, { prepareSession: async () => {
    if (++n > 1) return "current";
    entered(); return new Promise((_resolve, reject) => { rejectOld = reject; });
  } });
  await conn.start(); await waiting; await conn.stop(); await connect(conn);
  rejectOld(new Error("old error")); await tick();
  assert.equal(conn.state, "ready"); assert.equal(gw.starts.length, 1); assert.equal(conn.sessionId, "current");
});
test("stop is idempotent, detaches rather than cancels work", async (t) => {
  const { conn, gw } = await setup(t); await connect(conn);
  const sid = conn.sessionId;
  await Promise.all([conn.stop(), conn.stop()]);
  assert.equal(conn.sessionId, sid); assert.equal(conn.state, "idle");
  assert.ok(gw.messages.some((m) => m.type === "session.close" && m.detach === true));
  assert.ok(!gw.messages.some((m) => m.type === "task.stop"));
});
test("rebind and explicit fresh selection", async (t) => {
  const { conn, gw } = await setup(t); await connect(conn);
  let ready = event(conn, "ready"); await conn.rebind("focused", { pinned: true }); await ready;
  assert.equal(conn.sessionId, "focused");
  ready = event(conn, "ready"); await conn.rebind(null); await ready;
  assert.equal(gw.starts.at(-1).conversation.mode, "new"); assert.equal(conn.pinnedSessionId, null);
});

test("hung handshake has a deadline and stop cancels retry", async (t) => {
  const { conn, gw } = await setup(t, { behavior: { holdStart: true } }, { connectTimeoutMs: 40 });
  const failed = event(conn, "attempt-failed"); await conn.start(); await failed;
  assert.equal(conn.connected, false);
  await conn.stop(); const count = gw.starts.length;
  await new Promise((r) => setTimeout(r, 80)); assert.equal(gw.starts.length, count); assert.equal(conn.state, "idle");
});
test("stop during handshake aborts before timeout without a stale ready event", async (t) => {
  const { conn, gw } = await setup(t, { behavior: { holdStart: true } });
  const received = new Promise((resolve) => { gw.onMessage = (_ws, msg) => { if (msg.type === "session.start") resolve(); }; });
  let count = 0; conn.on("ready", () => count++);
  await conn.start(); await received; await conn.stop(); await tick();
  assert.equal(conn.state, "idle"); assert.equal(count, 0); assert.equal(conn.connected, false);
});

test("events received during persistence wait are forwarded only after committed readiness", async (t) => {
  let release; let entered;
  const waiting = new Promise((r) => { entered = r; });
  const { conn, gw } = await setup(t, {}, { commitSession: async () => { entered(); await new Promise((r) => { release = r; }); } });
  const events = []; conn.on("ready", () => events.push("ready")); conn.on("transcript.delta", () => events.push("transcript"));
  await conn.start(); await waiting;
  gw.broadcast({ type: "transcript.delta", speaker: "assistant", final: true, text: "Pending notice" });
  await new Promise((r) => setTimeout(r, 10)); assert.deepEqual(events, []);
  const ready = event(conn, "ready"); release(); await ready;
  assert.deepEqual(events, ["ready", "transcript"]);
});
