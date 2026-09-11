// Full-duplex audio bridge between Discord voice and the HLV gateway.
//
// Input:  20 ms Discord opus packets -> decode (always stereo out) -> downmix
//         -> halfband decimate to 24 kHz -> ~50 ms batches -> sendAudio
//         -> on end: zero-pad flush (>= 100 ms commit guarantee) -> endAudio.
// Output: audio.output PCM (rate parsed from mimeType) -> halfband interpolate
//         -> stereo -> 960-sample/20 ms opus packets in one queue. Real packets
//         carry source metadata; the playback adapter acknowledges consumption with
//         audioEndMs clamped to what was actually received for that item.
//
// The bridge is transport-agnostic: playback.js owns the Discord AudioPlayer.
// Pulling a packet does not imply playback; acknowledge it with markConsumed().

import { EventEmitter } from "node:events";
import mediaplex from "mediaplex";
import { randomUUID } from "node:crypto";
import { SpeechGate } from "./speech-gate.js";
import { Decimator, Interpolator, monoToStereo, stereoToMono } from "./resample.js";

const { OpusEncoder } = mediaplex;

export const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

const OUT_RATE = 48000;
const HLV_RATE = 24000;
const FRAME_SAMPLES_48K = 960; // 20 ms per Discord opus packet
const PACKET_MS = 20;

function int16View(buffer) {
  // aligned copy: pooled Buffers may sit at odd byte offsets
  const bytes = buffer.length & ~1;
  return new Int16Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytes));
}

function int16ToBuffer(int16) {
  return Buffer.from(int16.buffer, int16.byteOffset, int16.length * 2);
}

function concatInt16(chunks, total) {
  const out = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function parsePcmRate(mimeType) {
  if (!/^audio\/pcm\b/i.test(mimeType ?? "")) return null;
  const match = /rate=(\d+)/i.exec(mimeType);
  return match ? Number(match[1]) : null;
}

export class Bridge extends EventEmitter {
  #conn;
  #log;
  #frameMs;
  #endPadMs;
  #queueCapMs;

  // session gates
  #inputEnabled = false;
  #outputEnabled = false;
  micPaused = false;
  responseActive = false;

  // output assembly + queue
  #interp = new Interpolator();
  #encoder = new OpusEncoder(OUT_RATE, 2);
  #pcmPending = new Int16Array(0); // 48k stereo awaiting a full packet
  #assembling = null; // { itemId, contentIndex } the pending pcm belongs to
  #queue = []; // { opus, itemId, contentIndex }
  #queuedMs = 0;
  #generation = 0;
  #response = null;
  #responses = new Set();
  #serial = 0;
  #acceptOutput = false;
  playback = null; // adapter: sync(), pending, stop()
  #badMimeWarned = false;

  // input
  #utterance = null;
  #gateFactory;
  #clock;
  #trace = randomUUID();
  #inputSerial = 0;
  #connectionCount = 0;
  #lastTurnEnd = null;

  constructor({ conn, frameMs = 50, endPadMs = 240, queueCapMs = 300_000, log = () => {}, gateFactory = () => new SpeechGate(), clock = () => performance.now() }) {
    super();
    this.#conn = conn;
    this.#gateFactory = gateFactory;
    this.#clock = clock;
    this.#frameMs = frameMs;
    this.#endPadMs = endPadMs;
    this.#queueCapMs = queueCapMs;
    this.#log = log;

    conn.on("ready", (ready) => this.#onReady(ready));
    conn.on("audio.output", (msg) => this.#onAudioOutput(msg));
    conn.on("response.started", (msg) => {
      this.#flushPartial();
      this.#assembling = null;
      this.#response = { id: msg.responseId ?? ++this.#serial, items: new Map(), outstanding: 0, done: false, stats: { startedAt: this.#clock(), receivedMs: 0, consumedMs: 0, silenceMs: 0, underflows: 0, maxQueueMs: 0, empty: false, hadAudio: false } };
      this.#responses.add(this.#response);
      this.diagnostic("response_started", { responseId: this.#response.id });
      this.#acceptOutput = true;
      this.responseActive = true;
      this.emit("player-run");
    });
    const current = (msg) => !msg.responseId || msg.responseId === this.#response?.id;
    conn.on("response.completed", (msg) => {
      if (!current(msg)) return;
      this.responseActive = false;
      this.#acceptOutput = false;
      this.#flushPartial();
      if (this.#response) this.#response.done = true;
      this.#prune();
      this.emit("player-run"); // wake/drain; EOF must never force-stop buffered audio
    });
    conn.on("response.cancelled", (msg) => {
      if (current(msg)) this.#dropResponse("provider_cancelled");
    });
    conn.on("response.failed", (msg) => {
      if (!current(msg)) return;
      this.#dropResponse("provider_failed");
      this.emit("text", { kind: "error", text: "Voice response failed. Please try again." });
    });
    conn.on("input.pause_requested", () => {
      this.micPaused = true;
      this.#abortUtterance();
      this.emit("mic-paused");
      this.emit("text", { kind: "status", text: "Microphone paused by voice command — use /join to resume listening." });
    });
    conn.on("transcript.delta", (msg) => {
      if (msg.final) this.emit("text", { kind: "transcript", speaker: msg.speaker, text: msg.text });
    });
    conn.on("task.notification", (msg) => {
      this.emit("text", { kind: "notification", key: `notification:${msg.taskId}:${msg.notification.notificationId}`, text: msg.notification.message });
    });
    conn.on("task.updated", ({ task }) => {
      if (task.state === "completed" || task.state === "failed" || task.state === "cancelled") {
        const detail = task.result?.summary ?? task.error?.message ?? "";
        this.emit("text", {
          kind: "task",
          key: `task:${task.taskId}:${task.state}`,
          text: `Task ${task.state}: ${task.title ?? task.taskId}${detail ? ` — ${detail}` : ""}`,
        });
      }
    });
    conn.on("disconnected", () => { this.diagnostic("gateway_disconnected"); this.reset(); });
    conn.on("audio.dropped", (info) => this.#log(`input audio dropped (${info.reason})`));
  }

  reportPlayback() {
    this.#conn.reportPlayback?.(this.playerShouldRun || Boolean(this.playback?.active), Boolean(this.#utterance));
  }

  #onReady(ready) {
    this.reset();
    queueMicrotask(() => this.reportPlayback());
    this.diagnostic("gateway_ready", { connection: ++this.#connectionCount });
    const audio = ready.realtime?.audio ?? {};
    const inputPcm = parsePcmRate(audio.input?.mimeType) === HLV_RATE;
    this.#inputEnabled = Boolean(audio.input?.enabled) && inputPcm;
    this.#outputEnabled = Boolean(audio.output?.enabled);
    if (audio.input?.enabled && !inputPcm) {
      this.#log(`gateway advertises unsupported input codec ${audio.input?.mimeType}; input disabled`);
    }
    // a fresh session cannot continue a previous session's response
    this.#abortUtterance();
    this.#dropResponse();
    this.#badMimeWarned = false;
  }

  diagnostic(event, fields = {}) {
    this.#log(`voice ${JSON.stringify({ event, traceId: this.#trace, ...fields })}`);
  }

  #summarize(response, reason) {
    const stats = response.stats;
    this.diagnostic("response_summary", { responseId: response.id, reason,
      elapsedMs: Math.round(this.#clock() - stats.startedAt), receivedMs: stats.receivedMs,
      consumedMs: stats.consumedMs, insertedSilenceMs: stats.silenceMs,
      underflows: stats.underflows, maxQueueMs: stats.maxQueueMs });
  }

  get playerShouldRun() {
    return this.responseActive || this.#queue.length > 0;
  }

  get inputEnabled() {
    return this.#inputEnabled;
  }

  clearMicPause() {
    this.micPaused = false;
  }

  // --- output path ---

  #onAudioOutput({ data, mimeType, itemId, contentIndex }) {
    if (!this.#outputEnabled || !this.#acceptOutput) return;
    const rate = parsePcmRate(mimeType);
    if (rate === null) {
      if (!this.#badMimeWarned) {
        this.#badMimeWarned = true;
        this.#log(`dropping non-PCM audio.output (${mimeType})`);
      }
      return;
    }
    if (rate !== HLV_RATE) {
      if (!this.#badMimeWarned) {
        this.#badMimeWarned = true;
        this.#log(`dropping audio.output at unsupported rate ${rate}`);
      }
      return;
    }
    const raw = Buffer.from(data, "base64");
    const pcm = int16View(raw);
    if (pcm.length === 0) return;
    if (this.#lastTurnEnd !== null) {
      this.diagnostic('turn_first_audio', { inputId: this.#inputSerial, latencyMs: Math.round(this.#clock() - this.#lastTurnEnd) });
      this.#lastTurnEnd = null;
    }
    this.#response.stats.receivedMs += pcm.length / HLV_RATE * 1000;
    const key = JSON.stringify([itemId ?? null, contentIndex ?? 0]);
    if (!this.#assembling || this.#assembling.key !== key) {
      this.#flushPartial();
      let item = this.#response.items.get(key);
      if (!item) {
        item = { itemId: itemId ?? null, contentIndex: contentIndex ?? 0, received: 0, consumed: 0 };
        this.#response.items.set(key, item);
      }
      this.#assembling = { key, item };
    }
    this.#assembling.item.received += pcm.length / HLV_RATE * 1000;
    if (this.#queuedMs >= this.#queueCapMs) {
      this.#log("playback queue full; cancelling response");
      this.bargeIn("queue_full");
      return;
    }
    const stereo = monoToStereo(this.#interp.process(pcm));
    const merged = concatInt16([this.#pcmPending, stereo], this.#pcmPending.length + stereo.length);
    let offset = 0;
    while (merged.length - offset >= FRAME_SAMPLES_48K * 2) {
      this.#enqueue(merged.subarray(offset, offset + FRAME_SAMPLES_48K * 2));
      offset += FRAME_SAMPLES_48K * 2;
    }
    this.#pcmPending = merged.slice(offset);
    if (this.#queue.length > 0) this.emit("player-run");
  }

  #enqueue(pcmStereo48k, sourceMs = PACKET_MS) {
    const opus = this.#encoder.encode(int16ToBuffer(pcmStereo48k));
    this.#queue.push({
      opus,
      generation: this.#generation,
      response: this.#response,
      item: this.#assembling?.item,
      sourceMs,
    });
    this.#queuedMs += PACKET_MS;
    if (this.#response) {
      this.#response.outstanding++;
      this.#response.stats.maxQueueMs = Math.max(this.#response.stats.maxQueueMs, this.#queuedMs);
    }
  }

  #flushPartial() {
    if (this.#pcmPending.length === 0) return;
    const padded = new Int16Array(FRAME_SAMPLES_48K * 2);
    padded.set(this.#pcmPending, 0);
    this.#enqueue(padded, this.#pcmPending.length / 2 / OUT_RATE * 1000);
    this.#pcmPending = new Int16Array(0);
  }

  // Stream prefetch only transfers ownership; it never credits consumption.
  nextPacket() {
    const pkt = this.#queue.shift();
    if (!pkt) {
      if (!this.responseActive) return null;
      const stats = this.#response?.stats;
      if (stats && !stats.empty) {
        if (stats.hadAudio) stats.underflows++;
        stats.empty = true;
      }
      return { opus: SILENCE_FRAME, sourceMs: 0, generation: this.#generation, silenceResponse: this.#response };
    }
    pkt.response.stats.empty = false;
    pkt.response.stats.hadAudio = true;
    this.#queuedMs -= PACKET_MS;
    return pkt;
  }

  markConsumed(pkt) {
    if (pkt.generation !== this.#generation || pkt.consumed) return;
    pkt.consumed = true;
    if (pkt.item) pkt.item.consumed += pkt.sourceMs;
    if (pkt.silenceResponse) pkt.silenceResponse.stats.silenceMs += PACKET_MS;
    if (pkt.response) { pkt.response.outstanding--; pkt.response.stats.consumedMs += pkt.sourceMs; }
    this.#prune();
  }

  #prune() {
    for (const response of this.#responses) {
      if (response.done && response.outstanding === 0) {
        this.#summarize(response, "drained");
        this.#responses.delete(response);
        response.items.clear();
        if (this.#response === response) this.#response = null;
      }
    }
  }

  get accountingSize() { return this.#responses.size; }

  reset() {
    this.#inputEnabled = false;
    this.#outputEnabled = false;
    this.#abortUtterance();
    this.#dropResponse();
  }

  #clearQueue() {
    this.#queue.length = 0;
    this.#queuedMs = 0;
    this.#pcmPending = new Int16Array(0);
    this.#assembling = null;
    this.#interp = new Interpolator();
  }

  #dropResponse(reason = "reset") {
    this.playback?.sync();
    for (const response of this.#responses) this.#summarize(response, reason);
    this.#generation++;
    this.#acceptOutput = false;
    this.#responses.clear();
    this.#response = null;
    this.responseActive = false;
    this.#clearQueue();
    this.emit("player-stop");
  }

  // --- barge-in ---

  onSpeakingStart() {} // Discord packet activity is not evidence of speech.

  bargeIn(reason = "user_barge_in", evidence = {}) {
    this.playback?.sync();
    if (!this.responseActive && this.#queue.length === 0 && !this.playback?.pending) return false;
    // The earliest unfinished response is the one currently audible. Never
    // truncate a previously completed item merely because it played last.
    const response = [...this.#responses].find((r) => r.outstanding > 0) ?? this.#response;
    const items = [...(response?.items.values() ?? [])];
    const item = items.find((i) => i.consumed < i.received) ?? items.at(-1);
    const truncate = item?.itemId ? {
      itemId: item.itemId,
      contentIndex: item.contentIndex,
      audioEndMs: Math.floor(Math.min(item.consumed, item.received)),
    } : undefined;
    this.diagnostic("interruption", { responseId: response?.id, reason, queuedMs: this.#queuedMs, ...evidence });
    this.#conn.cancelResponse(reason, truncate);
    this.#dropResponse(reason);
    return true;
  }

  // --- input path ---

  // One utterance at a time: returns a sink for the caller to feed Discord
  // opus packets into, or null when input is unavailable (mic paused, audio
  // disabled, or another utterance is in flight).
  beginUtterance() {
    if (!this.#inputEnabled || this.micPaused || this.#utterance) return null;
    const gate = this.#gateFactory();
    const inputId = ++this.#inputSerial;
    const responseId = this.#response?.id ?? null;
    let lastPacketAt = null, maxGapMs = 0, decodedMs = 0, decodeErrors = 0;
    const summary = (reason) => this.diagnostic("input_summary", { inputId, responseId, reason, voicedMs: gate.voicedMs, decodedMs, sentMs, maxGapMs: Math.round(maxGapMs), decodeErrors });
    const decoder = new OpusEncoder(OUT_RATE, 2);
    const decimator = new Decimator();
    const frameSamples = Math.round((this.#frameMs / 1000) * HLV_RATE);
    let pending = new Int16Array(0);
    let sentMs = 0;
    const sendFrame = (int16) => {
      if (int16.length === 0) return;
      const id = this.#conn.sendAudio(int16ToBuffer(int16).toString("base64"), `audio/pcm;rate=${HLV_RATE}`);
      if (id !== undefined) sentMs += (int16.length / HLV_RATE) * 1000;
    };
    const forward = (mono) => {
      const down = decimator.process(mono);
      pending = concatInt16([pending, down], pending.length + down.length);
      let offset = 0;
      while (pending.length - offset >= frameSamples) {
        sendFrame(pending.subarray(offset, offset + frameSamples));
        offset += frameSamples;
      }
      if (offset > 0) pending = pending.slice(offset);
    };
    const utterance = {
      write: (opusPacket) => {
        if (this.#utterance !== utterance) return;
        const now = this.#clock();
        if (lastPacketAt !== null) {
          const gap = now - lastPacketAt;
          maxGapMs = Math.max(maxGapMs, gap);
          if (gap > 100) gate.gap();
        }
        lastPacketAt = now;
        let pcm;
        try { pcm = decoder.decode(opusPacket); }
        catch { decodeErrors++; gate.gap(); return; }
        const mono = stereoToMono(int16View(pcm));
        decodedMs += mono.length / OUT_RATE * 1000;
        let result;
        try { result = gate.push(mono); }
        catch {
          summary("detector_error");
          this.#utterance = null;
          this.reportPlayback();
          this.emit("input-error"); // detach any partially sent upstream turn
          return;
        }
        if (result.started) {
          this.diagnostic("speech_confirmed", { inputId, responseId, voicedMs: gate.voicedMs });
          this.bargeIn("user_barge_in", { inputId, voicedMs: gate.voicedMs });
        }
        for (const frame of result.frames) forward(frame);
      },
      end: () => {
        if (this.#utterance !== utterance) return;
        this.#utterance = null;
        queueMicrotask(() => this.reportPlayback());
        if (!gate.accepted) { summary("no_speech"); return; }
        forward(gate.tail());
        sendFrame(pending);
        // Flush the FIR tail and guarantee the provider-side commit is
        // >= 100 ms; sent as one burst so it adds no real-time latency.
        sendFrame(new Int16Array(Math.round((this.#endPadMs / 1000) * HLV_RATE)));
        this.#lastTurnEnd = this.#clock();
        this.#conn.endAudio();
        summary("committed");
        this.emit("utterance-end", { sentMs });
      },
      abort: () => {
        if (this.#utterance === utterance) { this.#utterance = null; this.reportPlayback(); summary("aborted"); }
      },
    };
    this.#utterance = utterance;
    this.reportPlayback();
    return utterance;
  }

  #abortUtterance() {
    this.#utterance?.abort();
  }
}
