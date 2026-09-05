import { randomBytes } from "node:crypto";
import { chunkText } from "./brief.js";

// Ordered in-memory delivery. No transcript bodies are written to logs/disk.
export class DeliveryQueue {
  constructor({ send, mode = () => "off", log = () => {}, capacity = 200, ttlMs = 300_000,
    retryMs = 1000, now = Date.now }) {
    Object.assign(this, { send, mode, log, capacity, ttlMs, retryMs, now });
    this.queue = []; this.seen = new Map(); this.failures = 0; this.running = null; this.closed = false;
  }
  allowed(kind) { return kind === "operational" || this.mode() === "on"; }
  enqueue({ text, target, kind = "operational", key }) {
    if (this.closed || !this.allowed(kind)) return;
    const now = this.now();
    for (const [id, at] of this.seen) if (now - at >= this.ttlMs) this.seen.delete(id);
    const identity = key ? `${target}:${key}` : null;
    if (identity && this.seen.has(identity)) return;
    if (!target || this.queue.length >= this.capacity) { this.failed(); return; }
    if (identity) {
      this.seen.set(identity, now);
      if (this.seen.size > 1000) this.seen.delete(this.seen.keys().next().value);
    }
    this.queue.push({ target, kind, createdAt: now, parts: chunkText(text).map((content) => ({
      content, allowedMentions: { parse: [] }, nonce: randomBytes(12).toString("hex"), enforceNonce: true,
    })), index: 0, attempts: 0 });
    this.kick();
  }
  failed() { this.failures++; this.log("Discord notice undelivered (destination, permission, capacity, or expiry)"); }
  policyChanged() { this.queue = this.queue.filter((entry) => this.allowed(entry.kind)); }
  kick() {
    if (!this.running && !this.closed) {
      this.running = this.drain().finally(() => {
        this.running = null;
        if (this.queue.length && !this.closed) this.kick();
      });
    }
  }
  async drain() {
    while (this.queue.length && !this.closed) {
      const entry = this.queue[0];
      if (!this.allowed(entry.kind)) { this.queue.shift(); continue; }
      if (this.now() - entry.createdAt >= this.ttlMs) { this.queue.shift(); this.failed(); continue; }
      try {
        await this.send(entry.target, entry.parts[entry.index]);
        // A policy change may have removed this entry while send was in flight.
        entry.index++; entry.attempts = 0;
        if (entry.index === entry.parts.length && this.queue[0] === entry) this.queue.shift();
      } catch (err) {
        const permanent = [403, 404].includes(err.status) || [50001, 50013, 10003].includes(Number(err.code));
        if (permanent || ++entry.attempts >= 3) {
          if (this.queue[0] === entry) this.queue.shift();
          this.failed();
        } else {
          await new Promise((resolve) => {
            this.wake = resolve;
            this.timer = setTimeout(resolve, this.retryMs * 2 ** (entry.attempts - 1));
          });
          this.wake = null;
        }
      }
    }
  }
  async idle() { while (this.running) await this.running; }
  close() { this.closed = true; this.queue = []; clearTimeout(this.timer); this.wake?.(); }
}
