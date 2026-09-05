import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import mediaplex from "mediaplex";
import { Bridge, SILENCE_FRAME } from "../src/bridge.js";
import { SpeechGate } from "../src/speech-gate.js";

function setup(options = {}) {
  const conn = new EventEmitter();
  const messages = [], logs = [];
  conn.sendAudio = (data) => { messages.push({ type: "audio", data }); return 1; };
  conn.endAudio = () => messages.push({ type: "end" });
  conn.cancelResponse = (reason, truncate) => messages.push({ type: "cancel", reason, truncate });
  let now = 0;
  const bridge = new Bridge({ conn, clock: () => now, log: (line) => logs.push(JSON.parse(line.slice(6))), ...options });
  conn.emit("ready", { realtime: { audio: { input: { enabled: true, mimeType: "audio/pcm;rate=24000" }, output: { enabled: true } } } });
  const start = () => {
    conn.emit("response.started", { responseId: "response-A" });
    conn.emit("audio.output", { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(4800).toString("base64"), itemId: "item-A" });
  };
  return { bridge, conn, messages, logs, start, advance: (ms) => { now += ms; } };
}

function tone() {
  const encoder = new mediaplex.OpusEncoder(48000, 2);
  return Array.from({ length: 10 }, (_, p) => {
    const pcm = Buffer.alloc(3840);
    for (let i = 0; i < 960; i++) {
      const v = Math.round(8000 * Math.sin(2 * Math.PI * 440 * (p * 960 + i) / 48000));
      pcm.writeInt16LE(v, i * 4); pcm.writeInt16LE(v, i * 4 + 2);
    }
    return encoder.encode(pcm);
  });
}

test("speaking events and silence cannot cancel or create an upstream turn", () => {
  const { bridge, messages, logs, start } = setup();
  start();
  bridge.onSpeakingStart();
  const sink = bridge.beginUtterance();
  for (let i = 0; i < 40; i++) { bridge.onSpeakingStart(); sink.write(SILENCE_FRAME); }
  sink.end(); sink.end();
  assert.deepEqual(messages, []);
  assert.equal(bridge.responseActive, true);
  assert.equal(logs.at(-1).reason, "no_speech");
  assert.equal(logs.at(-1).voicedMs, 0);
});

test("confirmed speech cancels once before sending preserved input; commits once", () => {
  const { bridge, messages, logs, start, advance } = setup({ gateFactory: () => new SpeechGate({ detect: () => true }) });
  start();
  bridge.markConsumed(bridge.nextPacket());
  const sink = bridge.beginUtterance();
  const packets = tone();
  for (const packet of packets.slice(0, 4)) { advance(20); sink.write(packet); }
  assert.deepEqual(messages, []);
  for (const packet of packets.slice(4)) { advance(20); sink.write(packet); }
  sink.end(); sink.end(); sink.write(packets[0]);
  assert.equal(messages[0].type, "cancel");
  assert.equal(messages[0].truncate.audioEndMs, 20);
  assert.equal(messages.filter((m) => m.type === "cancel").length, 1);
  assert.equal(messages.filter((m) => m.type === "end").length, 1);
  const samples = messages.filter((m) => m.type === "audio").reduce((n, m) => n + Buffer.from(m.data, "base64").length / 2, 0);
  assert.equal(samples, 24000 * .440); // full 200ms onset + 240ms end padding
  assert.equal(logs.find((e) => e.event === "interruption").voicedMs, 100);
  assert.equal(logs.at(-1).maxGapMs, 20);
});

test("reset and detector failure invalidate sinks without a late commit", () => {
  for (const fails of [false, true]) {
    const { bridge, messages, logs } = setup({ gateFactory: () => new SpeechGate({ detect: () => { if (fails) throw Error("private payload"); return true; } }) });
    let errors = 0;
    bridge.on("input-error", () => errors++);
    const sink = bridge.beginUtterance();
    sink.write(tone()[0]);
    bridge.reset(); sink.end(); sink.write(tone()[0]);
    assert.equal(messages.length, 0);
    assert.equal(errors, Number(fails));
    assert.ok(!JSON.stringify(logs).includes("private payload"));
  }
});

test("response diagnostics distinguish underruns, consumed silence and new responses", () => {
  const { bridge, conn, logs, start } = setup();
  start();
  for (let i = 0; i < 5; i++) bridge.markConsumed(bridge.nextPacket());
  for (let i = 0; i < 3; i++) bridge.markConsumed(bridge.nextPacket());
  conn.emit("response.completed", { responseId: "response-A" });
  const summary = logs.find((e) => e.event === "response_summary");
  assert.equal(summary.receivedMs, 100);
  assert.equal(summary.consumedMs, 100);
  assert.equal(summary.insertedSilenceMs, 60);
  assert.equal(summary.underflows, 1);
  assert.equal(summary.maxQueueMs, 100);
  assert.equal(summary.reason, "drained");
  conn.emit("response.started", { responseId: "response-B" });
  conn.emit("response.failed", { responseId: "response-B" });
  assert.equal(logs.at(-1).responseId, "response-B");
  assert.equal(logs.at(-1).reason, "provider_failed");
});
