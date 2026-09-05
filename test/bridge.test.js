import test from "node:test";
import assert from "node:assert/strict";
import mediaplex from "mediaplex";
import { FakeGateway } from "./fake-gateway.js";
import { HlvConnection } from "../src/hlv-conn.js";
import { Bridge, SILENCE_FRAME } from "../src/bridge.js";

const { OpusEncoder } = mediaplex;

function waitFor(fn, what, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = fn();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

// 20 ms Discord-style opus packets from a 48 kHz stereo tone
function opusPackets(ms, freq = 440) {
  const enc = new OpusEncoder(48000, 2);
  const packets = [];
  for (let p = 0; p < ms / 20; p++) {
    const pcm = Buffer.alloc(960 * 4);
    for (let i = 0; i < 960; i++) {
      const t = p * 960 + i;
      const v = Math.round(8000 * Math.sin((2 * Math.PI * freq * t) / 48000));
      pcm.writeInt16LE(v, i * 4);
      pcm.writeInt16LE(v, i * 4 + 2);
    }
    packets.push(enc.encode(pcm));
  }
  return packets;
}

// base64 24 kHz mono PCM of the given duration
function pcm24k(ms, freq = 440) {
  const samples = Math.round((ms / 1000) * 24000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * freq * i) / 24000)), i * 2);
  }
  return buf.toString("base64");
}

function inputMs(gw) {
  return gw.messages
    .filter((m) => m.type === "audio.input")
    .reduce((ms, m) => ms + (Buffer.from(m.data, "base64").length / 2 / 24000) * 1000, 0);
}

async function setup(t, options = {}) {
  const gw = new FakeGateway(options);
  await gw.listen();
  const conn = new HlvConnection({ url: gw.url, backoffBaseMs: 25, jitterMs: 5 });
  const bridge = new Bridge({ conn, ...options.bridge });
  t.after(async () => {
    await conn.stop();
    await gw.close();
  });
  const ready = new Promise((resolve) => conn.once("ready", resolve));
  await conn.start();
  await ready;
  return { gw, conn, bridge };
}

test("utterance: 24 kHz frames, end-pad flush, audio.end, >=100ms committed", async (t) => {
  const { gw, bridge } = await setup(t);
  const sink = bridge.beginUtterance();
  assert.ok(sink, "utterance sink should be available");
  for (const pkt of opusPackets(100)) sink.write(pkt);
  sink.end();
  await waitFor(() => gw.messages.some((m) => m.type === "audio.end"), "audio.end");
  const frames = gw.messages.filter((m) => m.type === "audio.input");
  assert.ok(frames.length > 0);
  for (const f of frames) assert.equal(f.mimeType, "audio/pcm;rate=24000");
  const total = inputMs(gw);
  // ~100 ms of speech + 240 ms zero pad; decimator history holds < 1 ms
  assert.ok(total >= 100, `committed only ${total.toFixed(1)}ms`);
  assert.ok(Math.abs(total - 340) < 10, `expected ~340ms, saw ${total.toFixed(1)}ms`);
});

test("a second concurrent utterance is refused", async (t) => {
  const { bridge } = await setup(t);
  const first = bridge.beginUtterance();
  assert.ok(first);
  assert.equal(bridge.beginUtterance(), null);
  first.abort();
  assert.ok(bridge.beginUtterance(), "sink available again after abort");
});

test("canned reply: audio.output becomes valid 20ms opus packets and player-run fires", async (t) => {
  const { gw, conn, bridge } = await setup(t);
  let ran = false;
  bridge.on("player-run", () => {
    ran = true;
  });
  gw.broadcast({ type: "response.started", responseId: "resp_1" });
  gw.broadcast({
    type: "audio.output",
    data: pcm24k(500),
    mimeType: "audio/pcm;rate=24000",
    itemId: "item_1",
    contentIndex: 0,
  });
  await waitFor(() => bridge.responseActive, "response start");
  gw.broadcast({ type: "response.completed", responseId: "resp_1" });
  await waitFor(() => !bridge.responseActive, "response completion");
  const packets = [];
  for (let p = bridge.nextPacket(); p !== null; p = bridge.nextPacket()) packets.push(p);
  assert.equal(packets.length, 25, "500ms should yield 25 packets");
  assert.ok(ran, "player-run should have fired");
  const dec = new OpusEncoder(48000, 2);
  for (const p of packets) assert.equal(dec.decode(p).length, 960 * 2 * 2);
  void conn;
});

test("barge-in mid-playback truncates at the played position", async (t) => {
  const { gw, bridge } = await setup(t);
  gw.broadcast({ type: "response.started", responseId: "resp_1" });
  gw.broadcast({
    type: "audio.output",
    data: pcm24k(1000),
    mimeType: "audio/pcm;rate=24000",
    itemId: "item_A",
    contentIndex: 0,
  });
  await waitFor(() => bridge.responseActive, "response start");
  await waitFor(() => bridge.nextPacket() !== null, "first packet");
  for (let i = 0; i < 6; i++) bridge.nextPacket(); // 7 packets played = 140ms
  bridge.onSpeakingStart();
  const cancel = await waitFor(
    () => gw.messages.find((m) => m.type === "response.cancel"),
    "response.cancel",
  );
  assert.equal(cancel.reason, "user_barge_in");
  assert.deepEqual(cancel.truncate, { itemId: "item_A", contentIndex: 0, audioEndMs: 140 });
  assert.equal(bridge.playerShouldRun, false, "queue must be flushed synchronously");
});

test("audioEndMs is clamped: silence-fill frames never advance the ledger", async (t) => {
  const { gw, bridge } = await setup(t);
  gw.broadcast({ type: "response.started", responseId: "resp_1" });
  gw.broadcast({
    type: "audio.output",
    data: pcm24k(100),
    mimeType: "audio/pcm;rate=24000",
    itemId: "item_B",
    contentIndex: 0,
  });
  await waitFor(() => bridge.responseActive, "response start");
  await waitFor(() => bridge.nextPacket() !== null, "first packet");
  for (let i = 0; i < 4; i++) bridge.nextPacket(); // the remaining 4 real packets
  // response still active, queue dry -> silence fill keeps the player fed
  for (let i = 0; i < 5; i++) assert.equal(bridge.nextPacket(), SILENCE_FRAME);
  bridge.bargeIn();
  const cancel = await waitFor(
    () => gw.messages.find((m) => m.type === "response.cancel"),
    "response.cancel",
  );
  assert.equal(cancel.truncate.audioEndMs, 100, "clamped to received duration");
});

test("response.failed flushes the queue and surfaces an error text", async (t) => {
  const { gw, bridge } = await setup(t);
  const texts = [];
  bridge.on("text", (e) => texts.push(e));
  gw.broadcast({ type: "response.started", responseId: "resp_1" });
  gw.broadcast({
    type: "audio.output",
    data: pcm24k(500),
    mimeType: "audio/pcm;rate=24000",
    itemId: "item_C",
    contentIndex: 0,
  });
  await waitFor(() => bridge.playerShouldRun, "queued audio");
  gw.broadcast({ type: "response.failed", responseId: "resp_1", error: "provider exploded" });
  await waitFor(() => !bridge.playerShouldRun, "flush");
  assert.equal(bridge.nextPacket(), null);
  assert.ok(texts.some((e) => e.kind === "error" && e.text.includes("provider exploded")));
});

test("input is refused when the gateway disables audio", async (t) => {
  const { bridge } = await setup(t, { behavior: { audioEnabled: false } });
  assert.equal(bridge.inputEnabled, false);
  assert.equal(bridge.beginUtterance(), null);
});

test("input.pause_requested aborts the utterance without audio.end; /join clears it", async (t) => {
  const { gw, bridge } = await setup(t);
  const sink = bridge.beginUtterance();
  for (const pkt of opusPackets(40)) sink.write(pkt);
  gw.broadcast({ type: "input.pause_requested", reason: "voice_command" });
  await waitFor(() => bridge.micPaused, "mic pause");
  sink.end(); // stale sink: must be a no-op
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!gw.messages.some((m) => m.type === "audio.end"), "no audio.end after pause");
  assert.equal(bridge.beginUtterance(), null);
  bridge.clearMicPause();
  assert.ok(bridge.beginUtterance(), "input available again after clearing pause");
});

test("tiny utterances still commit >=100ms thanks to the end pad", async (t) => {
  const { gw, bridge } = await setup(t);
  const sink = bridge.beginUtterance();
  for (const pkt of opusPackets(20)) sink.write(pkt);
  sink.end();
  await waitFor(() => gw.messages.some((m) => m.type === "audio.end"), "audio.end");
  const total = inputMs(gw);
  assert.ok(total >= 100, `committed only ${total.toFixed(1)}ms — OpenAI would tear the session down`);
});

test("task notifications and final transcripts mirror as text", async (t) => {
  const { gw, bridge } = await setup(t);
  const texts = [];
  bridge.on("text", (e) => texts.push(e));
  // the SDK drops connections that reference tasks it has never seen,
  // so announce the task before notifying about it
  gw.broadcast({
    type: "task.accepted",
    taskId: "task_1",
    sequence: 1,
    occurredAt: 1,
    state: "accepted",
    title: "Backup",
  });
  gw.broadcast({
    type: "task.notification",
    taskId: "task_1",
    sequence: 2,
    occurredAt: 2,
    notification: {
      notificationId: "note_1",
      kind: "completed",
      delivery: "interrupt",
      message: "Backup finished cleanly.",
      createdAt: 1,
      acknowledged: false,
    },
  });
  gw.broadcast({ type: "transcript.delta", speaker: "assistant", text: "partial", final: false });
  gw.broadcast({ type: "transcript.delta", speaker: "assistant", text: "Hello there.", final: true });
  await waitFor(() => texts.length >= 2, "mirrored texts");
  assert.ok(texts.some((e) => e.kind === "notification" && e.text === "Backup finished cleanly."));
  assert.ok(texts.some((e) => e.kind === "transcript" && e.text === "Hello there."));
  assert.ok(!texts.some((e) => e.text === "partial"), "non-final transcript deltas are not mirrored");
});
