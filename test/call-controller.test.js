import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createAudioPlayer } from "@discordjs/voice";
import { FakeGateway } from "./fake-gateway.js";
import { HlvConnection } from "../src/hlv-conn.js";
import { Bridge } from "../src/bridge.js";
import { Playback } from "../src/playback.js";
import { SessionStore } from "../src/session-store.js";
import { CallController } from "../src/call-controller.js";

const tick = () => new Promise((r) => setImmediate(r));
async function until(fn) {
  const end = Date.now() + 3000;
  while (!fn()) { if (Date.now() > end) throw new Error("Timed out waiting for call"); await new Promise((r) => setTimeout(r, 5)); }
}
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "voice-call-"));
  const store = new SessionStore(join(dir, "state.json")); await store.load();
  await store.save({ version: 2, defaultSessionId: "default", focus: null });
  const gw = new FakeGateway(); await gw.listen();
  const conn = new HlvConnection({ url: gw.url, backoffBaseMs: 10, jitterMs: 0 });
  const bridge = new Bridge({ conn }); const playback = new Playback({ bridge, player: createAudioPlayer() });
  const notices = []; const voices = []; let aborts = 0;
  const status = { resolve: async (threadId) => ({ sessionId: `session-${threadId}`, threadId, title: threadId }), close: async () => {} };
  const controller = new CallController({ conn, bridge, playback, store, status,
    notice: (text) => notices.push(text), retryBaseMs: 10, retryMaxMs: 30,
    attachVoice: async (channel, _signal, lost) => {
      const voice = new EventEmitter(); voice.channel = channel; voice.state = { status: "ready" };
      voice.destroy = () => { voice.state = { status: "destroyed" }; }; voice.lose = () => lost(voice);
      voices.push(voice); return { voice, cleanup: () => { aborts++; } };
    },
  });
  t.after(async () => { await controller.close(); await gw.close(); await rm(dir, { recursive: true, force: true }); });
  return { controller, conn, bridge, store, gw, status, notices, voices, aborts: () => aborts };
}
test("join waits for HLV; move and leave destroy old resources and detach", async (t) => {
  const { controller, conn, voices, aborts } = await setup(t);
  await controller.join({ id: "a" }); assert.equal(controller.ready, true);
  await controller.join({ id: "b" }); assert.equal(voices[0].state.status, "destroyed");
  assert.equal(controller.voice.channel.id, "b");
  await controller.leave(); assert.equal(controller.voice, null); assert.equal(conn.desired, false);
  assert.ok(aborts() > 0);
});
test("rapid join/leave/join preserves the latest intent", async (t) => {
  const { controller } = await setup(t);
  const results = await Promise.allSettled([controller.join({ id: "old" }), controller.leave(), controller.join({ id: "latest" })]);
  assert.equal(results.at(-1).status, "fulfilled");
  assert.equal(controller.voice.channel.id, "latest"); assert.equal(controller.ready, true);
});
test("loss reconnects to desired channel; leaving cancels scheduled recovery", async (t) => {
  const { controller, voices } = await setup(t);
  await controller.join({ id: "a" }); voices[0].lose();
  await until(() => voices.length === 2 && controller.ready);
  voices[1].lose(); await controller.leave();
  await new Promise((r) => setTimeout(r, 60)); assert.equal(voices.length, 2); assert.equal(controller.voice, null);
});
test("focus commits after readiness; A to B keeps true default and unfocus resumes it", async (t) => {
  const { controller, store, gw } = await setup(t); await controller.join({ id: "voice" });
  await controller.focus("a"); assert.equal(controller.focusState.sessionId, "session-a");
  await controller.focus("b"); assert.equal(store.value.defaultSessionId, "default");
  await controller.unfocus(); assert.equal(controller.focusState, null);
  assert.equal(gw.starts.at(-1).conversation.sessionId, "default");
});
test("failed focus restores old target without creating a new conversation", async (t) => {
  const { controller, store, gw, conn, notices } = await setup(t); await controller.join({ id: "voice" });
  gw.behavior.failResumeOnce = true;
  await assert.rejects(controller.focus("a"));
  await until(() => conn.connected);
  assert.equal(store.value.focus, null); assert.equal(conn.sessionId, "default");
  assert.ok(gw.starts.every((m) => m.conversation.mode === "resume")); assert.equal(notices.length, 1);
});
test("failed resolution also reconnects the previous call", async (t) => {
  const { controller, conn, status } = await setup(t); await controller.join({ id: "voice" });
  status.resolve = async () => null;
  await assert.rejects(controller.focus("unknown"), /No Hermes session/);
  await until(() => conn.connected); assert.equal(conn.sessionId, "default");
});
test("focus on a stopped call persists without connecting; reconnect resolves current routing tip", async (t) => {
  const { controller, gw, status, conn } = await setup(t);
  await controller.focus("thread"); assert.equal(gw.starts.length, 0);
  status.resolve = async () => ({ sessionId: "tip-2" });
  await controller.join({ id: "voice" }); assert.equal(conn.sessionId, "tip-2");
  status.resolve = async () => ({ sessionId: "tip-3" }); gw.kick(1012, "restart");
  await until(() => conn.connected && conn.sessionId === "tip-3");
  assert.equal(controller.focusState.sessionId, "tip-3");
});
test("unavailable routing retains the last known focused session", async (t) => {
  const { controller, status, conn } = await setup(t); await controller.focus("thread");
  status.resolve = async () => null; await controller.join({ id: "voice" });
  assert.equal(conn.sessionId, "session-thread");
});
test("explicit new conversation clears focus while preserving background tasks", async (t) => {
  const { controller, gw, store } = await setup(t); await controller.focus("a"); await controller.join({ id: "voice" });
  await controller.newConversation(); assert.equal(store.value.focus, null);
  assert.notEqual(store.value.defaultSessionId, "default");
  assert.equal(gw.starts.at(-1).conversation.mode, "new");
  assert.ok(!gw.messages.some((m) => m.type === "task.stop"));
});
test("superseded focus cannot commit after leave", async (t) => {
  const { controller, status, store, conn } = await setup(t); await controller.join({ id: "voice" });
  let release; let entered;
  const waiting = new Promise((r) => { entered = r; });
  status.resolve = async () => { entered(); return new Promise((r) => { release = r; }); };
  const focus = controller.focus("stale"); const rejection = assert.rejects(focus);
  await waiting;
  const leave = controller.leave(); release({ sessionId: "stale" });
  await rejection; await leave; await tick();
  assert.equal(store.value.focus, null); assert.equal(conn.desired, false);
});

test("temporary Discord disconnect tears down audio and reconnects HLV after voice is ready", async (t) => {
  const { controller, conn, bridge, voices } = await setup(t); await controller.join({ id: "voice" });
  const voice = controller.voice; voice.state = { status: "disconnected" };
  let release;
  const pending = controller.recoverVoice(voice, async () => new Promise((r) => { release = r; }));
  await until(() => release);
  assert.equal(conn.desired, false); assert.equal(bridge.inputEnabled, false);
  voice.state = { status: "ready" }; release(); await pending;
  assert.equal(controller.ready, true); assert.equal(voices.length, 1);
});
test("leave aborts temporary recovery and never restarts its old gateway", async (t) => {
  const { controller, conn } = await setup(t); await controller.join({ id: "voice" });
  const voice = controller.voice; voice.state = { status: "disconnected" };
  let entered;
  const waiting = new Promise((r) => { entered = r; });
  const recovery = controller.recoverVoice(voice, (signal) => new Promise((_resolve, reject) => {
    entered(); signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const rejected = assert.rejects(recovery); await waiting; await controller.leave(); await rejected;
  assert.equal(conn.desired, false); assert.equal(controller.voice, null);
});
test("persistence failure rolls focus back before any new-session events are forwarded", async (t) => {
  const { controller, conn, store, gw } = await setup(t); await controller.join({ id: "voice" });
  const save = store.save.bind(store); let fail = true;
  store.save = async (next, options) => {
    if (next.focus && fail) { fail = false; throw new Error("disk unavailable"); }
    return save(next, options);
  };
  const emitted = []; conn.on("ready", (ready) => emitted.push(ready.conversation.sessionId));
  await assert.rejects(controller.focus("a")); await until(() => conn.connected);
  assert.equal(store.value.focus, null); assert.ok(!emitted.includes("session-a"));
  assert.equal(gw.starts.at(-1).conversation.sessionId, "default");
});
