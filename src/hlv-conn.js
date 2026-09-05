// HLV connection wrapper: owns reconnection, liveness, and session persistence
// around the official hermes-live-voice browser SDK. The SDK itself never
// reconnects and never pings; both are this wrapper's job.
//
// States: idle -> connecting -> ready -> backoff -> connecting ... ; terminal: halted.
// Never log tokens or socket URLs.

import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import WebSocket from "ws";
import { HermesLiveClient } from "hermes-live-voice/browser";

// Server messages the bridge consumes, re-emitted verbatim so consumers can
// subscribe once to the wrapper instead of re-attaching per reconnect.
const RE_EMITTED = [
  "audio.output",
  "transcript.delta",
  "input.speech_started",
  "input.pause_requested",
  "response.started",
  "response.completed",
  "response.cancelled",
  "response.failed",
  "task.notification",
  "task.updated",
  "audio.dropped",
];

function findSessionIds(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) findSessionIds(item, out);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if ((key === "sessionId" || key === "id") && typeof item === "string") out.add(item);
      else findSessionIds(item, out);
    }
  }
}

export class HlvConnection extends EventEmitter {
  #forceNew = false;
  #attemptedResume = false;
  #resumeFallbackUsed = false;
  #lastSessionError = null;
  #retryAfterFloorMs = 0;
  #failures = 0;
  #reconnectTimer = null;
  #pingTimer = null;
  #pongTimer = null;
  #rawSocket = null;

  constructor(options) {
    super();
    if (!options?.url) throw new Error("HlvConnection requires a gateway url");
    this.url = String(options.url);
    this.token = options.token ?? null;
    this.stateFile = options.stateFile ?? null;
    this.pingIntervalMs = options.pingIntervalMs ?? 15_000;
    this.pongTimeoutMs = options.pongTimeoutMs ?? 10_000;
    this.backoffBaseMs = options.backoffBaseMs ?? 1_000;
    this.backoffMaxMs = options.backoffMaxMs ?? 30_000;
    this.jitterMs = options.jitterMs ?? 250;
    this.log = options.log ?? (() => {});
    this.state = "idle";
    this.desired = false;
    this.client = null;
    this.sessionId = null;
  }

  get session() {
    return this.client?.session;
  }

  get connected() {
    return this.state === "ready" && Boolean(this.client?.connected);
  }

  async start() {
    if (this.desired) return;
    this.desired = true;
    await this.#loadState();
    this.#attempt();
  }

  async stop(reason = "bridge shutdown") {
    this.desired = false;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#stopPing();
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.disconnect(reason);
      } catch (err) {
        this.log(`disconnect: ${err.message}`);
      }
    }
    if (this.state !== "halted") this.#setState("idle");
  }

  // --- passthroughs (safe while disconnected: drop and report undefined) ---

  sendAudio(data, mimeType) {
    if (!this.connected) return undefined;
    return this.client.sendAudio(data, mimeType);
  }

  endAudio() {
    if (!this.connected) return undefined;
    return this.client.endAudio();
  }

  cancelResponse(reason, truncate) {
    if (!this.connected) return undefined;
    return this.client.cancelResponse(reason, truncate);
  }

  sendText(text) {
    if (!this.connected) return undefined;
    return this.client.sendText(text);
  }

  // --- connection lifecycle ---

  #setState(state) {
    if (state === this.state) return;
    const previous = this.state;
    this.state = state;
    this.emit("state", { state, previous });
  }

  #attempt() {
    if (!this.desired || this.state === "halted") return;
    this.#setState("connecting");
    this.#run().catch((err) => this.#onAttemptFailed(err));
  }

  async #run() {
    const conversation = await this.#chooseConversation();
    this.#attemptedResume = conversation.mode === "resume";
    this.#lastSessionError = null;
    const client = this.#createClient();
    this.client = client;
    const ready = await client.connect({ conversation });
    if (client !== this.client) return; // superseded while connecting
    this.#failures = 0;
    this.#retryAfterFloorMs = 0;
    this.#resumeFallbackUsed = false;
    const sid = ready.conversation?.sessionId;
    if (sid) await this.#saveSessionId(sid);
    this.#startPing();
    this.#setState("ready");
    this.emit("ready", ready);
  }

  #createClient() {
    const client = new HermesLiveClient({
      url: this.url,
      webSocketFactory: (url) => this.#createSocket(url),
    });
    const current = () => client === this.client;
    for (const type of RE_EMITTED) {
      client.on(type, (event) => {
        if (current()) this.emit(type, event);
      });
    }
    client.on("error", (event) => {
      if (current()) this.emit("client-error", event);
    });
    client.on("session.error", (event) => {
      if (!current()) return;
      this.#lastSessionError = event;
      this.emit("session.error", event);
      if (event.recoverable === false && this.state === "ready") {
        this.#halt(`gateway reported a nonrecoverable error (${event.code})`);
      }
    });
    client.on("close", (event) => {
      if (!current()) return;
      this.emit("close", event);
      this.#onClose(event);
    });
    return client;
  }

  #createSocket(url) {
    const headers = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const ws = new WebSocket(url, { headers });
    ws.on("unexpected-response", (req, res) => {
      const retryAfter = Number(res.headers["retry-after"]);
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        this.#retryAfterFloorMs = retryAfter * 1000;
      }
      this.log(`gateway refused the connection (HTTP ${res.statusCode})`);
      res.resume();
      ws.terminate();
    });
    ws.on("pong", () => {
      clearTimeout(this.#pongTimer);
      this.#pongTimer = null;
    });
    this.#rawSocket = ws;
    return ws;
  }

  async #chooseConversation() {
    if (this.#forceNew) {
      this.#forceNew = false;
      return { mode: "new" };
    }
    if (this.sessionId && (await this.#conversationExists(this.sessionId))) {
      return { mode: "resume", sessionId: this.sessionId };
    }
    return { mode: "new" };
  }

  // Pre-validate a saved sessionId against the gateway's persisted-session
  // list; session_start_failed is ambiguous, so this avoids most bad resumes.
  // On any listing failure we optimistically try the resume (the one-shot
  // mode:"new" fallback covers a stale id).
  async #conversationExists(sessionId) {
    try {
      const base = new URL(this.url);
      const scheme = base.protocol === "wss:" ? "https" : "http";
      const headers = {};
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      const res = await fetch(`${scheme}://${base.host}/v1/conversations?limit=100`, { headers });
      if (!res.ok) return true;
      const ids = new Set();
      findSessionIds(await res.json(), ids);
      return ids.has(sessionId);
    } catch {
      return true;
    }
  }

  #onAttemptFailed(err) {
    this.#stopPing();
    if (!this.desired || this.state === "halted") return;
    const se = this.#lastSessionError;
    if (se && se.recoverable === false) {
      this.#halt(`gateway rejected the session (${se.code})`);
      return;
    }
    this.log(`connect failed: ${err.message}`);
    if (
      se?.code === "session_start_failed" &&
      this.#attemptedResume &&
      !this.#resumeFallbackUsed
    ) {
      // Saved session may be stale despite pre-validation; retry once fresh.
      this.#resumeFallbackUsed = true;
      this.#forceNew = true;
      this.#attempt();
      return;
    }
    this.#scheduleReconnect();
  }

  #onClose(event) {
    this.#stopPing();
    if (!this.desired || this.state === "halted") return;
    // Pre-ready closes surface through the connect() rejection path.
    if (this.state !== "ready") return;
    if (event.code === 1008) {
      this.#halt(`gateway closed the connection (${event.code})`);
      return;
    }
    this.log(`connection lost (close ${event.code})`);
    this.emit("disconnected", event);
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (this.#reconnectTimer) return;
    const n = this.#failures++;
    const exp = Math.min(this.backoffBaseMs * 2 ** n, this.backoffMaxMs);
    const jitter = Math.floor(Math.random() * this.jitterMs);
    const delay = Math.max(exp + jitter, this.#retryAfterFloorMs);
    this.#retryAfterFloorMs = 0;
    this.#setState("backoff");
    this.emit("backoff", { delayMs: delay, failures: this.#failures });
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#attempt();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #halt(reason) {
    this.#stopPing();
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#setState("halted");
    this.emit("halted", { reason });
  }

  // --- ws-level liveness: the gateway never pings; we are the only heartbeat ---

  #startPing() {
    this.#stopPing();
    const ws = this.#rawSocket;
    if (!ws) return;
    this.#pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.ping();
      if (!this.#pongTimer) {
        this.#pongTimer = setTimeout(() => {
          this.#pongTimer = null;
          this.log("liveness ping timed out; dropping the socket");
          this.emit("ping-timeout");
          ws.terminate();
        }, this.pongTimeoutMs);
        this.#pongTimer.unref?.();
      }
    }, this.pingIntervalMs);
    this.#pingTimer.unref?.();
  }

  #stopPing() {
    clearInterval(this.#pingTimer);
    clearTimeout(this.#pongTimer);
    this.#pingTimer = null;
    this.#pongTimer = null;
  }

  // --- session persistence (atomic write-rename) ---

  async #loadState() {
    if (!this.stateFile) return;
    try {
      const data = JSON.parse(await readFile(this.stateFile, "utf8"));
      if (typeof data.sessionId === "string" && data.sessionId) this.sessionId = data.sessionId;
    } catch {
      // missing or corrupt state file: start fresh
    }
  }

  async #saveSessionId(sessionId) {
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    if (!this.stateFile) return;
    try {
      await mkdir(dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify({ sessionId }), "utf8");
      await rename(tmp, this.stateFile);
    } catch (err) {
      this.log(`state save failed: ${err.message}`);
    }
  }
}
