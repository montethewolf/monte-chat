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
- `src/index.js` — Discord client, `/join` `/leave`, player loop, `--loopback`.
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

## Notes

- The gateway's own resampler is anti-alias-free linear interpolation, so this
  bridge always ships/receives 24 kHz PCM and does its own filtering.
- mediaplex `OpusEncoder.decode()` returns 48 kHz *stereo* regardless of the
  configured channel count; the bridge downmixes explicitly.
- `hermes-live setup` (v1.1.0) writes a systemd unit with a quoted
  `WorkingDirectory=` that systemd rejects; if HLV's gateway unit ever shows
  `bad-setting` after a re-run of setup, strip the quotes from that line in
  `~/.config/systemd/user/dev.hermes-live-voice.gateway.service`.
