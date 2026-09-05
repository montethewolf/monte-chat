import test from "node:test";
import assert from "node:assert/strict";
import { Decimator, Interpolator, monoToStereo, stereoToMono } from "../src/resample.js";

const AMP = 16000;

function tone(freq, rate, samples, amp = AMP) {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate));
  }
  return out;
}

// Goertzel power at freq over a window chosen for integer cycles (no leakage).
function goertzelPower(signal, freq, rate, offset, length) {
  const k = Math.round((length * freq) / rate);
  const w = (2 * Math.PI * k) / length;
  const coeff = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < length; i++) {
    s0 = signal[offset + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

function dB(powerA, powerB) {
  return 10 * Math.log10(powerA / powerB);
}

// Analyze 4800 samples of steady state at 48k, skipping filter warmup.
const WIN = 4800;
const SKIP = 1024;

test("interpolator: 1 kHz tone passes; its 23 kHz image is suppressed > 40 dB", () => {
  const up = new Interpolator().process(tone(1000, 24000, 12000));
  const sig = goertzelPower(up, 1000, 48000, SKIP, WIN);
  const img = goertzelPower(up, 23000, 48000, SKIP, WIN);
  const ref = goertzelPower(tone(1000, 48000, SKIP + WIN), 1000, 48000, SKIP, WIN);
  assert.ok(Math.abs(dB(sig, ref)) < 1, `passband gain off by ${dB(sig, ref).toFixed(2)} dB`);
  assert.ok(dB(img, sig) < -40, `23 kHz image only ${dB(img, sig).toFixed(1)} dB down`);
});

test("interpolator: 10 kHz transition-band image at 14 kHz is suppressed > 35 dB", () => {
  const up = new Interpolator().process(tone(10000, 24000, 12000));
  const sig = goertzelPower(up, 10000, 48000, SKIP, WIN);
  const img = goertzelPower(up, 14000, 48000, SKIP, WIN);
  const ref = goertzelPower(tone(10000, 48000, SKIP + WIN), 10000, 48000, SKIP, WIN);
  assert.ok(dB(sig, ref) > -4, `10 kHz droop is ${dB(sig, ref).toFixed(2)} dB`);
  assert.ok(dB(img, sig) < -35, `14 kHz image only ${dB(img, sig).toFixed(1)} dB down`);
});

test("decimator: 23 kHz content does not alias into the speech band (> 40 dB down)", () => {
  const alias = new Decimator().process(tone(23000, 48000, 24000));
  const reference = new Decimator().process(tone(1000, 48000, 24000));
  // 23 kHz folds to 1 kHz after 2:1 decimation
  const aliasPower = goertzelPower(alias, 1000, 24000, SKIP, WIN);
  const refPower = goertzelPower(reference, 1000, 24000, SKIP, WIN);
  assert.ok(dB(aliasPower, refPower) < -40, `alias only ${dB(aliasPower, refPower).toFixed(1)} dB down`);
});

test("decimator: passband 1 kHz survives with unity gain", () => {
  const down = new Decimator().process(tone(1000, 48000, 24000));
  const sig = goertzelPower(down, 1000, 24000, SKIP, WIN);
  const ref = goertzelPower(tone(1000, 24000, SKIP + WIN), 1000, 24000, SKIP, WIN);
  assert.ok(Math.abs(dB(sig, ref)) < 1, `passband gain off by ${dB(sig, ref).toFixed(2)} dB`);
});

test("chunked processing matches one-shot processing exactly (stateful correctness)", () => {
  const src = new Int16Array(9973);
  let seed = 42;
  for (let i = 0; i < src.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    src[i] = (seed % 20000) - 10000;
  }
  for (const Ctor of [Interpolator, Decimator]) {
    const oneShot = new Ctor().process(src);
    const chunked = new Ctor();
    const parts = [];
    const sizes = [1, 7, 960, 3, 1919, 4096, 480];
    let pos = 0;
    let s = 0;
    while (pos < src.length) {
      const n = Math.min(sizes[s++ % sizes.length], src.length - pos);
      parts.push(chunked.process(src.subarray(pos, pos + n)));
      pos += n;
    }
    const merged = new Int16Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) {
      merged.set(p, o);
      o += p.length;
    }
    assert.equal(merged.length, oneShot.length, `${Ctor.name} length mismatch`);
    assert.deepEqual(merged, oneShot, `${Ctor.name} chunked output diverged`);
  }
});

test("round-trip 24k -> 48k -> 24k preserves a speech-band tone", () => {
  const src = tone(2000, 24000, 12000);
  const back = new Decimator().process(new Interpolator().process(src));
  const sig = goertzelPower(back, 2000, 24000, SKIP, WIN);
  const ref = goertzelPower(src, 2000, 24000, SKIP, WIN);
  assert.ok(Math.abs(dB(sig, ref)) < 1, `round-trip gain off by ${dB(sig, ref).toFixed(2)} dB`);
});

test("channel helpers: downmix averages, upmix duplicates", () => {
  const stereo = new Int16Array([100, 200, -100, -300, 32767, 32767]);
  assert.deepEqual(Array.from(stereoToMono(stereo)), [150, -200, 32767]);
  const mono = new Int16Array([5, -6]);
  assert.deepEqual(Array.from(monoToStereo(mono)), [5, 5, -6, -6]);
});
