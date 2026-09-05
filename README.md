# hlv-discord

Full-duplex, interruptible voice conversation with a Hermes agent from the
Discord mobile app. A standalone Node service that bridges Discord voice to
the [hermes-live-voice](https://github.com/bielcarpi/hermes-live-voice)
gateway (protocol v6) — zero modifications to Hermes or HLV.

```
Discord voice (48k stereo opus)
   │ decode + downmix + 31-tap halfband decimate
   ▼
HLV gateway ws://127.0.0.1:8788/v1/live (24k mono PCM)  ⇄  OpenAI Realtime + Hermes
   ▲ interpolate + stereo + opus encode, 20ms packets
   │
Discord playback (barge-in cuts ≤200ms, truncation ledger keeps history honest)
```

## Layout

- `src/hlv-conn.js` — connection wrapper: reconnect/backoff, ws ping liveness,
  Bearer-header auth via `webSocketFactory`, session resume with
  `/v1/conversations` pre-validation and a one-shot new-session fallback.
- `src/bridge.js` — both audio directions, playback queue + played-ms ledger,
  barge-in with clamped `conversation.item.truncate`, task/transcript mirroring.
- `src/resample.js` — stateful 31-tap Kaiser (β=3.5) halfband, 2:1 both ways.
- `src/index.js` — Discord client, `/join` `/leave` `/focus` `/unfocus`
  `/brief`, player loop, `--loopback`.
- `src/hermes-status.js` — read-only views of Hermes state (`state.db`,
  `kanban.db`, cron, `gateway_state.json`) for the brief and `/focus`
  thread→session resolution. Best-effort by design: failures degrade to
  omission, never into the call path.
- `src/brief.js` — pure assembly of the bounded call-start brief; `chunkText`.
- `src/focus.js` — `/focus` state persistence (its own file, so hlv-conn's
  `state.json` rewrites can't clobber it).
- `src/mirror.js` + `bin/hlv-discord-ctl.js` — transcript-mirroring policy
  (on/off/auto) and the CLI that flips it; the service watches the state file
  so changes apply mid-call.
- `test/fake-gateway.js` — protocol-v6 fake; every frame self-validated with
  the SDK's `validateServerMessage`.

## Run

```sh
npm test                                            # headless: no Discord, no OpenAI
node --env-file ~/.config/hlv-discord/env src/index.js --loopback   # echo test
node --env-file ~/.config/hlv-discord/env src/index.js              # the real thing
```

Config: copy `deploy/env.example` to `~/.config/hlv-discord/env` (mode 600).

## Deploy

```sh
cp deploy/hlv-discord.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now hlv-discord.service
loginctl enable-linger "$USER"    # start at boot without a login session
```

## Usage

Just join a voice channel — the bot follows your voice presence (joins when
you join, moves when you move, leaves when you leave), so nothing needs typing
even from a locked phone. Speaking over the agent interrupts it. `/join` and
`/leave` remain as manual overrides; `/leave` keeps the bot away until you
`/join` again or start a fresh voice session. Background tasks keep running
server-side and the conversation resumes on the next join.

## Brief & focus

When a voice session starts, the bridge injects a compact **system brief**
(gateway/platform state, kanban, recent cron results, background work, recent
Discord thread titles) as a text turn; the agent absorbs it and answers with
just "Ready." — that spoken ack is the signal the brief landed. `/brief`
re-sends it mid-call; `BRIEF_ENABLED=0` disables it. The brief is an index,
not a database: anything deeper the voice model fetches from Hermes on demand.

**`/focus`** (typed *inside* a Discord thread) binds the voice call to that
thread's Hermes session: the HLV leg re-handshakes onto it (~1–3 s of quiet;
Discord voice stays up), the agent speaks "Focused on <title>.", the whole
thread history backs every answer (Hermes loads it server-side), voice turns
append to the thread's session, and the text mirror posts into the thread.
`/unfocus` returns to the default conversation. Focus survives service
restarts, and a focus that can't be resumed is dropped *loudly* (a Discord
notice), never silently. If the thread has no Hermes session yet, send Monte
a message there first.

Caveats: background tasks run in fresh sessions and don't inherit the focused
thread (the brief tells the model to pass key facts via `recent_voice_context`),
and HLV's long-term memory scope stays its own (`X-Hermes-Session-Key` is not
per-thread) — the transcript, which is what matters, is the thread's.

## Transcript mirroring & voice permissions

Mirroring modes: `on` (every final transcript line posts to the bound
channel), `off`, and `auto` (default — only permission/approval exchanges
post, with the triggering user line as context). Flip it any time with
`hlv-discord-ctl mirror on|off|auto|status` (installed via `npm link`) or
`/mirror`; the service watches `~/.local/state/hlv-discord/mirror.json` and
applies changes mid-call. Saying "stop mirroring" *in voice* works because
the brief tells the voice model to route it to Hermes, and a Hermes skill
(`deploy/hermes-skill/SKILL.md`, installed at
`~/.hermes/skills/hermes/hlv-discord-voice-bridge/`) teaches Hermes the CLI.

Voice sessions ride Hermes' `api_server` platform, which is *unattended*:
flagged commands are auto-denied (`approvals.unattended_mode`, default deny)
and there is no interactive approval. The workflow: when voice hits a wall,
auto-mirroring posts the exchange to the text channel — go there, ask Hermes
to re-run it, and approve; an "always" approval lands in `command_allowlist`,
which is checked *before* the unattended deny, so it unlocks voice too.

## Notes

- The gateway's own resampler is anti-alias-free linear interpolation, so this
  bridge always ships/receives 24 kHz PCM and does its own filtering.
- mediaplex `OpusEncoder.decode()` returns 48 kHz *stereo* regardless of the
  configured channel count; the bridge downmixes explicitly.
- `hermes-live setup` (v1.1.0) writes a systemd unit with a quoted
  `WorkingDirectory=` that systemd rejects; if HLV's gateway unit ever shows
  `bad-setting` after a re-run of setup, strip the quotes from that line in
  `~/.config/systemd/user/dev.hermes-live-voice.gateway.service`.
