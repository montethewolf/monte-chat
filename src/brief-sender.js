import { buildBrief } from "./brief.js";

export class BriefSender {
  constructor({ conn, controller, status, enabled = true, ttlMs = 900_000, maxChars = 1800, log = () => {} }) {
    Object.assign(this, { conn, controller, status, enabled, ttlMs, maxChars, log });
    this.lastAt = 0; this.lastKey = null;
  }
  async send(ready, force = false) {
    const { conn, controller } = this;
    if (!this.enabled || !conn?.connected) return false;
    const sid = ready?.conversation?.sessionId ?? conn.sessionId;
    // Focus and default can legitimately select the same Hermes session.
    const key = JSON.stringify([sid, controller.focusState?.threadId ?? null]);
    if (!force && key === this.lastKey && Date.now() - this.lastAt < this.ttlMs) return false;
    const generation = conn.generation;
    const callGeneration = controller.generation;
    const focus = structuredClone(controller.focusState);
    const data = await this.status.snapshot(force);
    if (generation !== conn.generation || callGeneration !== controller.generation || !conn.connected) return false;
    const brief = buildBrief({ ...data, now: new Date(), focus, maxChars: this.maxChars });
    const sent = conn.session?.protocolVersion >= 7 ? conn.sendContext(brief) : conn.sendText(brief);
    if (sent === undefined) return false;
    this.lastKey = key; this.lastAt = Date.now();
    this.log(`brief sent (${brief.length} chars)`);
    return true;
  }
}
