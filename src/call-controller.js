import { newDiscussionId, discussionIdForSelection } from "./session-store.js";
// Owns user intent, voice resources, and committed session selection. Transports
// and state readers are injected so races can be exercised without Discord.
export class CallController {
  constructor({ conn, bridge, playback, store, status, attachVoice, notice = () => {},
    log = () => {}, retryBaseMs = 1000, retryMaxMs = 30_000 }) {
    Object.assign(this, { conn, bridge, playback, store, status, attachVoice, notice, log, retryBaseMs, retryMaxMs });
    this.selection = structuredClone(store.value);
    this.voice = null; this.desiredChannel = null; this.receiverCleanup = null;
    this.tail = Promise.resolve(); this.abort = new AbortController(); this.generation = 0;
    this.retryFailures = 0;
    if (conn) {
      conn.prepareDiscussion = () => discussionIdForSelection(this.selection);
      conn.prepareSession = async (signal) => {
        const focus = this.selection.focus;
        if (focus) {
          const resolved = await status.resolve(focus.threadId, signal);
          signal.throwIfAborted();
          return resolved?.sessionId ?? focus.sessionId;
        }
        return this.selection.defaultSessionId;
      };
      conn.commitSession = async (ready, signal) => {
        signal.throwIfAborted();
        const next = structuredClone(this.selection);
        const sid = ready.conversation?.sessionId;
        if (!sid) throw new Error("Gateway did not identify its conversation");
        if (next.focus) next.focus.sessionId = sid;
        else next.defaultSessionId = sid;
        await store.save(next, { signal });
        signal.throwIfAborted();
        this.selection = next;
      };
      conn.on("disconnected", () => { this.receiverCleanup?.(); bridge.reset(); playback.stop(); });
    }
  }
  get focusState() { return this.store.value.focus; }
  get ready() { return this.voice?.state?.status === "ready" && (!this.conn || this.conn.connected); }

  operate(action, { destroyVoice = false } = {}) {
    this.abort.abort();
    const abort = this.abort = new AbortController();
    const generation = ++this.generation;
    clearTimeout(this.retryTimer);
    this.receiverCleanup?.();
    this.bridge.reset?.(); this.playback.stop();
    const stopped = this.conn?.stop("call transition") ?? Promise.resolve();
    if (destroyVoice) this.destroyVoice();
    const operation = this.tail.catch(() => {}).then(async () => {
      await stopped;
      abort.signal.throwIfAborted();
      return action(abort.signal, generation);
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  destroyVoice() {
    const voice = this.voice;
    this.voice = null;
    this.receiverCleanup?.(); this.receiverCleanup = null;
    if (voice && voice.state?.status !== "destroyed") voice.destroy();
  }

  async connectHlv(signal) {
    if (!this.conn) return;
    await this.conn.adoptSessionId(this.selection.focus?.sessionId ?? this.selection.defaultSessionId,
      { pinned: Boolean(this.selection.focus) });
    signal.throwIfAborted();
    await this.conn.start();
    await this.conn.waitReady({ signal });
    signal.throwIfAborted();
  }

  join(channel) {
    this.desiredChannel = channel;
    return this.operate(async (signal) => {
      try {
        const attached = await this.attachVoice(channel, signal, (voice) => this.connectionLost(voice));
        if (signal.aborted) { attached.cleanup?.(); attached.voice.destroy(); signal.throwIfAborted(); }
        this.voice = attached.voice;
        this.receiverCleanup = attached.cleanup;
        this.retryFailures = 0;
      } catch (err) {
        if (!signal.aborted) this.scheduleRetry();
        throw err;
      }
      this.bridge.clearMicPause();
      this.selection = structuredClone(this.store.value);
      await this.connectHlv(signal);
    }, { destroyVoice: true });
  }

  leave(reason = "user left voice") {
    this.desiredChannel = null;
    return this.operate(async () => { this.log(reason); }, { destroyVoice: true });
  }

  recoverVoice(voice, waitReady) {
    if (this.voice !== voice) return Promise.resolve();
    return this.operate(async (signal) => {
      try {
        await waitReady(AbortSignal.any([signal, AbortSignal.timeout(5000)]));
        signal.throwIfAborted();
        this.selection = structuredClone(this.store.value);
        await this.connectHlv(signal);
      } catch (err) {
        if (signal.aborted) throw err;
        if (voice.state?.status === "ready") {
          // Discord recovered; the HLV wrapper owns its independent retries.
          this.notice("Voice gateway reconnecting; saved conversation preserved.");
          return;
        }
        this.destroyVoice();
        this.scheduleRetry();
        this.notice("Voice connection lost; reconnecting.");
      }
    });
  }

  connectionLost(voice) {
    if (this.voice !== voice) return;
    this.operate(async () => { this.scheduleRetry(); }, { destroyVoice: true }).catch(() => {});
    this.notice("Voice connection lost; reconnecting.");
  }

  scheduleRetry() {
    if (!this.desiredChannel) return;
    const delay = Math.min(this.retryBaseMs * 2 ** this.retryFailures++, this.retryMaxMs);
    this.retryTimer = setTimeout(() => {
      const channel = this.desiredChannel;
      if (channel) this.join(channel).catch(() => this.log("voice reconnection pending"));
    }, delay);
    this.retryTimer.unref?.();
  }

  changeSelection(makeSelection, { fresh = false } = {}) {
    if (this.ready && this.conn?.session?.protocolVersion >= 7 && this.conn.session.brainstormSupported) {
      return this.changeLiveSelection(makeSelection);
    }
    return this.operate(async (signal) => {
      const previous = structuredClone(this.store.value);
      try {
        const next = await makeSelection(previous, signal);
        signal.throwIfAborted();
        this.selection = next;
        if (fresh) this.conn?.resetHalt();
        if (!this.voice || !this.conn) {
          await this.store.save(next, { signal });
          return;
        }
        await this.connectHlv(signal);
      } catch (err) {
        if (signal.aborted) throw err;
        await this.conn?.stop("selection rollback");
        signal.throwIfAborted();
        this.selection = previous;
        if (JSON.stringify(this.store.value) !== JSON.stringify(previous)) {
          await this.store.save(previous, { signal });
        }
        await this.conn?.adoptSessionId(previous.focus?.sessionId ?? previous.defaultSessionId,
          { pinned: Boolean(previous.focus) });
        if (this.voice) await this.conn?.start(); // retains terminal halts; recoverable failures retry old target
        this.notice("Conversation switch failed; previous selection preserved.");
        throw err;
      }
    });
  }

  changeLiveSelection(makeSelection) {
    const generation = ++this.generation;
    const signal = this.abort.signal;
    const operation = this.tail.then(async () => {
      const previous = structuredClone(this.store.value);
      const next = await makeSelection(previous, signal);
      signal.throwIfAborted();
      const conversation = value => {
        const sid = value.focus?.sessionId ?? value.defaultSessionId;
        return sid ? { mode: 'resume', sessionId: sid } : { mode: 'new' };
      };
      try {
        const ready = await this.conn.setDiscussion(discussionIdForSelection(next), conversation(next));
        signal.throwIfAborted();
        if (generation !== this.generation) throw new Error('Call changed during context switch');
        if (next.focus) next.focus.sessionId = ready.conversation.sessionId;
        else next.defaultSessionId = ready.conversation.sessionId;
        await this.store.save(next, { signal });
        this.selection = next;
      } catch (error) {
        if (signal.aborted) throw error;
        await this.conn.setDiscussion(discussionIdForSelection(previous), conversation(previous)).catch(() => this.conn.stop('context rollback failed'));
        this.selection = previous;
        this.notice('Conversation switch failed; previous selection preserved.');
        throw error;
      }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  async mode(mode, project) {
    if (!this.ready || !this.conn) throw new Error('Join a voice call to inspect or change the active mode.');
    return this.conn.setMode(mode, { project });
  }

  focus(threadId) {
    return this.changeSelection(async (previous, signal) => {
      const resolved = await this.status.resolve(threadId, signal);
      if (!resolved) throw new Error("No Hermes session found for this thread, or its state is unavailable");
      return { ...previous, focus: { ...resolved, threadId, focusedAt: new Date().toISOString() } };
    });
  }
  unfocus() { return this.changeSelection((previous) => ({ ...previous, focus: null })); }
  newConversation() {
    return this.changeSelection(() => ({ version: 3, defaultDiscussionId: newDiscussionId(), defaultSessionId: null, focus: null }), { fresh: true });
  }
  async close() {
    await this.leave("service shutdown");
    this.playback.dispose();
    await this.status.close();
  }
}
