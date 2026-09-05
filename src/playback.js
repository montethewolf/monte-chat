import { Readable } from "node:stream";
import { AudioPlayerStatus, StreamType, createAudioResource } from "@discordjs/voice";

// Discord's public resource counter measures packets consumed for sending,
// not receipt/playback on a remote device. Keep all dependency coupling here.
export class Playback {
  constructor({ bridge, player, log = () => {}, tickMs = 20 }) {
    this.bridge = bridge;
    this.player = player;
    this.log = log;
    this.resource = null;
    this.descriptors = [];
    this.credited = 0;
    this.stopping = false;
    bridge.playback = this;
    this.run = () => this.start();
    this.halt = () => this.stop();
    bridge.on("player-run", this.run);
    bridge.on("player-stop", this.halt);
    this.onState = (old, next) => {
      if (next.status !== AudioPlayerStatus.Idle) return;
      this.sync(old.resource);
      this.resource = null;
      this.descriptors = [];
      clearInterval(this.timer);
      if (!this.stopping) queueMicrotask(() => this.start());
    };
    player.on("stateChange", this.onState);
    this.onError = () => {
      log("audio player failed; cancelling pending playback");
      bridge.bargeIn("player_error");
    };
    player.on("error", this.onError);
    this.tickMs = tickMs;
  }

  get pending() { return this.descriptors.some((p) => p.sourceMs > 0); }

  sync(resource = this.resource) {
    if (!resource || resource !== this.resource) return;
    const count = Math.floor(resource.playbackDuration / 20);
    while (this.credited < count && this.descriptors.length) {
      this.bridge.markConsumed?.(this.descriptors.shift());
      this.credited++;
    }
  }

  start() {
    if (this.stopping || this.player.state.status !== AudioPlayerStatus.Idle || !this.bridge.playerShouldRun) return;
    this.descriptors = [];
    this.credited = 0;
    const stream = new Readable({
      objectMode: true,
      highWaterMark: 1,
      read: () => {
        const packet = this.bridge.nextPacket();
        if (!packet) { stream.push(null); return; }
        const descriptor = Buffer.isBuffer(packet) ? { opus: packet, sourceMs: 0 } : packet;
        this.descriptors.push(descriptor);
        stream.push(descriptor.opus);
      },
    });
    this.resource = createAudioResource(stream, { inputType: StreamType.Opus });
    this.player.play(this.resource);
    this.timer = setInterval(() => this.sync(), this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    this.stopping = true;
    this.sync();
    clearInterval(this.timer);
    this.player.stop(true);
    this.resource?.playStream.destroy();
    this.resource = null;
    this.descriptors = [];
    this.stopping = false;
  }

  dispose() {
    this.stop();
    this.bridge.off("player-run", this.run);
    this.bridge.off("player-stop", this.halt);
    this.player.off("stateChange", this.onState);
    this.player.off("error", this.onError);
    this.bridge.playback = null;
  }
}
