import webrtcvad from "webrtcvad";

const VAD = webrtcvad.default ?? webrtcvad;
const SAMPLES = 960; // 20 ms, mono 48 kHz

export function createSpeechDetector() {
  const vad = new VAD(48000, 2);
  return (frame) => {
    const speech = vad.process(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
    // WebRTC's hangover may label digital silence after a click as speech.
    let energy = 0;
    for (const sample of frame) energy += sample * sample;
    return speech && Math.sqrt(energy / frame.length) >= 100;
  };
}

// Bounded pre-roll; no audio escapes until five consecutive voiced frames.
// Keep turn completion in the receiver; this class only validates onset.
export class SpeechGate {
  constructor({ detect = createSpeechDetector(), confirmMs = 100, preRollMs = 200 } = {}) {
    this.detect = detect;
    this.confirmMs = confirmMs;
    this.capacity = Math.ceil(preRollMs / 20);
    this.pending = new Int16Array(0);
    this.history = [];
    this.accepted = false;
    this.voicedMs = 0;
    this.runMs = 0;
  }
  gap() { if (!this.accepted) { this.runMs = 0; this.history = []; this.pending = new Int16Array(0); } }
  push(pcm) {
    const merged = new Int16Array(this.pending.length + pcm.length);
    merged.set(this.pending); merged.set(pcm, this.pending.length);
    const output = [];
    let offset = 0;
    let started = false;
    for (; offset + SAMPLES <= merged.length; offset += SAMPLES) {
      const frame = merged.slice(offset, offset + SAMPLES);
      const voiced = this.detect(frame);
      if (voiced) this.voicedMs += 20;
      this.runMs = voiced ? this.runMs + 20 : 0;
      if (this.accepted) { output.push(frame); continue; }
      this.history.push(frame);
      if (this.history.length > this.capacity) this.history.shift();
      if (this.runMs >= this.confirmMs) {
        this.accepted = true;
        started = true;
        output.push(...this.history);
        this.history = [];
      }
    }
    this.pending = merged.slice(offset);
    return { started, frames: output };
  }
  tail() { return this.accepted ? this.pending : new Int16Array(0); }
}
