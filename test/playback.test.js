import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAudioPlayer, NoSubscriberBehavior, AudioPlayerStatus } from "@discordjs/voice";
import { Bridge } from "../src/bridge.js";
import { Playback } from "../src/playback.js";

const tick = () => new Promise((r) => setImmediate(r));
async function until(fn) {
  const end = Date.now() + 3000;
  while (!fn()) { if (Date.now() > end) throw new Error("Timed out waiting for playback"); await new Promise((r) => setTimeout(r, 5)); }
}
function setup(t, noSubscriber = NoSubscriberBehavior.Pause) {
  const conn = new EventEmitter();
  const cancellations = [];
  conn.cancelResponse = (reason, truncate) => cancellations.push({ reason, truncate });
  const bridge = new Bridge({ conn });
  const player = createAudioPlayer({ behaviors: { noSubscriber } });
  const playback = new Playback({ bridge, player });
  t.after(() => playback.dispose());
  const ready = () => conn.emit("ready", { realtime: { audio: {
    input: { enabled: true, mimeType: "audio/pcm;rate=24000" }, output: { enabled: true },
  } } });
  ready();
  const start = (id = "r1") => conn.emit("response.started", { responseId: id });
  const audio = (ms, itemId = "item", contentIndex = 0) => conn.emit("audio.output", {
    data: Buffer.alloc(Math.round(ms * 48)).toString("base64"), mimeType: "audio/pcm;rate=24000", itemId, contentIndex,
  });
  const complete = (id = "r1") => conn.emit("response.completed", { responseId: id });
  return { conn, bridge, player, playback, ready, start, audio, complete, cancellations };
}

test("real player drains all five packets of a short completed response", async (t) => {
  const { bridge, player, start, audio, complete } = setup(t, NoSubscriberBehavior.Play);
  const consumed = []; const mark = bridge.markConsumed.bind(bridge);
  bridge.markConsumed = (packet) => { if (packet.item) consumed.push(packet); mark(packet); };
  start(); audio(100); complete();
  await until(() => consumed.length === 5 && player.state.status === AudioPlayerStatus.Idle);
  assert.equal(consumed.reduce((n, p) => n + p.sourceMs, 0), 100);
  assert.equal(bridge.accountingSize, 0);
});
test("prefetch does not credit playback; interruption before first consumption truncates at zero", async (t) => {
  const { start, audio, playback, bridge, cancellations } = setup(t);
  start(); audio(1000); await tick();
  assert.ok(playback.resource.playStream.readableLength > 0);
  assert.equal(playback.resource.playbackDuration, 0);
  bridge.bargeIn();
  assert.deepEqual(cancellations[0].truncate, { itemId: "item", contentIndex: 0, audioEndMs: 0 });
});
test("completed but buffered speech remains interruptible", async (t) => {
  const { start, audio, complete, playback, bridge, cancellations, player } = setup(t);
  start(); audio(20); complete(); await tick();
  assert.equal(bridge.playerShouldRun, false);
  assert.equal(playback.pending, true);
  assert.equal(bridge.bargeIn(), true);
  assert.equal(cancellations[0].truncate.audioEndMs, 0);
  assert.equal(player.state.status, AudioPlayerStatus.Idle);
});
test("consumption excludes silence and partial-frame padding and uses content index", async (t) => {
  const { bridge, start, audio, complete, playback, cancellations } = setup(t);
  // Drive the resource's real read method, with no subscriber to advance it.
  start(); await tick();
  playback.resource.read(); await tick(); playback.sync(); // startup underflow silence
  audio(25, "partial", 2); complete(); await tick();
  for (let i = 0; i < 2; i++) { playback.resource.read(); await tick(); playback.sync(); }
  // Depending on prefetch a silence frame can precede source packets. Drain
  // until exactly the first source packet has been consumed.
  while (!playback.descriptors.some((p) => p.item?.consumed >= 20)) {
    playback.resource.read(); await tick(); playback.sync();
  }
  bridge.bargeIn();
  assert.deepEqual(cancellations[0].truncate, { itemId: "partial", contentIndex: 2, audioEndMs: 20 });
});
test("new session cannot truncate an old item; late cancelled output is dropped", async (t) => {
  const { start, audio, bridge, ready, conn, cancellations } = setup(t);
  start(); audio(100); bridge.bargeIn();
  audio(100); assert.equal(bridge.playerShouldRun, false);
  ready(); start("new"); bridge.bargeIn();
  assert.equal(cancellations.at(-1).truncate, undefined);
  start("current"); audio(100, "current-item");
  conn.emit("response.cancelled", { responseId: "old" });
  assert.equal(bridge.responseActive, true);
});
test("audio arriving while the prior resource ends starts another resource", async (t) => {
  const { bridge, start, audio, complete, player, playback } = setup(t, NoSubscriberBehavior.Play);
  const seen = []; const mark = bridge.markConsumed.bind(bridge);
  bridge.markConsumed = (packet) => { if (packet.item) seen.push(packet.item.itemId); mark(packet); };
  start(); audio(20, "first"); complete();
  await until(() => playback.resource?.playStream.readableEnded);
  start("second"); audio(40, "second"); complete("second");
  await until(() => player.state.status === AudioPlayerStatus.Idle && seen.length === 3);
  assert.deepEqual(seen, ["first", "second", "second"]);
});
test("many responses prune accounting, reset aborts input and playback", async (t) => {
  const { bridge, start, audio, complete, conn } = setup(t);
  for (let n = 0; n < 300; n++) {
    start(`r${n}`); audio(25, `i${n}`); complete(`r${n}`);
    for (let packet; (packet = bridge.nextPacket());) bridge.markConsumed(packet);
    assert.equal(bridge.accountingSize, 0);
  }
  const sink = bridge.beginUtterance();
  conn.emit("disconnected", {});
  sink.end();
  assert.equal(bridge.inputEnabled, false); assert.equal(bridge.beginUtterance(), null);
});

test("player failure cancels response without permanently disabling microphone", async (t) => {
  const { start, audio, player, bridge } = setup(t);
  start(); audio(100); player.emit("error", new Error("decoder failure"));
  assert.equal(bridge.responseActive, false); assert.equal(bridge.inputEnabled, true);
  assert.ok(bridge.beginUtterance());
});


test('playback state remains active after provider completion until Discord drains', async t => {
  const { conn, player, start, audio, complete, bridge } = setup(t, NoSubscriberBehavior.Play);
  const states = []; conn.reportPlayback = (active, microphoneActive) => states.push({ active, microphoneActive });
  start(); audio(120); complete();
  assert.equal(bridge.responseActive, false);
  assert.equal(states.at(-1).active, true);
  await until(() => player.state.status === AudioPlayerStatus.Idle);
  await tick();
  assert.equal(states.at(-1).active, false);
  const sink = bridge.beginUtterance();
  assert.equal(states.at(-1).microphoneActive, true);
  sink.abort(); assert.equal(states.at(-1).microphoneActive, false);
});
