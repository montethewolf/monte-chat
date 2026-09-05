// Full-duplex audio bridge between Discord voice and the HLV gateway.
//
// Input:  20 ms Discord opus packets -> decode (always stereo out) -> downmix
//         -> halfband decimate to 24 kHz -> ~50 ms batches -> sendAudio
//         -> on end: zero-pad flush (>= 100 ms commit guarantee) -> endAudio.
// Output: audio.output PCM (rate parsed from mimeType) -> halfband interpolate
//         -> stereo -> 960-sample/20 ms opus packets in one queue. Real packets
//         advance a played-ms ledger keyed by itemId; barge-in cancels with
//         audioEndMs clamped to what was actually received for that item.
//
// The bridge is transport-agnostic: index.js owns the Discord AudioPlayer and
// pulls packets via nextPacket(); tests pull directly.

import { EventEmitter } from "node:events";
import mediaplex from "mediaplex";
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
  #receivedMs = new Map(); // itemId -> total source ms received
  #playedMs = new Map(); // itemId -> total source ms dequeued
  #lastPlayed = null; // { itemId, contentIndex }
  #badMimeWarned = false;

  // input
  #utterance = null;

  constructor({ conn, frameMs = 50, endPadMs = 240, queueCapMs = 300_000, log = () => {} }) {
    super();
    this.#conn = conn;
    this.#frameMs = frameMs;
    this.#endPadMs = endPadMs;
    this.#queueCapMs = queueCapMs;
    this.#log = log;

    conn.on("ready", (ready) => this.#onReady(ready));
    conn.on("audio.output", (msg) => this.#onAudioOutput(msg));
    conn.on("response.started", () => {
      this.responseActive = true;
      this.emit("player-run");
    });
    conn.on("response.completed", () => {
      this.responseActive = false;
      this.#flushPartial();
      if (this.#queue.length === 0) this.emit("player-stop");
    });
    conn.on("response.cancelled", () => this.#dropResponse());
    conn.on("response.failed", (msg) => {
      this.#dropResponse();
      this.emit("text", { kind: "error", text: `Response failed: ${msg.error}` });
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
      this.emit("text", { kind: "notification", text: msg.notification.message });
    });
    conn.on("task.updated", ({ task }) => {
      if (task.state === "completed" || task.state === "failed" || task.state === "cancelled") {
        const detail = task.result?.summary ?? task.error?.message ?? "";
        this.emit("text", {
          kind: "task",
          text: `Task ${task.state}: ${task.title ?? task.taskId}${detail ? ` — ${detail}` : ""}`,
        });
      }
    });
    conn.on("disconnected", () => {
      this.#abortUtterance();
      this.#dropResponse();
    });
    conn.on("audio.dropped", (info) => this.#log(`input audio dropped (${info.reason})`));
  }

  #onReady(ready) {
    const audio = ready.realtime?.audio ?? {};
    const inputPcm = parsePcmRate(audio.input?.mimeType) !== null;
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
    if (!this.#outputEnabled) return;
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
    const key = itemId ?? null;
    if (!this.#assembling || this.#assembling.itemId !== key) {
      this.#flushPartial();
      this.#assembling = { itemId: key, contentIndex: contentIndex ?? 0 };
    }
    if (itemId) {
      this.#receivedMs.set(itemId, (this.#receivedMs.get(itemId) ?? 0) + (pcm.length / HLV_RATE) * 1000);
    }
    if (this.#queuedMs >= this.#queueCapMs) {
      this.#log("playback queue full; dropping output audio");
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

  #enqueue(pcmStereo48k) {
    const opus = this.#encoder.encode(int16ToBuffer(pcmStereo48k));
    this.#queue.push({
      opus,
      itemId: this.#assembling?.itemId ?? null,
      contentIndex: this.#assembling?.contentIndex ?? 0,
    });
    this.#queuedMs += PACKET_MS;
  }

  #flushPartial() {
    if (this.#pcmPending.length === 0) return;
    const padded = new Int16Array(FRAME_SAMPLES_48K * 2);
    padded.set(this.#pcmPending, 0);
    this.#enqueue(padded);
    this.#pcmPending = new Int16Array(0);
  }

  // Pull the next 20 ms opus packet for playback. Within an active response an
  // underflow yields a silence frame so the player never starves; when the
  // response is over and the queue is dry it returns null (player stops).
  nextPacket() {
    const pkt = this.#queue.shift();
    if (!pkt) {
      if (this.responseActive) return SILENCE_FRAME;
      this.emit("player-stop");
      return null;
    }
    this.#queuedMs -= PACKET_MS;
    if (pkt.itemId) {
      this.#playedMs.set(pkt.itemId, (this.#playedMs.get(pkt.itemId) ?? 0) + PACKET_MS);
      this.#lastPlayed = { itemId: pkt.itemId, contentIndex: pkt.contentIndex };
    }
    return pkt.opus;
  }

  #clearQueue() {
    this.#queue.length = 0;
    this.#queuedMs = 0;
    this.#pcmPending = new Int16Array(0);
    this.#assembling = null;
    this.#interp = new Interpolator();
  }

  #dropResponse() {
    this.responseActive = false;
    this.#clearQueue();
    this.emit("player-stop");
  }

  // --- barge-in ---

  onSpeakingStart() {
    if (this.responseActive || this.#queue.length > 0) this.bargeIn();
  }

  bargeIn() {
    if (!this.responseActive && this.#queue.length === 0) return false;
    this.#clearQueue();
    let truncate;
    const last = this.#lastPlayed;
    if (last?.itemId) {
      const played = this.#playedMs.get(last.itemId) ?? 0;
      const received = this.#receivedMs.get(last.itemId) ?? played;
      truncate = {
        itemId: last.itemId,
        contentIndex: last.contentIndex ?? 0,
        audioEndMs: Math.round(Math.min(played, received)),
      };
    }
    this.#conn.cancelResponse("user_barge_in", truncate);
    this.#log(
      truncate
        ? `barge-in: truncated ${truncate.itemId} at ${truncate.audioEndMs}ms`
        : "barge-in: cancelled response (no itemId to truncate)",
    );
    this.responseActive = false; // server confirms with response.cancelled
    this.emit("player-stop");
    return true;
  }

  // --- input path ---

  // One utterance at a time: returns a sink for the caller to feed Discord
  // opus packets into, or null when input is unavailable (mic paused, audio
  // disabled, or another utterance is in flight).
  beginUtterance() {
    if (!this.#inputEnabled || this.micPaused || this.#utterance) return null;
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
    const utterance = {
      write: (opusPacket) => {
        if (this.#utterance !== utterance) return;
        let pcm;
        try {
          pcm = decoder.decode(opusPacket);
        } catch (err) {
          this.#log(`opus decode failed: ${err.message}`);
          return;
        }
        const mono = stereoToMono(int16View(pcm));
        const down = decimator.process(mono);
        pending = concatInt16([pending, down], pending.length + down.length);
        let offset = 0;
        while (pending.length - offset >= frameSamples) {
          sendFrame(pending.subarray(offset, offset + frameSamples));
          offset += frameSamples;
        }
        if (offset > 0) pending = pending.slice(offset);
      },
      end: () => {
        if (this.#utterance !== utterance) return;
        this.#utterance = null;
        sendFrame(pending);
        // Flush the FIR tail and guarantee the provider-side commit is
        // >= 100 ms; sent as one burst so it adds no real-time latency.
        sendFrame(new Int16Array(Math.round((this.#endPadMs / 1000) * HLV_RATE)));
        this.#conn.endAudio();
        this.emit("utterance-end", { sentMs });
      },
      abort: () => {
        if (this.#utterance === utterance) this.#utterance = null;
      },
    };
    this.#utterance = utterance;
    return utterance;
  }

  #abortUtterance() {
    this.#utterance = null;
  }
}
