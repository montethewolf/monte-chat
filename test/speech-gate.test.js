import test from "node:test";
import assert from "node:assert/strict";
import { SpeechGate, createSpeechDetector } from "../src/speech-gate.js";

const frame = (value) => new Int16Array(960).fill(value);
const detector = (pcm) => pcm[0] > 0;

test("gate preserves bounded pre-roll and confirms exactly once after 100ms", () => {
  const gate = new SpeechGate({ detect: detector });
  for (let i = 0; i < 100; i++) assert.deepEqual(gate.push(frame(-i)).frames, []);
  for (let i = 1; i < 5; i++) assert.equal(gate.push(frame(i)).started, false);
  const result = gate.push(frame(5));
  assert.equal(result.started, true);
  assert.equal(result.frames.length, 10);
  assert.deepEqual(result.frames.slice(-5).map((p) => p[0]), [1, 2, 3, 4, 5]);
  assert.equal(gate.push(frame(6)).started, false);
  assert.equal(gate.voicedMs, 120);
});

test("isolated blips and packet gaps cannot accumulate into confirmed speech", () => {
  const gate = new SpeechGate({ detect: detector });
  for (let i = 0; i < 50; i++) {
    gate.push(frame(1)); gate.push(frame(0));
  }
  for (let i = 0; i < 4; i++) gate.push(frame(1));
  gate.gap();
  assert.equal(gate.push(frame(1)).started, false);
  assert.equal(gate.accepted, false);
});

test("variable packet sizes preserve samples across 20ms analysis boundaries", () => {
  const gate = new SpeechGate({ detect: detector });
  const output = [];
  for (let i = 0; i < 21; i++) output.push(...gate.push(new Int16Array(240).fill(1)).frames);
  assert.equal(gate.accepted, true);
  assert.equal(output.reduce((n, p) => n + p.length, 0) + gate.tail().length, 5040);
});

test("native WebRTC detector rejects digital silence and very quiet noise", () => {
  const detect = createSpeechDetector();
  for (let i = 0; i < 50; i++) {
    assert.equal(detect(frame(0)), false);
    assert.equal(detect(Int16Array.from({ length: 960 }, (_, n) => n % 2 ? 40 : -40)), false);
  }
});

test("native detector accepts the upstream speech fixture, including at reduced volume", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(new URL("./fixtures/vad-speech-8k.raw", import.meta.url));
  for (const gain of [1, 0.25]) {
    const gate = new SpeechGate();
    // Linear interpolation from the fixture's 8 kHz to the receiver's 48 kHz.
    const pcm = Int16Array.from({ length: (raw.length / 2 - 1) * 6 }, (_, i) => {
      const index = Math.floor(i / 6), fraction = (i % 6) / 6;
      return Math.round(gain * (raw.readInt16LE(index * 2) * (1 - fraction) + raw.readInt16LE((index + 1) * 2) * fraction));
    });
    let starts = 0;
    for (let offset = 0; offset < pcm.length; offset += 960) {
      starts += Number(gate.push(pcm.subarray(offset, offset + 960)).started);
    }
    assert.equal(starts, 1, `speech not confirmed at gain ${gain}`);
  }
});
