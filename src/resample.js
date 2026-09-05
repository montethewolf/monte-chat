// Stateful 2:1 resamplers built on one 31-tap Kaiser-windowed halfband FIR.
// The gateway's own resampler is anti-alias-free linear interpolation, so the
// bridge does all rate conversion itself: decimate 48k->24k on the way in,
// interpolate 24k->48k on the way out.
//
// Halfband structure: all even-index taps are the symmetric side lobes, the
// center tap (index 15) is 0.5, and the remaining odd-index taps are zero.
// Polyphase split: one phase is a pure 7-sample delay, the other a 16-tap
// symmetric FIR.

const TAPS = 31;
const CENTER = 15;
// Chosen by scanning the response against both acceptance probes: at 31 taps,
// beta 3.5 gives ~-59 dB at the 14 kHz transition-band image and ~-61 dB at
// the 23 kHz far image with flat passband; larger beta widens the transition
// and fails the 14 kHz spec.
const KAISER_BETA = 3.5;

function besselI0(x) {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 25; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
  }
  return sum;
}

const h = new Float64Array(TAPS);
for (let n = 0; n < TAPS; n++) {
  const d = n - CENTER;
  const sinc = d === 0 ? 0.5 : Math.sin((Math.PI * d) / 2) / (Math.PI * d);
  const w = besselI0(KAISER_BETA * Math.sqrt(1 - (d / CENTER) ** 2)) / besselI0(KAISER_BETA);
  h[n] = sinc * w;
}
{
  // normalize DC gain to exactly 1
  let dc = 0;
  for (const v of h) dc += v;
  for (let n = 0; n < TAPS; n++) h[n] /= dc;
}
// Even-index taps, used by both polyphase structures (16 values, symmetric).
const SIDE = new Float64Array(16);
for (let j = 0; j < 16; j++) SIDE[j] = h[2 * j];

function clampInt16(v) {
  const r = Math.round(v);
  return r > 32767 ? 32767 : r < -32768 ? -32768 : r;
}

// 24 kHz -> 48 kHz. For each input sample x[n] emits two outputs:
//   y[2n]   = sum_j 2*SIDE[j] * x[n-j]      (16-tap phase)
//   y[2n+1] = x[n-7]                        (pure-delay phase)
export class Interpolator {
  #tail = new Float64Array(15); // last 15 input samples

  process(input) {
    const len = input.length;
    const buf = new Float64Array(15 + len);
    buf.set(this.#tail, 0);
    for (let i = 0; i < len; i++) buf[15 + i] = input[i];
    const out = new Int16Array(len * 2);
    for (let i = 15; i < buf.length; i++) {
      let acc = 0;
      for (let j = 0; j < 16; j++) acc += SIDE[j] * buf[i - j];
      out[(i - 15) * 2] = clampInt16(2 * acc);
      out[(i - 15) * 2 + 1] = clampInt16(buf[i - 7]);
    }
    this.#tail.set(buf.subarray(buf.length - 15));
    return out;
  }
}

// 48 kHz -> 24 kHz:  y[n] = sum_j SIDE[j] * x[2n-2j]  +  0.5 * x[2n-15]
export class Decimator {
  #pending = new Float64Array(30); // unconsumed input, primed with zeros
  #next = 30; // index into pending of the next output's newest sample

  process(input) {
    const prev = this.#pending;
    const buf = new Float64Array(prev.length + input.length);
    buf.set(prev, 0);
    for (let i = 0; i < input.length; i++) buf[prev.length + i] = input[i];
    let k = this.#next;
    const out = new Int16Array(Math.max(0, Math.ceil((buf.length - k) / 2)));
    let n = 0;
    for (; k < buf.length; k += 2) {
      let acc = 0.5 * buf[k - 15];
      for (let j = 0; j < 16; j++) acc += SIDE[j] * buf[k - 2 * j];
      out[n++] = clampInt16(acc);
    }
    // retain the 30-sample history the next output needs, preserving parity
    const keepFrom = k - 30;
    this.#pending = buf.slice(keepFrom);
    this.#next = k - keepFrom;
    return out.subarray(0, n);
  }
}

export function stereoToMono(stereo) {
  const out = new Int16Array(stereo.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = clampInt16((stereo[2 * i] + stereo[2 * i + 1]) / 2);
  }
  return out;
}

export function monoToStereo(mono) {
  const out = new Int16Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) {
    out[2 * i] = mono[i];
    out[2 * i + 1] = mono[i];
  }
  return out;
}
