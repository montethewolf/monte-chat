import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGateway } from "./fake-gateway.js";
import { HlvConnection } from "../src/hlv-conn.js";

const FAST = { backoffBaseMs: 25, backoffMaxMs: 200, jitterMs: 5 };

async function tmpState() {
  const dir = await mkdtemp(join(tmpdir(), "hlv-conn-test-"));
  return join(dir, "state.json");
}

function eventOnce(emitter, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${type}`)),
      timeoutMs,
    );
    emitter.once(type, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

async function withGateway(t, options, fn) {
  const gw = new FakeGateway(options);
  await gw.listen();
  const conns = [];
  t.after(async () => {
    for (const conn of conns) await conn.stop();
    await gw.close();
  });
  const make = (extra = {}) => {
    const conn = new HlvConnection({ url: gw.url, ...FAST, ...extra });
    conns.push(conn);
    return conn;
  };
  await fn(gw, make);
}

test("connects, reaches ready, persists the new sessionId", async (t) => {
  await withGateway(t, {}, async (gw, make) => {
    const stateFile = await tmpState();
    const conn = make({ stateFile });
    const readyEvent = eventOnce(conn, "ready");
    await conn.start();
    const ready = await readyEvent;
    assert.equal(conn.state, "ready");
    assert.equal(ready.type, "session.ready");
    assert.equal(gw.starts.length, 1);
    assert.equal(gw.starts[0].conversation.mode, "new");
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(saved.sessionId, ready.conversation.sessionId);
  });
});

test("authenticates with a Bearer header only — never a token query param", async (t) => {
  await withGateway(t, {}, async (gw, make) => {
    const conn = make({ token: "secr3t-token" });
    const readyEvent = eventOnce(conn, "ready");
    await conn.start();
    await readyEvent;
    assert.equal(gw.authHeaders[0], "Bearer secr3t-token");
    assert.ok(!gw.upgradeUrls[0].includes("token="), "token must not leak into the URL");
  });
});

test("resumes a saved session when the gateway still lists it", async (t) => {
  const options = { conversations: [{ sessionId: "sess_keep", title: "kept" }] };
  await withGateway(t, options, async (gw, make) => {
    const stateFile = await tmpState();
    await writeFile(stateFile, JSON.stringify({ sessionId: "sess_keep" }));
    const conn = make({ stateFile });
    const readyEvent = eventOnce(conn, "ready");
    await conn.start();
    await readyEvent;
    assert.deepEqual(gw.starts[0].conversation, { mode: "resume", sessionId: "sess_keep" });
  });
});

test("starts a new session when the saved id is no longer listed", async (t) => {
  await withGateway(t, { conversations: [] }, async (gw, make) => {
    const stateFile = await tmpState();
    await writeFile(stateFile, JSON.stringify({ sessionId: "sess_gone" }));
    const conn = make({ stateFile });
    const readyEvent = eventOnce(conn, "ready");
    await conn.start();
    await readyEvent;
    assert.equal(gw.starts.length, 1);
    assert.equal(gw.starts[0].conversation.mode, "new");
  });
});

test("falls back to a new session exactly once when a resume is rejected", async (t) => {
  const options = {
    conversations: [{ sessionId: "sess_zombie" }],
    behavior: { failResumeOnce: true },
  };
  await withGateway(t, options, async (gw, make) => {
    const stateFile = await tmpState();
    await writeFile(stateFile, JSON.stringify({ sessionId: "sess_zombie" }));
    const conn = make({ stateFile });
    const readyEvent = eventOnce(conn, "ready");
    await conn.start();
    await readyEvent;
    assert.equal(gw.starts.length, 2);
    assert.equal(gw.starts[0].conversation.mode, "resume");
    assert.equal(gw.starts[1].conversation.mode, "new");
    // fallback replaced the stale id with the newly created session
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    assert.notEqual(saved.sessionId, "sess_zombie");
  });
});

test("backs off and retries on recoverable start failures", async (t) => {
  await withGateway(t, { behavior: { failStartTimes: 2 } }, async (gw, make) => {
    const conn = make();
    const states = [];
    conn.on("state", ({ state }) => states.push(state));
    const readyEvent = eventOnce(conn, "ready");
    await conn.start();
    await readyEvent;
    assert.equal(gw.starts.length, 3);
    assert.ok(states.includes("backoff"), `expected a backoff state, saw: ${states.join(",")}`);
    assert.equal(conn.state, "ready");
  });
});

test("honors Retry-After as a floor on the reconnect delay", async (t) => {
  const options = { behavior: { capacity503Times: 1, retryAfterSeconds: 1 } };
  await withGateway(t, options, async (gw, make) => {
    const conn = make();
    const startedAt = Date.now();
    const readyEvent = eventOnce(conn, "ready", 10_000);
    await conn.start();
    await readyEvent;
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 950, `reconnected after ${elapsed}ms; expected >= ~1000ms`);
    assert.equal(gw.upgradeUrls.length, 2);
    assert.equal(gw.starts.length, 1);
  });
});

test("halts permanently on a nonrecoverable session.error", async (t) => {
  await withGateway(t, { behavior: { fatalStart: true } }, async (gw, make) => {
    const conn = make();
    const haltedEvent = eventOnce(conn, "halted");
    await conn.start();
    const halted = await haltedEvent;
    assert.equal(conn.state, "halted");
    assert.match(halted.reason, /forbidden/);
    const startsSeen = gw.starts.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(gw.starts.length, startsSeen, "halted connection must not retry");
  });
});

test("halts when the gateway closes an established session with 1008", async (t) => {
  await withGateway(t, {}, async (gw, make) => {
    const conn = make();
    const readyEvent = eventOnce(conn, "ready");
    await conn.start();
    await readyEvent;
    const haltedEvent = eventOnce(conn, "halted");
    gw.kick(1008, "too many invalid messages");
    await haltedEvent;
    assert.equal(conn.state, "halted");
  });
});

test("reconnects after a non-fatal post-ready drop", async (t) => {
  await withGateway(t, {}, async (gw, make) => {
    const conn = make();
    const readyEvent = eventOnce(conn, "ready");
    await conn.start();
    await readyEvent;
    const reconnected = eventOnce(conn, "ready", 5000);
    gw.kick(1012, "service restart");
    await reconnected;
    assert.equal(gw.starts.length, 2);
    assert.equal(conn.state, "ready");
  });
});

test("terminates and reconnects when pings go unanswered", async (t) => {
  await withGateway(t, {}, async (gw, make) => {
    const conn = make({ pingIntervalMs: 50, pongTimeoutMs: 100 });
    const readyEvent = eventOnce(conn, "ready");
    await conn.start();
    await readyEvent;
    const timedOut = eventOnce(conn, "ping-timeout", 5000);
    const reconnected = eventOnce(conn, "ready", 5000);
    gw.pauseAll();
    await timedOut;
    await reconnected;
    assert.equal(gw.starts.length, 2);
    assert.equal(conn.state, "ready");
  });
});

test("a pinned session resumes even when the gateway listing omits it", async (t) => {
  // Empty listing: the unpinned path would downgrade to mode:"new" (see the
  // "no longer listed" test above). A pin must skip that pre-validation.
  await withGateway(t, { conversations: [] }, async (gw, make) => {
    const stateFile = await tmpState();
    await writeFile(stateFile, JSON.stringify({ sessionId: "sess_thread" }));
    const conn = make({ stateFile, pinnedSessionId: "sess_thread" });
    const readyEvent = eventOnce(conn, "ready");
    await conn.start();
    await readyEvent;
    assert.deepEqual(gw.starts[0].conversation, { mode: "resume", sessionId: "sess_thread" });
  });
});

test("rebind() swaps the live session onto a pinned target", async (t) => {
  await withGateway(t, { conversations: [] }, async (gw, make) => {
    const stateFile = await tmpState();
    const conn = make({ stateFile });
    const first = eventOnce(conn, "ready");
    await conn.start();
    await first;
    assert.equal(gw.starts[0].conversation.mode, "new");
    const second = eventOnce(conn, "ready");
    await conn.rebind("sess_focused", { pinned: true });
    await second;
    assert.deepEqual(gw.starts[1].conversation, { mode: "resume", sessionId: "sess_focused" });
    assert.equal(conn.pinnedSessionId, "sess_focused");
  });
});

test("rebind(null) unpins and forces a fresh conversation", async (t) => {
  await withGateway(t, { conversations: [] }, async (gw, make) => {
    const stateFile = await tmpState();
    await writeFile(stateFile, JSON.stringify({ sessionId: "sess_prev" }));
    const conn = make({ stateFile, pinnedSessionId: "sess_prev" });
    const first = eventOnce(conn, "ready");
    await conn.start();
    await first;
    const second = eventOnce(conn, "ready");
    await conn.rebind(null);
    await second;
    assert.equal(gw.starts[1].conversation.mode, "new");
    assert.equal(conn.pinnedSessionId, null);
  });
});

test("rebind() while stopped persists the target for the next start()", async (t) => {
  await withGateway(t, { conversations: [] }, async (gw, make) => {
    const stateFile = await tmpState();
    const conn = make({ stateFile });
    await conn.rebind("sess_later", { pinned: true });
    assert.equal(gw.starts.length, 0, "must not connect while stopped");
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(saved.sessionId, "sess_later");
    const readyEvent = eventOnce(conn, "ready");
    await conn.start();
    await readyEvent;
    assert.deepEqual(gw.starts[0].conversation, { mode: "resume", sessionId: "sess_later" });
  });
});

test("a rejected pinned resume emits resume-fallback and clears the pin", async (t) => {
  const options = { conversations: [], behavior: { failResumeOnce: true } };
  await withGateway(t, options, async (gw, make) => {
    const stateFile = await tmpState();
    await writeFile(stateFile, JSON.stringify({ sessionId: "sess_dead" }));
    const conn = make({ stateFile, pinnedSessionId: "sess_dead" });
    const fallbackEvent = eventOnce(conn, "resume-fallback");
    const readyEvent = eventOnce(conn, "ready");
    await conn.start();
    const fallback = await fallbackEvent;
    await readyEvent;
    assert.equal(fallback.sessionId, "sess_dead");
    assert.equal(conn.pinnedSessionId, null);
    assert.equal(gw.starts[0].conversation.mode, "resume");
    assert.equal(gw.starts[1].conversation.mode, "new");
  });
});

test("stop() detaches cleanly and keeps the sessionId for later resume", async (t) => {
  await withGateway(t, {}, async (gw, make) => {
    const stateFile = await tmpState();
    const conn = make({ stateFile });
    const readyEvent = eventOnce(conn, "ready");
    await conn.start();
    const ready = await readyEvent;
    await conn.stop();
    assert.equal(conn.state, "idle");
    const close = gw.messages.find((m) => m.type === "session.close");
    assert.ok(close, "gateway should have received session.close");
    assert.equal(close.detach, true);
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(saved.sessionId, ready.conversation.sessionId);
  });
});
