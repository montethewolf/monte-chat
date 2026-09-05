// Gateway transport only. The call controller owns conversation persistence.
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { HermesLiveClient } from "hermes-live-voice/browser";

const EVENTS = ["audio.output", "transcript.delta", "input.speech_started", "input.pause_requested",
  "response.started", "response.completed", "response.cancelled", "response.failed",
  "task.notification", "task.updated", "audio.dropped"];

export class HlvConnection extends EventEmitter {
  #generation = 0;
  #abort = null;
  #socket = null;
  #retry = null;
  #ping = null;
  #pong = null;
  #failures = 0;
  #retryAfter = 0;
  #error = null;

  constructor(options) {
    super();
    if (!options?.url) throw new Error("HlvConnection requires a gateway url");
    Object.assign(this, {
      url: String(options.url), token: options.token ?? null,
      sessionId: options.sessionId ?? null, pinnedSessionId: options.pinnedSessionId ?? null,
      log: options.log ?? (() => {}),
      pingIntervalMs: options.pingIntervalMs ?? 15_000, pongTimeoutMs: options.pongTimeoutMs ?? 10_000,
      backoffBaseMs: options.backoffBaseMs ?? 1000, backoffMaxMs: options.backoffMaxMs ?? 30_000,
      jitterMs: options.jitterMs ?? 250, connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      disconnectTimeoutMs: options.disconnectTimeoutMs ?? 2000,
      prepareSession: options.prepareSession, commitSession: options.commitSession,
      desired: false, state: "idle", client: null,
    });
  }

  get generation() { return this.#generation; }
  get session() { return this.client?.session; }
  get connected() { return this.state === "ready" && Boolean(this.client?.connected); }
  #state(state) {
    if (this.state === state) return;
    const previous = this.state;
    this.state = state;
    this.emit("state", { state, previous });
  }

  async start() {
    if (this.desired || this.state === "halted") return;
    this.desired = true;
    this.#attempt();
  }

  async stop(reason = "bridge shutdown") {
    this.desired = false;
    const generation = ++this.#generation;
    this.#abort?.abort();
    clearTimeout(this.#retry);
    this.#retry = null;
    this.#stopPing();
    const client = this.client;
    const socket = this.#socket;
    this.client = null;
    this.#socket = null;
    this.emit("disconnected", { reason });
    if (this.state !== "halted") this.#state("idle");
    let timer;
    try {
      if (client) await Promise.race([
        client.disconnect(reason),
        new Promise((resolve) => { timer = setTimeout(resolve, this.disconnectTimeoutMs); }),
      ]);
    } catch { this.log("gateway disconnect failed"); }
    finally {
      clearTimeout(timer);
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }
    return generation;
  }

  async adoptSessionId(sessionId, { pinned = false } = {}) {
    this.sessionId = sessionId ?? null;
    this.pinnedSessionId = pinned ? sessionId : null;
  }

  async rebind(sessionId, options = {}) {
    const active = this.desired;
    const generation = await this.stop("rebind");
    if (generation !== this.#generation) return;
    await this.adoptSessionId(sessionId, options);
    if (generation === this.#generation && active && this.state !== "halted") await this.start();
  }

  // Only explicit user recovery clears a nonrecoverable transport halt.
  resetHalt() { if (this.state === "halted") this.#state("idle"); }

  waitReady({ signal, timeoutMs = 12_000 } = {}) {
    if (signal?.aborted) return Promise.reject(new Error("Call superseded"));
    if (this.connected) return Promise.resolve(this.session);
    return new Promise((resolve, reject) => {
      const finish = (err, ready) => {
        clearTimeout(timer);
        this.off("ready", readyHandler); this.off("halted", halted);
        this.off("disconnected", disconnected);
        signal?.removeEventListener("abort", aborted);
        err ? reject(err) : resolve(ready);
      };
      const readyHandler = (ready) => finish(null, ready);
      const halted = () => finish(new Error("Gateway halted; saved conversation preserved"));
      const disconnected = () => finish(new Error("Gateway disconnected"));
      const aborted = () => finish(new Error("Call superseded"));
      const timer = setTimeout(() => finish(new Error("Gateway is reconnecting; saved conversation preserved")), timeoutMs);
      this.on("ready", readyHandler); this.on("halted", halted); this.on("disconnected", disconnected);
      signal?.addEventListener("abort", aborted, { once: true });
      if (this.state === "halted") halted();
    });
  }

  sendAudio(data, mimeType) { return this.connected ? this.client.sendAudio(data, mimeType) : undefined; }
  endAudio() { return this.connected ? this.client.endAudio() : undefined; }
  cancelResponse(reason, truncate) { return this.connected ? this.client.cancelResponse(reason, truncate) : undefined; }
  sendText(text) { return this.connected ? this.client.sendText(text) : undefined; }

  #attempt() {
    if (!this.desired || this.state === "halted") return;
    const generation = ++this.#generation;
    this.#abort?.abort();
    const abort = this.#abort = new AbortController();
    const current = () => this.desired && generation === this.#generation && !abort.signal.aborted;
    this.#error = null;
    this.#state("connecting");
    this.#run(abort.signal, current).catch((err) => {
      if (!current()) return;
      this.#stopPing();
      this.client = null;
      this.#socket?.terminate();
      this.#socket = null;
      this.emit("disconnected", { reason: "attempt failed" });
      if (this.#error?.recoverable === false) {
        this.#halt(`gateway rejected the session (${this.#error.code})`);
        return;
      }
      this.log("gateway connection failed; preserving selected conversation");
      this.emit("attempt-failed", { error: err, sessionId: this.sessionId });
      this.#schedule();
    });
  }

  async #run(signal, current) {
    const target = this.prepareSession ? await this.prepareSession(signal) : this.sessionId;
    if (!current()) return;
    this.#error = null;
    const conversation = target ? { mode: "resume", sessionId: target } : { mode: "new" };
    const client = new HermesLiveClient({
      url: this.url, connectTimeoutMs: this.connectTimeoutMs, disconnectTimeoutMs: this.disconnectTimeoutMs,
      webSocketFactory: (url) => {
        const socket = new WebSocket(url, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {} });
        socket.on("unexpected-response", (_req, res) => {
          if (current()) {
            const seconds = Number(res.headers["retry-after"]);
            if (Number.isFinite(seconds) && seconds > 0) this.#retryAfter = seconds * 1000;
            this.log(`gateway refused connection (HTTP ${res.statusCode})`);
          }
          res.resume(); socket.terminate();
        });
        socket.on("pong", () => {
          if (!current()) return;
          clearTimeout(this.#pong); this.#pong = null;
        });
        this.#socket = socket;
        return socket;
      },
    });
    this.client = client;
    const live = () => current() && client === this.client;
    const pendingEvents = [];
    let pendingBytes = 0;
    let pendingOverflow = false;
    for (const type of EVENTS) client.on(type, (event) => {
      if (!live()) return;
      if (this.state === "ready") this.emit(type, event);
      else if (!pendingOverflow) {
        pendingBytes += JSON.stringify(event).length;
        if (pendingEvents.length >= 200 || pendingBytes > 2_000_000) pendingOverflow = true;
        else pendingEvents.push([type, event]);
      }
    });
    client.on("error", (event) => { if (live()) this.emit("client-error", event); });
    client.on("session.error", (event) => {
      if (!live()) return;
      this.#error = event;
      this.emit("session.error", event);
      if (event.recoverable === false && this.state === "ready") this.#halt(`gateway reported error (${event.code})`);
    });
    client.on("close", (event) => {
      if (!live() || this.state !== "ready") return;
      this.#stopPing();
      this.emit("disconnected", event);
      if (event.code === 1008) this.#halt(`gateway closed connection (${event.code})`);
      else {
        this.client = null;
        this.#schedule();
      }
    });
    const ready = await client.connect({ conversation, signal });
    if (!live()) return;
    await this.commitSession?.(ready, signal);
    if (!live()) return;
    if (!client.connected) throw new Error("Gateway closed during readiness commit");
    if (pendingOverflow) throw new Error("Gateway events exceeded startup buffer");
    this.sessionId = ready.conversation?.sessionId ?? target;
    this.#failures = 0;
    this.#retryAfter = 0;
    this.#state("ready");
    this.#startPing(this.#socket);
    this.emit("ready", ready);
    for (const [type, event] of pendingEvents) {
      if (!live()) break;
      this.emit(type, event);
    }
  }

  #schedule() {
    if (!this.desired || this.state === "halted" || this.#retry) return;
    const delayMs = Math.max(Math.min(this.backoffBaseMs * 2 ** this.#failures++, this.backoffMaxMs)
      + Math.floor(Math.random() * this.jitterMs), this.#retryAfter);
    this.#retryAfter = 0;
    this.#state("backoff");
    this.emit("backoff", { delayMs, failures: this.#failures });
    this.#retry = setTimeout(() => { this.#retry = null; this.#attempt(); }, delayMs);
    this.#retry.unref?.();
  }

  #halt(reason) {
    this.#state("halted");
    void this.stop(reason);
    this.emit("halted", { reason });
  }

  #startPing(socket) {
    this.#stopPing();
    this.#ping = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.ping();
      if (!this.#pong) this.#pong = setTimeout(() => {
        this.#pong = null;
        this.emit("ping-timeout"); socket.terminate();
      }, this.pongTimeoutMs);
      this.#pong?.unref?.();
    }, this.pingIntervalMs);
    this.#ping.unref?.();
  }
  #stopPing() {
    clearInterval(this.#ping); clearTimeout(this.#pong);
    this.#ping = this.#pong = null;
  }
}
