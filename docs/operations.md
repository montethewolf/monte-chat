# Operation and behavior

For a new installation, start with the [README](../README.md). This reference
describes the bundled `1.1.0-monte.3` gateway and protocol v8.

## Calls and recovery

The bot follows the configured user's voice presence: join, move, and leave.
Only that user's speech and commands are accepted. `/join` also resumes a
paused microphone; `/leave` suppresses following until `/join` or a fresh voice
session. `/join` reports "Listening" after Discord voice and HLV are both ready.

Leaving, changing channels, or losing the connection aborts active input and
clears old playback. Discord recovery uses exponential backoff from 1 to 30
seconds and stops when the user leaves. HLV retries independently, with a
10-second handshake deadline and a 2-second disconnect deadline.

Saved conversations are resumed by exact session ID. Listing pagination and
ambiguous resume failures never cause an automatic fresh conversation. A
recoverable failure retries the saved target; a nonrecoverable failure stops
and posts an operational notice. **`/new-conversation` explicitly starts fresh
and clears focus.** When offline, it selects a fresh conversation for the next
call. Background tasks are not cancelled by disconnects or this command.

## Playback and interruption

Input passes through WebRTC voice activity detection before it can interrupt or
send audio upstream. Five consecutive voiced 20 ms frames (100 ms) confirm
speech; up to 200 ms of recent audio is retained to preserve the first word.
Digital silence, low-level noise, and unconfirmed short blips are discarded
without committing a Hermes turn. A packet gap over 100 ms resets an unconfirmed
onset. This detector is not echo cancellation; speech from speakers/background
voices can still qualify. Very brief or quiet words may need tuning after live
Bluetooth testing. The existing 500 ms receive timeout remains unchanged.

Completed responses drain through the Discord player's buffers. Confirmed speech over
queued or buffered output interrupts it, including output whose provider
response has already completed. Packet prefetch does not count as playback.

The truncation ledger uses the Discord resource's consumption counter, excludes
silence-fill and partial-frame padding, and is scoped to the current session and
response. It measures audio consumed for sending, **not confirmed playback on
the phone**; Discord exposes no remote playback acknowledgement here. Network
and device buffering still affect what the listener hears. Measure interruption
latency with the manual checklist rather than assuming a fixed upper bound.

## Voice diagnostics

Lines beginning `voice {` contain structured timing/counter data, without audio
or transcript content. `traceId` identifies a bridge process; `responseId` and
`inputId` correlate response starts, speech confirmation, interruptions and
summaries. `gateway_ready` includes a connection counter; `discord_state` records
connection transitions. Existing non-diagnostic service logs retain their policy.

`input_summary` reports why input ended, detected/decoded/sent durations, decode
errors and the largest packet arrival gap. An arrival gap is not a measurement
of packet loss. `response_summary` reports completion/cancellation reason,
received and consumed audio, maximum queue depth, underflow episodes and consumed
inserted silence (including initial waiting silence). Consumption means handed
to Discord, not playback confirmed on the phone. Summaries are emitted on drain,
cancellation or reset; no per-packet logging or persistent audio capture is used.

```sh
journalctl _SYSTEMD_USER_UNIT=hlv-discord.service --since '10 minutes ago' -o cat
```

## Brief, focus, and Hermes continuity

At call start, the bridge inserts a compact context brief. With the bundled v8
gateway this is labelled context, without a synthetic user turn or a guaranteed
spoken "Ready." acknowledgement. Older gateways receive the brief as a text turn.
`/brief` forces a refresh; `BRIEF_ENABLED=0` disables briefing.
Status collection runs in a worker every 60 seconds. Cached data expires after
five minutes; a forced refresh waits at most 1.5 seconds. Unavailable data is
omitted or labelled unavailable, not described as zero work. Stale briefs from
an earlier call or focus cannot be sent into the current conversation.

Run `/focus` inside a Discord thread to select its Hermes session. The Discord
voice connection remains up. With v8 Brainstorm support the discussion changes
inside the existing realtime connection; older gateways reconnect HLV. The new mirror
destination commits only after session readiness and successful persistence.
A failed switch preserves the previous selection. `/unfocus` returns to the
separately saved default session. A focus chosen offline applies on the next
call. If no Hermes session exists for a thread, send Hermes a message there first.

Before each focused connection/reconnection, the bridge resolves the thread's
current routing tip. If Hermes state cannot be read, it retains the last known
session instead of guessing or silently clearing focus.

**Continuity contract:** successful `continue_hermes_conversation` tool calls
use and update the selected Hermes conversation. The bridge does not independently
persist every spoken exchange. The gateway also retains bounded discussion
dialogue and notes separately from Hermes history. This is not a complete
transcript: realtime-only acknowledgements and interrupted speech are not
guaranteed to survive a reconnect. Discord transcript mirroring is a separate
record, not a Hermes history write. The realtime model
is instructed to delegate conversational follow-ups to Hermes; this is not an
exactly-once persistence guarantee.

In v8, selected-conversation Work resolves the selected Hermes session lineage;
independent consultations use helper sessions. Discussion context accompanies
Work handoffs. See [normal Hermes access](natural-hermes.md) for the contract.
HLV's long-term memory scope remains its own
(`X-Hermes-Session-Key` is not per-thread). Concurrent Discord text turns and
voice turns remain subject to Hermes's own session/concurrency behavior.

## Persistence and migration

`HLV_STATE_FILE` (default `~/.local/state/hlv-discord/state.json`) now contains:

```json
{"version":3,"defaultDiscussionId":"discussion_0123456789abcdef0123456789abcdef","defaultSessionId":"saved-default","focus":null}
```

The service generates the discussion ID; do not copy the example as initial state.
Version-2 records acquire a discussion ID and migrate to version 3 on load.

A non-null `focus` contains the thread ID, session ID, title and available thread
metadata. One controller writes the entire record atomically. An active focus
change commits after readiness; an offline selection commits immediately.

On first load, legacy `{sessionId}` and `FOCUS_STATE_FILE` are imported together.
The legacy focus target wins over a mismatched session ID, and its saved default
is retained. Before replacing a legacy state file, the service preserves its
original contents at `HLV_STATE_FILE.legacy`; the old focus file is left intact.
`FOCUS_STATE_FILE` is thereafter a migration input only. Corrupt state fails
closed rather than discarding conversation context. Mirror state remains separate.

## Post voice conversation to text

Mirroring controls only what gets posted to Discord. It does not change Hermes
memory, conversation selection, or background tasks. There are two settings:

- `on`: final transcripts, task-result content, and operational notices.
- `off` (default): operational notices only. Transcripts and task-result content are
  suppressed, including content still queued when the mode changes. A message
  already handed to Discord cannot be recalled.

Use `/mirror mode:on` to keep a text record, `/mirror mode:off` for voice-only conversation,
and `/mirror` to check the current setting. The CLI is
`hlv-discord-ctl mirror on|off|status`. Saved `on`/`off` choices are preserved;
legacy `auto` in the state file or environment is interpreted as `off`. Reading legacy state does not rewrite it;
the next explicit change saves the selected on/off value. The state watcher
works from first boot and follows atomic CLI updates. `/mirror` also reports the
number of undelivered notices during this service run.

Destinations are the committed focused thread, otherwise the manually bound or
configured text channel, otherwise the current voice channel's text chat.
Destination is captured when an event is queued. A failed focused-thread post
never falls back to another channel. Grant View Channel and Send Messages,
including Send Messages in Threads where applicable.

Delivery is ordered, mention-disabled, limited to 200 queued messages with a
five-minute lifetime, and retries transient failures up to three attempts.
Chunks have stable nonces for Discord deduplication. Notification identifiers
are deduplicated per destination. The queue is memory-only: delivery across
service restarts is not guaranteed, and message bodies are not logged or saved
by the delivery queue.

Voice requests to change mirroring route through Hermes and its CLI skill
([optional control skill](../deploy/hermes-skill/SKILL.md)). Configure its state-file path consistently with
the service when overriding defaults. Hermes's existing approval policy still applies. Protocol v8 can present
correlated command approvals by voice and Discord buttons when Hermes supports
them. An unsupported or blocked request may still need handling through Hermes
text. The bridge never grants approval automatically.

## Audio notes

The bridge sends and accepts 24 kHz mono PCM and performs its own halfband
filtering. `mediaplex` decoding produces 48 kHz stereo, which is downmixed
explicitly. Unsupported advertised input formats disable input rather than
sending audio at the wrong rate.

## Conversational brainstorming

Use `/mode` during a call to inspect or switch Work/Brainstorm. Say “let’s
brainstorm Monte Chat” to select that project, or “implement option B” to switch
to Work with the saved design context. See [current behavior](natural-hermes.md)
and [validation](natural-hermes-validation.md). The SDK and gateway use the
matching HLV fork release `1.1.0-monte.3` (protocol v8).

## Source layout

- `src/index.js` — Discord transport, slash commands, voice receiver, auto-follow.
- `src/call-controller.js` — serialized call transitions, cleanup, recovery,
  transactional focus and conversation selection.
- `src/session-store.js` — versioned, atomic session/focus persistence and migration.
- `src/hlv-conn.js` — abortable SDK connections, exact session resume,
  Bearer-header authentication, heartbeat, bounded handshakes and backoff.
- `src/bridge.js` — input/output DSP, response queue and interruption metadata.
- `src/playback.js` — Discord resource draining and consumption accounting.
- `src/resample.js` — stateful 31-tap halfband resampling in both directions.
- `src/status-reader.js`, `src/status-worker.js`, `src/hermes-status.js` —
  worker-isolated, read-only Hermes status and thread-session resolution.
- `src/brief.js`, `src/brief-sender.js` — compact briefs, session guards and throttling.
- `src/mirror.js`, `src/mirror-watch.js`, `src/delivery.js` — mirroring policy,
  CLI state watching, ordered bounded text delivery.
- `bin/hlv-discord-ctl.js` — control mirroring without restarting the service.
- `test/` — real Discord player/SDK tests with fake transports, lifecycle races,
  DSP, persistence, worker isolation, and delivery regressions.
