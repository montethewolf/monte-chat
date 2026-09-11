// hlv-discord entry point: Discord client, slash commands, voice wiring, and
// the audio player loop. All protocol/DSP logic lives in bridge.js/hlv-conn.js.
// Run with:  node --env-file ~/.config/hlv-discord/env src/index.js [--loopback]

import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import {
  EndBehaviorType,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  entersState,
  generateDependencyReport,
  joinVoiceChannel,
} from "@discordjs/voice";
import mediaplex from "mediaplex";
import { HlvConnection } from "./hlv-conn.js";
import { Bridge } from "./bridge.js";
import { Decimator, Interpolator, monoToStereo, stereoToMono } from "./resample.js";
import { BriefSender } from "./brief-sender.js";
import { watchMirrorMode } from "./mirror-watch.js";
import { Playback } from "./playback.js";
import { SessionStore } from "./session-store.js";
import { StatusReader } from "./status-reader.js";
import { DiscussionControls } from "./discussion-controls.js";
import { DeliveryQueue } from "./delivery.js";
import { CallController } from "./call-controller.js";
import { MirrorFilter, loadMirrorMode, normalizeMirrorMode, saveMirrorMode } from "./mirror.js";

const { OpusEncoder } = mediaplex;

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

function readConfig() {
  const missing = ["DISCORD_TOKEN", "DISCORD_APP_ID", "DISCORD_GUILD_ID", "DISCORD_USER_ID"].filter(
    (name) => !process.env[name],
  );
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
  return {
    token: process.env.DISCORD_TOKEN,
    appId: process.env.DISCORD_APP_ID,
    guildId: process.env.DISCORD_GUILD_ID,
    userId: process.env.DISCORD_USER_ID,
    hlvUrl: process.env.HLV_URL ?? "ws://127.0.0.1:8788/v1/live",
    hlvToken: process.env.HLV_TOKEN || null,
    stateFile:
      process.env.HLV_STATE_FILE ?? join(homedir(), ".local", "state", "hlv-discord", "state.json"),
    silenceMs: Number(process.env.DISCORD_SILENCE_MS ?? 500),
    endPadMs: Number(process.env.HLV_END_PAD_MS ?? 240),
    mirrorDefault: normalizeMirrorMode(process.env.MIRROR_TRANSCRIPTS),
    mirrorStateFile:
      process.env.MIRROR_STATE_FILE ??
      join(homedir(), ".local", "state", "hlv-discord", "mirror.json"),
    textChannelId: process.env.DISCORD_TEXT_CHANNEL_ID || null,
    loopback: process.argv.includes("--loopback"),
    // Hermes state read-only paths (focus resolution + the call-start brief)
    hermesHome: process.env.HERMES_HOME ?? join(homedir(), ".hermes"),
    focusStateFile:
      process.env.FOCUS_STATE_FILE ?? join(homedir(), ".local", "state", "hlv-discord", "focus.json"),
    briefEnabled: !/^(0|false|no)$/i.test(process.env.BRIEF_ENABLED ?? ""),
    briefMaxChars: Number(process.env.BRIEF_MAX_CHARS ?? 1800),
    briefTtlMin: Number(process.env.BRIEF_TTL_MIN ?? 15),
  };
}

function hermesPaths(cfg) {
  const home = cfg.hermesHome;
  return {
    stateDb: process.env.HERMES_STATE_DB ?? join(home, "state.db"),
    kanbanDb: process.env.HERMES_KANBAN_DB ?? join(home, "kanban.db"),
    cronDb: process.env.HERMES_CRON_DB ?? join(home, "cron", "executions.db"),
    cronJobs: process.env.HERMES_CRON_JOBS ?? join(home, "cron", "jobs.json"),
    gatewayState: process.env.HERMES_GATEWAY_STATE ?? join(home, "gateway_state.json"),
  };
}

// Minimal stand-in for Bridge used by `--loopback`: echoes each utterance back
// through the full DSP chain (decode -> downmix -> decimate -> interpolate ->
// stereo -> encode) without touching HLV. Proves the whole audio path in M2.
class LoopbackBridge extends EventEmitter {
  #queue = [];
  #utteranceActive = false;

  get playerShouldRun() {
    return this.#queue.length > 0;
  }

  get inputEnabled() {
    return true;
  }

  clearMicPause() {}
  reset() { this.#queue = []; this.#utteranceActive = false; this.emit("player-stop"); }
  onSpeakingStart() {}

  beginUtterance() {
    if (this.#utteranceActive) return null;
    this.#utteranceActive = true;
    const decoder = new OpusEncoder(48000, 2);
    const encoder = new OpusEncoder(48000, 2);
    const decimator = new Decimator();
    const interpolator = new Interpolator();
    let pcm24k = new Int16Array(0);
    return {
      write: (packet) => {
        try {
          const stereo = decoder.decode(packet);
          const view = new Int16Array(
            stereo.buffer.slice(stereo.byteOffset, stereo.byteOffset + (stereo.length & ~1)),
          );
          const down = decimator.process(stereoToMono(view));
          const merged = new Int16Array(pcm24k.length + down.length);
          merged.set(pcm24k, 0);
          merged.set(down, pcm24k.length);
          pcm24k = merged;
        } catch (err) {
          log(`loopback decode failed: ${err.message}`);
        }
      },
      end: () => {
        this.#utteranceActive = false;
        const stereo = monoToStereo(interpolator.process(pcm24k));
        for (let o = 0; o + 1920 <= stereo.length; o += 1920) {
          const frame = stereo.subarray(o, o + 1920);
          this.#queue.push(encoder.encode(Buffer.from(frame.buffer, frame.byteOffset, 3840)));
        }
        log(`loopback: echoing ${this.#queue.length} packets`);
        if (this.#queue.length > 0) this.emit("player-run");
      },
      abort: () => {
        this.#utteranceActive = false;
      },
    };
  }

  nextPacket() {
    return this.#queue.shift() ?? null;
  }
}

async function main() {
  const cfg = readConfig();
  const paths = hermesPaths(cfg);
  const store = new SessionStore(cfg.stateFile, cfg.focusStateFile);
  await store.load();
  const status = new StatusReader({ paths, hlvUrl: cfg.hlvUrl, hlvToken: cfg.hlvToken, log });
  const mirror = new MirrorFilter((await loadMirrorMode(cfg.mirrorStateFile)) ?? cfg.mirrorDefault);
  if (store.value.focus) log("saved thread focus restored");

  // Boot check: DAVE (Discord E2EE) native binding must load, or every voice
  // join will fail as an opaque rejoin loop.
  try {
    await import("@snazzah/davey");
  } catch (err) {
    console.error(`FATAL: @snazzah/davey failed to load (${err.message})`);
    console.error(generateDependencyReport());
    process.exit(1);
  }
  log("boot checks passed");
  log(generateDependencyReport());

  let conn = null;
  let bridge;
  if (cfg.loopback) {
    bridge = new LoopbackBridge();
    log("running in --loopback echo mode (no HLV connection)");
  } else {
    conn = new HlvConnection({
      url: cfg.hlvUrl,
      token: cfg.hlvToken,
      sessionId: store.value.focus?.sessionId ?? store.value.defaultSessionId,
      log,
    });
    bridge = new Bridge({ conn, endPadMs: cfg.endPadMs, log });
    conn.on("ready", (ready) => {
      log("HLV session ready");
      briefSender.send(ready).catch(() => log("brief unavailable"));
    });
    let resumeNoticeSent = false;
    conn.on("attempt-failed", () => {
      if (!resumeNoticeSent) postText("Voice reconnecting; saved conversation preserved. Use /new-conversation only to start fresh.");
      resumeNoticeSent = true;
    });
    conn.on("ready", () => { resumeNoticeSent = false; });
    conn.on("backoff", ({ delayMs, failures }) =>
      log(`HLV reconnect in ${delayMs}ms (failure #${failures})`),
    );
    conn.on("halted", ({ reason }) => {
      log(`HLV connection halted: ${reason}`);
      postText("Voice bridge halted; saved conversation preserved. Check service logs, or use /new-conversation to start fresh.");
    });
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 5 },
  });
  const playback = new Playback({ bridge, player, log });

  let boundChannelId = cfg.textChannelId; // text channel for mirrored messages
  let autoFollow = true; // /leave suppresses following until /join or a fresh session

  const controller = new CallController({
    conn, bridge, playback, store, status, attachVoice, notice: (text) => postText(text), log,
  });
  const delivery = new DeliveryQueue({
    mode: () => mirror.mode, log,
    send: async (target, message) => {
      const channel = await client.channels.fetch(target);
      if (typeof channel?.send !== "function") throw Object.assign(new Error("Unavailable text destination"), { status: 404 });
      await channel.send(message);
    },
  });
  function mirrorTarget() {
    return controller.focusState?.threadId ?? boundChannelId ?? controller.desiredChannel?.id;
  }
  function postText(text, options = {}) {
    delivery.enqueue({ text, target: mirrorTarget(), ...options });
  }

  if (conn) conn.prepareOrigin = (selection) => {
    const focus = selection ? selection.focus : controller.focusState;
    const channelId = boundChannelId ?? controller.desiredChannel?.id;
    return channelId ? { guildId: cfg.guildId, userId: cfg.userId, channelId, ...(focus?.threadId ? { threadId: focus.threadId } : {}) } : undefined;
  };
  const discussionControls = conn ? new DiscussionControls({ conn, client, userId: cfg.userId, guildId: cfg.guildId,
    target: mirrorTarget, stateFile: `${cfg.stateFile}.posts.json`, log }) : null;

  const briefSender = new BriefSender({ conn, controller, status, enabled: cfg.briefEnabled,
    ttlMs: cfg.briefTtlMin * 60_000, maxChars: cfg.briefMaxChars, log });

  bridge.on("text", ({ kind, speaker, text, key }) => {
    if (kind === "transcript") {
      for (const line of mirror.decide(speaker, text)) postText(line, { kind: "transcript" });
      return;
    }
    const sensitive = kind === "task" || kind === "notification";
    postText(`**${kind}**: ${text}`, { kind: sensitive ? "content" : "operational", key });
  });

  const mirrorWatcher = await watchMirrorMode(cfg.mirrorStateFile, (mode) => {
    if (mode === mirror.mode) return;
    mirror.setMode(mode);
    delivery.policyChanged();
    postText(`**status**: voice conversation to text ${mode}`);
  }, { log }).catch(() => { log("mirror watcher unavailable; /mirror still works"); return null; });

  async function attachVoice(channel, signal, onLost) {
    const connection = joinVoiceChannel({
      channelId: channel.id, guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: false,
    });
    const abortJoin = () => { if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy(); };
    signal.addEventListener("abort", abortJoin, { once: true });
    let active = null;
    const cleanup = () => {
      const current = active;
      active = null;
      current?.sink.abort();
      current?.stream.destroy();
    };
    const receive = (userId) => {
      if (userId !== cfg.userId || (conn && !conn.connected)) return;
      const sink = bridge.beginUtterance();
      if (!sink) return;
      const stream = connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: cfg.silenceMs },
      });
      const capture = active = { sink, stream };
      stream.on("data", (packet) => sink.write(packet));
      stream.once("end", () => { if (active === capture) { active = null; sink.end(); } });
      stream.once("close", () => { if (active === capture) { active = null; sink.abort(); } });
      stream.on("error", () => {
        if (active !== capture) return;
        cleanup(); log("voice receive stream failed; reconnecting input");
        // A partial upstream utterance has no clear-buffer API; detach it
        // before accepting another one so unrelated speech is never combined.
        if (controller.voice === connection) {
          controller.recoverVoice(connection, (recoverySignal) =>
            entersState(connection, VoiceConnectionStatus.Ready, recoverySignal)).catch(() => {});
        }
      });
    };
    connection.receiver.speaking.on("start", receive);
    connection.once(VoiceConnectionStatus.Destroyed, () => {
      cleanup(); connection.receiver.speaking.off("start", receive);
    });
    const inputError = () => active?.stream.destroy(new Error("speech detector failed"));
    bridge.on("input-error", inputError);
    connection.once(VoiceConnectionStatus.Destroyed, () => bridge.off("input-error", inputError));
    connection.on("stateChange", (old, next) => {
      if (old.status !== next.status) bridge.diagnostic?.("discord_state", { from: old.status, to: next.status });
    });
    connection.on("error", () => log("Discord voice connection error"));
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      if (controller.voice === connection) {
        controller.recoverVoice(connection, (recoverySignal) =>
          entersState(connection, VoiceConnectionStatus.Ready, recoverySignal)).catch(() => {});
      }
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      signal.throwIfAborted();
      connection.subscribe(player);
      return { voice: connection, cleanup };
    } catch (err) { cleanup(); abortJoin(); throw err; }
    finally { signal.removeEventListener("abort", abortJoin); }
  }

  async function joinChannel(channel) { await controller.join(channel); }
  async function leaveVoice(reason) { await controller.leave(reason); }

  // Follow the allowed user's voice presence: join when they join, move when
  // they move, leave when they leave. Slash commands remain manual overrides.
  client.on("voiceStateUpdate", async (oldState, newState) => {
    if (newState.id !== cfg.userId) return;
    if (newState.guild.id !== cfg.guildId) return;
    try {
      if (newState.channel) {
        if (!autoFollow) return;
        if (controller.voice && controller.voice.joinConfig.channelId === newState.channel.id) return; // mute/deafen churn
        log("following user into voice");
        await joinChannel(newState.channel);
      } else if (oldState.channelId) {
        autoFollow = true; // a fresh voice session follows again after a manual /leave
        await leaveVoice("user left voice");
      }
    } catch (err) {
      log(`voice follow failed: ${err.message}`);
    }
  });

  async function handleJoin(interaction) {
    const channel = interaction.member?.voice?.channel;
    if (!channel) {
      await interaction.reply({
        content: "Join a voice channel first, then run /join.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    autoFollow = true;
    boundChannelId = interaction.channelId;
    await joinChannel(channel);
    await interaction.editReply(cfg.loopback ? "Joined in loopback mode — speak and I echo." : "Listening.");
  }

  async function handleLeave(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    autoFollow = false; // stay away until /join or the user re-enters voice fresh
    await leaveVoice("user dismissed the bridge");
    await interaction.editReply("Left.");
  }

  async function handleFocus(interaction) {
    // Rebind takes seconds; the 3s interaction window would otherwise expire.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.channel?.isThread?.()) {
      await interaction.editReply("Run /focus inside a thread.");
      return;
    }
    await controller.focus(interaction.channelId);
    const focus = controller.focusState;
    await interaction.editReply(controller.ready
      ? `Focused: voice continues **${focus.title ?? "this thread"}**. Mirror posts here.`
      : "Focused: the next voice call will continue this thread. Mirror will post here.");
  }

  async function handleUnfocus(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!controller.focusState) { await interaction.editReply("Not focused."); return; }
    await controller.unfocus();
    await interaction.editReply("Unfocused — default voice conversation selected.");
  }

  async function handleNewConversation(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await controller.newConversation();
    await interaction.editReply(controller.ready ? "Started a fresh voice conversation; focus cleared. Background tasks continue."
      : "The next voice call will start fresh; focus cleared. Background tasks continue.");
  }

  async function handleBrief(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!conn?.connected) {
      await interaction.editReply("Not on a call — the brief is sent when a voice session starts.");
      return;
    }
    const sent = await briefSender.send(null, true);
    await interaction.editReply(sent ? "Brief re-sent." : "Brief not sent: disabled or call changed.");
  }

  async function handleMode(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const state = await controller.mode(interaction.options.getString('mode') ?? undefined, interaction.options.getString('project') ?? undefined);
      await interaction.editReply(`Mode: **${state.interactionMode}**. Project: **${state.project ?? 'none selected'}**. Investigation: ${state.investigation ?? 'none'}.${state.ongoingWork ? ` ${state.ongoingWork} Work task(s) continue.` : ''}`);
    } catch (error) { await interaction.editReply(error.message); }
  }

  async function handleMirror(interaction) {
    const requested = interaction.options.getString("mode");
    if (!requested) {
      await interaction.reply({
        content: `Post voice conversation to text: **${mirror.mode}**. Off still allows connection/status notices. Undelivered notices this run: ${delivery.failures}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const mode = mirror.setMode(requested);
    delivery.policyChanged();
    await saveMirrorMode(cfg.mirrorStateFile, mode);
    await interaction.editReply(`Post voice conversation to text: **${mode}**. ${mode === "on" ? "Your words, replies, and task results will post to the selected channel." : "Only connection/status notices will post."}`);
  }

  client.on("interactionCreate", async (interaction) => {
    if (interaction.isButton()) {
      try { await discussionControls?.interaction(interaction); } catch { log('Command approval interaction failed'); }
      return;
    }
    if (!interaction.isChatInputCommand() || interaction.guildId !== cfg.guildId) return;
    if (interaction.user.id !== cfg.userId) {
      await interaction.reply({ content: "Not for you, sorry.", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      if (interaction.commandName === "join") await handleJoin(interaction);
      else if (interaction.commandName === "leave") await handleLeave(interaction);
      else if (interaction.commandName === "focus") await handleFocus(interaction);
      else if (interaction.commandName === "unfocus") await handleUnfocus(interaction);
      else if (interaction.commandName === "brief") await handleBrief(interaction);
      else if (interaction.commandName === "new-conversation") await handleNewConversation(interaction);
      else if (interaction.commandName === "mode") await handleMode(interaction);
      else if (interaction.commandName === "mirror") await handleMirror(interaction);
    } catch (err) {
      log(`command ${interaction.commandName} failed: ${err.message}`);
      if (interaction.deferred && !interaction.replied) {
        await interaction.editReply("That failed; check the logs.").catch(() => {});
      } else if (!interaction.replied) {
        await interaction
          .reply({ content: "That failed; check the logs.", flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    }
  });

  const rest = new REST().setToken(cfg.token);
  await rest.put(Routes.applicationGuildCommands(cfg.appId, cfg.guildId), {
    body: [
      new SlashCommandBuilder().setName('mode').setDescription('Inspect or change Work/Brainstorm mode during a voice call')
        .addStringOption(o => o.setName('mode').setDescription('Conversation mode').addChoices({ name: 'work', value: 'work' }, { name: 'brainstorm', value: 'brainstorm' }))
        .addStringOption(o => o.setName('project').setDescription('Registered project name for the discussion')),
      new SlashCommandBuilder().setName("join").setDescription("Join your voice channel and listen"),
      new SlashCommandBuilder().setName("leave").setDescription("Leave the voice channel"),
      new SlashCommandBuilder().setName("new-conversation").setDescription("Explicitly start fresh and clear focus; background tasks continue"),
      new SlashCommandBuilder()
        .setName("focus")
        .setDescription("Bind the voice call to this thread's Hermes conversation"),
      new SlashCommandBuilder()
        .setName("unfocus")
        .setDescription("Return the voice call to its default conversation"),
      new SlashCommandBuilder()
        .setName("brief")
        .setDescription("Re-send Monte's status brief to the voice session"),
      new SlashCommandBuilder()
        .setName("mirror")
        .setDescription("Post voice conversation to text (no mode: show current)")
        .addStringOption((o) =>
          o
            .setName("mode")
            .setDescription("On: conversation and task results. Off: connection/status notices only.")
            .addChoices(
              { name: "on", value: "on" },
              { name: "off", value: "off" },
            ),
        ),
    ].map((c) => c.toJSON()),
  });
  log("slash commands registered");

  client.once("clientReady", async () => {
    log(`discord ready as ${client.user.tag}`);
    try {
      const guild = await client.guilds.fetch(cfg.guildId);
      const state = guild.voiceStates.cache.get(cfg.userId);
      if (state?.channel) {
        log("user already in voice; joining");
        await joinChannel(state.channel);
      }
    } catch (err) {
      log(`startup voice check failed: ${err.message}`);
    }
  });
  await client.login(cfg.token);

  async function shutdown(signal) {
    log(`${signal} received; shutting down`);
    mirrorWatcher?.close();
    delivery.close();
    await controller.close().catch(() => {});
    await client.destroy().catch(() => {});
    process.exit(0);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
