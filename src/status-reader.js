import { Worker } from "node:worker_threads";

export class StatusReader {
  constructor({ paths, hlvUrl, hlvToken, timeoutMs = 1500, refreshMs = 60_000, maxAgeMs = 300_000,
    workerFactory = () => new Worker(new URL("./status-worker.js", import.meta.url)), log = () => {} }) {
    Object.assign(this, { paths, hlvUrl, hlvToken, timeoutMs, maxAgeMs, workerFactory, log });
    this.pending = new Map(); this.serial = 0; this.closed = false;
    this.spawn();
    this.timer = setInterval(() => void this.refresh(), refreshMs);
    this.timer.unref?.();
    void this.refresh();
  }
  spawn() {
    if (this.closed) return;
    const worker = this.worker = this.workerFactory();
    worker.on("message", ({ id, value, error }) => {
      if (worker !== this.worker) return;
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id); clearTimeout(request.timer);
      error ? request.reject(new Error(error)) : request.resolve(value);
    });
    worker.on("error", () => this.restart(worker));
    worker.on("exit", () => { if (!this.closed) this.restart(worker); });
    worker.unref?.();
  }
  restart(worker) {
    if (worker !== this.worker) return;
    this.worker = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer); request.reject(new Error("Hermes status unavailable"));
    }
    this.pending.clear();
    const termination = worker.terminate();
    this.log("Hermes status worker unavailable; cached data retained");
    // Restart lazily on the next request to avoid crash loops.
    return termination;
  }
  request(method, args, signal) {
    if (this.closed) return Promise.reject(new Error("Status reader closed"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!this.worker) this.spawn();
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const worker = this.worker;
      const abort = () => {
        const request = this.pending.get(id);
        if (!request) return;
        clearTimeout(request.timer); this.pending.delete(id); fail(signal.reason);
      };
      const finish = (value) => { signal?.removeEventListener("abort", abort); resolve(value); };
      const fail = (err) => { signal?.removeEventListener("abort", abort); reject(err); };
      const timer = setTimeout(() => this.restart(worker), this.timeoutMs);
      this.pending.set(id, { resolve: finish, reject: fail, timer });
      signal?.addEventListener("abort", abort, { once: true });
      worker.postMessage({ id, method, args });
    });
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.request("snapshot", { paths: this.paths, hlvUrl: this.hlvUrl, hlvToken: this.hlvToken })
      .then((value) => { this.cache = value; this.cachedAt = Date.now(); })
      .catch(() => {}).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async snapshot(force = false) {
    if (force) await this.refresh();
    return this.cache && Date.now() - this.cachedAt < this.maxAgeMs ? this.cache : {};
  }
  async resolve(threadId, signal) {
    try { return await this.request("resolve", { stateDb: this.paths.stateDb, threadId }, signal); }
    catch (err) { if (signal?.aborted) throw err; return null; }
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    if (this.worker) await this.restart(this.worker);
  }
}
