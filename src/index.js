// hlv-discord entry point: Discord client, slash commands, voice wiring, and
// the audio player loop. All protocol/DSP logic lives in bridge.js/hlv-conn.js.
// Run with:  node --env-file ~/.config/hlv-discord/env src/index.js [--loopback]

import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  generateDependencyReport,
  joinVoiceChannel,
} from "@discordjs/voice";
import mediaplex from "mediaplex";
import { HlvConnection } from "./hlv-conn.js";
import { Bridge } from "./bridge.js";
import { Decimator, Interpolator, monoToStereo, stereoToMono } from "./resample.js";
import { buildBrief, chunkText } from "./brief.js";
import {
  listRecentDiscordThreads,
  readActiveWork,
  readCron,
  readGatewayState,
  readKanban,
  resolveThreadSession,
} from "./hermes-status.js";
import { clearFocus, loadFocus, saveFocus } from "./focus.js";

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
    mirrorTranscripts: /^(1|true|yes)$/i.test(process.env.MIRROR_TRANSCRIPTS ?? ""),
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
  let focusState = await loadFocus(cfg.focusStateFile);
  if (focusState) log(`focus restored: thread ${focusState.threadId} ("${focusState.title ?? "?"}")`);

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
      stateFile: cfg.stateFile,
      pinnedSessionId: focusState?.sessionId ?? null,
      log,
    });
    bridge = new Bridge({ conn, endPadMs: cfg.endPadMs, log });
    conn.on("ready", (ready) => {
      log("HLV session ready");
      maybeSendBrief(ready).catch((err) => log(`brief failed: ${err.message}`));
    });
    conn.on("resume-fallback", ({ sessionId }) => {
      onFocusLost(sessionId).catch((err) => log(`focus-lost handling failed: ${err.message}`));
    });
    conn.on("backoff", ({ delayMs, failures }) =>
      log(`HLV reconnect in ${delayMs}ms (failure #${failures})`),
    );
    conn.on("halted", ({ reason }) => {
      log(`HLV connection halted: ${reason}`);
      postText(`Voice bridge halted: ${reason}. Restart the service to retry.`);
    });
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 5 },
  });
  player.on("error", (err) => log(`player error: ${err.message}`));

  let voice = null; // active VoiceConnection
  let boundChannelId = cfg.textChannelId; // text channel for mirrored messages
  let autoFollow = true; // /leave suppresses following until /join or a fresh session

  // Mirror target: the focused thread when focus is set, else the bound channel.
  async function postText(text) {
    const target = focusState?.threadId ?? boundChannelId;
    if (!target) return;
    try {
      const channel = await client.channels.fetch(target);
      for (const part of chunkText(text)) await channel.send(part);
    } catch (err) {
      log(`text mirror failed: ${err.message}`);
    }
  }

  // --- call-start brief -----------------------------------------------------

  let lastBriefedSessionId = null;
  let lastBriefAt = 0;

  async function gatherBriefData() {
    const threads = await listRecentDiscordThreads({
      hlvUrl: cfg.hlvUrl,
      hlvToken: cfg.hlvToken,
      stateDbPath: paths.stateDb,
    });
    return {
      now: new Date(),
      gateway: readGatewayState(paths.gatewayState),
      kanban: readKanban(paths.kanbanDb),
      cron: readCron(paths.cronDb, paths.cronJobs),
      activeWork: readActiveWork(paths.stateDb),
      threads,
      focus: focusState
        ? { title: focusState.title, messageCount: focusState.messageCount ?? null }
        : null,
      maxChars: cfg.briefMaxChars,
    };
  }

  async function maybeSendBrief(ready, force = false) {
    if (!cfg.briefEnabled || !conn) return;
    const sid = ready?.conversation?.sessionId ?? conn.sessionId ?? null;
    if (
      !force &&
      sid &&
      sid === lastBriefedSessionId &&
      Date.now() - lastBriefAt < cfg.briefTtlMin * 60_000
    ) {
      return; // transient reconnect on the same session: don't re-bill/re-speak
    }
    const brief = buildBrief(await gatherBriefData());
    if (conn.sendText(brief) === undefined) return; // not connected; next ready retries
    lastBriefedSessionId = sid;
    lastBriefAt = Date.now();
    log(`brief sent (${brief.length} chars${focusState ? ", focused" : ""})`);
  }

  async function onFocusLost(sessionId) {
    if (!focusState || focusState.sessionId !== sessionId) return;
    focusState = null;
    await clearFocus(cfg.focusStateFile);
    await postText(
      "Focus lost: couldn't resume that thread's session; started a fresh voice conversation.",
    );
  }

  bridge.on("text", ({ kind, text }) => {
    if (kind === "transcript" && !cfg.mirrorTranscripts) return;
    postText(kind === "transcript" ? text : `**${kind}**: ${text}`);
  });

  // Player runs only while the bridge has something to say; when nextPacket()
  // returns null the resource ends, the player idles, and the ring goes dark.
  bridge.on("player-run", () => {
    if (player.state.status !== AudioPlayerStatus.Idle) return;
    const stream = new Readable({
      objectMode: true,
      read() {
        this.push(bridge.nextPacket());
      },
    });
    player.play(createAudioResource(stream, { inputType: StreamType.Opus }));
  });
  bridge.on("player-stop", () => {
    if (player.state.status !== AudioPlayerStatus.Idle) player.stop(true);
  });

  function wireReceiver(connection) {
    const receiver = connection.receiver;
    receiver.speaking.on("start", (userId) => {
      if (userId !== cfg.userId) return;
      bridge.onSpeakingStart();
      const sink = bridge.beginUtterance();
      if (!sink) return;
      const stream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: cfg.silenceMs },
      });
      stream.on("data", (packet) => sink.write(packet));
      stream.once("end", () => sink.end());
      stream.on("error", (err) => {
        log(`receive stream error: ${err.message}`);
        sink.abort();
      });
    });
  }

  function watchConnection(connection) {
    const connectingTimes = [];
    connection.on("stateChange", (_oldState, newState) => {
      if (newState.status !== VoiceConnectionStatus.Connecting) return;
      const now = Date.now();
      connectingTimes.push(now);
      while (connectingTimes.length > 0 && connectingTimes[0] < now - 30_000) {
        connectingTimes.shift();
      }
      if (connectingTimes.length === 4) {
        // A DAVE/E2EE failure (close 4017) presents as an endless rejoin loop.
        log("voice connection is cycling — possible DAVE/E2EE failure");
        log(generateDependencyReport());
        postText("Voice connection is cycling; possible E2EE dependency problem. Check the logs.");
      }
    });
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        log("voice reconnecting");
      } catch {
        log("voice connection lost");
        if (voice === connection) voice = null;
        connection.destroy();
      }
    });
    connection.on("error", (err) => log(`voice error: ${err.message}`));
  }

  async function joinChannel(channel) {
    voice?.destroy();
    voice = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    watchConnection(voice);
    wireReceiver(voice);
    voice.subscribe(player);
    bridge.clearMicPause();
    if (conn) await conn.start();
    log(`joined voice channel ${channel.id}`);
  }

  async function leaveVoice(reason) {
    if (voice) {
      voice.destroy();
      voice = null;
      log("left voice channel");
    }
    if (conn) await conn.stop(reason); // keeps sessionId for later resume
  }

  // Follow the allowed user's voice presence: join when they join, move when
  // they move, leave when they leave. Slash commands remain manual overrides.
  client.on("voiceStateUpdate", async (oldState, newState) => {
    if (newState.id !== cfg.userId) return;
    if (newState.guild.id !== cfg.guildId) return;
    try {
      if (newState.channel) {
        if (!autoFollow) return;
        if (voice && voice.joinConfig.channelId === newState.channel.id) return; // mute/deafen churn
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
    autoFollow = true;
    boundChannelId = interaction.channelId;
    await joinChannel(channel);
    await interaction.reply({
      content: cfg.loopback ? "Joined in loopback mode — speak and I echo." : "Listening.",
      flags: MessageFlags.Ephemeral,
    });
  }

  async function handleLeave(interaction) {
    autoFollow = false; // stay away until /join or the user re-enters voice fresh
    await leaveVoice("user dismissed the bridge");
    await interaction.reply({ content: "Left.", flags: MessageFlags.Ephemeral });
  }

  async function handleFocus(interaction) {
    // Rebind takes seconds; the 3s interaction window would otherwise expire.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.channel?.isThread?.()) {
      await interaction.editReply("Run /focus inside a thread.");
      return;
    }
    const resolved = resolveThreadSession(paths.stateDb, interaction.channelId);
    if (!resolved) {
      await interaction.editReply(
        "No Hermes session exists for this thread yet — send Monte a message here first, then /focus. (Or the state DB was busy; try again.)",
      );
      return;
    }
    focusState = {
      threadId: interaction.channelId,
      chatId: resolved.chatId,
      sessionId: resolved.sessionId,
      title: resolved.title,
      messageCount: resolved.messageCount,
      // First focus captures the true default so A->B switches keep it.
      defaultSessionId: focusState?.defaultSessionId ?? conn?.sessionId ?? null,
      focusedAt: new Date().toISOString(),
    };
    await saveFocus(cfg.focusStateFile, focusState);
    if (conn) await conn.rebind(resolved.sessionId, { pinned: true });
    const title = resolved.title ?? resolved.sessionId;
    const msgs = resolved.messageCount != null ? ` (${resolved.messageCount} messages)` : "";
    await interaction.editReply(
      conn?.desired
        ? `Focused: voice now continues **${title}**${msgs}. Mirror posts here.`
        : `Focused: the next voice call will continue **${title}**${msgs}. Mirror will post here.`,
    );
  }

  async function handleUnfocus(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!focusState) {
      await interaction.editReply("Not focused.");
      return;
    }
    const defaultSessionId = focusState.defaultSessionId ?? null;
    focusState = null;
    await clearFocus(cfg.focusStateFile);
    if (conn) await conn.rebind(defaultSessionId, { pinned: false });
    await interaction.editReply("Unfocused — back to the default voice conversation.");
  }

  async function handleBrief(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!conn?.connected) {
      await interaction.editReply("Not on a call — the brief is sent when a voice session starts.");
      return;
    }
    await maybeSendBrief(null, true);
    await interaction.editReply("Brief re-sent.");
  }

  client.on("interactionCreate", async (interaction) => {
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
      new SlashCommandBuilder().setName("join").setDescription("Join your voice channel and listen"),
      new SlashCommandBuilder().setName("leave").setDescription("Leave the voice channel"),
      new SlashCommandBuilder()
        .setName("focus")
        .setDescription("Bind the voice call to this thread's Hermes conversation"),
      new SlashCommandBuilder()
        .setName("unfocus")
        .setDescription("Return the voice call to its default conversation"),
      new SlashCommandBuilder()
        .setName("brief")
        .setDescription("Re-send Monte's status brief to the voice session"),
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
    voice?.destroy();
    if (conn) await conn.stop("service shutdown").catch(() => {});
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
