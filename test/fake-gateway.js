// Minimal protocol-v6 gateway for headless tests. Every outbound frame is
// self-validated with the SDK's own validateServerMessage so the fake cannot
// drift from what a real gateway is allowed to send.

import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { validateServerMessage } from "hermes-live-voice/browser";

let seq = 0;

function json(res, body) {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export class FakeGateway {
  constructor(options = {}) {
    this.conversations = options.conversations ?? [];
    this.behavior = {
      failStartTimes: 0, // reply session_start_failed (recoverable) N times
      failResumeOnce: false, // fail only the first resume attempt
      fatalStart: false, // reply recoverable:false to session.start
      capacity503Times: 0, // reject N upgrades with 503 + Retry-After
      retryAfterSeconds: 1,
      audioEnabled: true,
      ...options.behavior,
    };
    this.starts = []; // session.start messages, across connections
    this.messages = []; // every client message, across connections
    this.upgradeUrls = [];
    this.authHeaders = [];
    this.sockets = new Set();
    this.server = null;
    this.wss = null;
    this.port = 0;
  }

  get url() {
    return `ws://127.0.0.1:${this.port}/v1/live`;
  }

  async listen() {
    this.wss = new WebSocketServer({ noServer: true });
    this.server = createServer((req, res) => this.#onRequest(req, res));
    this.server.on("upgrade", (req, socket, head) => {
      this.upgradeUrls.push(req.url);
      this.authHeaders.push(req.headers.authorization ?? null);
      if (this.behavior.capacity503Times > 0) {
        this.behavior.capacity503Times -= 1;
        socket.end(
          "HTTP/1.1 503 Service Unavailable\r\n" +
            `Retry-After: ${this.behavior.retryAfterSeconds}\r\n` +
            "Connection: close\r\nContent-Length: 0\r\n\r\n",
        );
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.#setup(ws));
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    this.port = this.server.address().port;
    return this.port;
  }

  #onRequest(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/health") return json(res, { status: "ok", service: "hermes-live" });
    if (url.pathname === "/v1/conversations") {
      return json(res, { conversations: this.conversations });
    }
    res.statusCode = 404;
    res.end();
  }

  #setup(ws) {
    this.sockets.add(ws);
    ws.on("close", () => this.sockets.delete(ws));
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      this.messages.push(msg);
      this.onMessage?.(ws, msg);
      if (msg.type === "session.start") this.#onSessionStart(ws, msg);
      else if (msg.type === "session.close") ws.close(1000, "detached");
    });
  }

  #onSessionStart(ws, msg) {
    this.starts.push(msg);
    const conv = msg.conversation ?? { mode: "unbound" };
    if (this.behavior.fatalStart) {
      this.send(ws, {
        type: "session.error",
        code: "forbidden",
        message: "This client may not open sessions.",
        requestId: msg.id,
        recoverable: false,
      });
      return;
    }
    const failResume = this.behavior.failResumeOnce && conv.mode === "resume";
    if (this.behavior.failStartTimes > 0 || failResume) {
      if (failResume) this.behavior.failResumeOnce = false;
      else this.behavior.failStartTimes -= 1;
      this.send(ws, {
        type: "session.error",
        code: "session_start_failed",
        message: "Hermes did not accept the session.",
        requestId: msg.id,
        recoverable: true,
      });
      return;
    }
    seq += 1;
    const sessionId = conv.mode === "resume" ? conv.sessionId : `sess_${seq}`;
    this.send(ws, {
      type: "session.ready",
      protocolVersion: 6,
      requestId: msg.id,
      sessionId: `live_${seq}`,
      model: "fake-realtime",
      hermes: { model: "hermes-agent" },
      realtime: {
        provider: "openai",
        model: "fake-realtime",
        audio: {
          input: {
            enabled: this.behavior.audioEnabled,
            mimeType: "audio/pcm;rate=24000",
            recommendedFrameMs: 50,
          },
          output: { enabled: this.behavior.audioEnabled, mimeType: "audio/pcm;rate=24000" },
          turnDetection: "disabled",
        },
      },
      tasks: {
        scope: "owner",
        sequence: "per_task",
        reconnect: "snapshot",
        durable: true,
        parallel: false,
        maxConcurrent: 3,
        maxRetained: 200,
        supports: {
          list: true,
          get: true,
          stop: true,
          followUp: true,
          resume: false,
          notificationAck: true,
        },
      },
      conversation: { mode: conv.mode, sessionId },
    });
    this.send(ws, { type: "task.snapshot", reason: "initial", tasks: [], truncated: false });
  }

  send(ws, message) {
    validateServerMessage(message);
    ws.send(JSON.stringify(message));
  }

  broadcast(message) {
    for (const ws of this.sockets) this.send(ws, message);
  }

  kick(code = 1008, reason = "policy violation") {
    for (const ws of this.sockets) ws.close(code, reason);
  }

  // Simulate a dead peer: stop reading, so pings are never answered.
  pauseAll() {
    for (const ws of this.sockets) ws._socket.pause();
  }

  async close() {
    for (const ws of this.sockets) ws.terminate();
    this.wss?.close();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
