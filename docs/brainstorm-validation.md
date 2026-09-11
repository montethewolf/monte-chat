# Brainstorm release validation

## September 7: focused-thread startup fix

Current release: **`1.1.0-monte.2`**, fork commit `d607d33ec23f18c4c1b62979bac5ef3c1d34cce2`. A native Hermes thread contained a metadata-only `session_meta` row with null content. The HLV history parser rejected that row, preventing the voice session from starting even though service readiness checks passed. The parser now excludes those metadata records while retaining dialogue, session lineage, and validation of malformed conversation messages.

Both gateway and SDK were upgraded to the matching package and restarted at **11:37 CDT**. The pre-update backup is `/home/alex/.local/state/monte-chat-rollouts/20260907T163658Z`. All 274 installed package files match the release artifact. The user's latest selection and Brainstorm preference were preserved. Research accepted before the restart completed through its original backend and retained its result.

Verification: **762 fork tests**, **113 Monte Chat tests**, typecheck, package installation/activation checks, and documentation checks passed. Four added cases cover native history with session metadata and rejection of malformed dialogue.

The live probe resumed the exact previously failing thread in **579 ms**, sent synthesized spoken PCM, recognized the mode-inspection question, and received **165,600 bytes of reply audio**, with first audio after **1,119 ms**. It submitted no background task. The actual Discord bridge also rejoined the ongoing call and produced a reply after restart, with **977 ms** from input end to first received audio and no playback underruns. These checks establish resumed voice input/output; the full ten-minute design acceptance remains pending.

Run `HERMES_LIVE_CONFIG_FILE=~/.hermes/hermes-live/config.env node deploy/smoke-focused-voice.mjs --audio` to repeat the check against the current selection. It requires FFmpeg's `flite` filter. Set `HLV_PROBE_SESSION_ID` to inspect a particular saved thread without changing the user's focus; the probe keeps its own discussion notes.

## September 6 initial rollout

Release `1.1.0-monte.1` was deployed on September 6, 2026. The gateway and bridge started with the final service configuration at 15:47 CDT. Automated verification and live provider preflights passed. The ten-minute Discord voice acceptance exercise is **pending human participation**; no voice latency or conversational-quality result is claimed yet.

The separate HLV fork is at `/home/alex/Development/hermes-live-voice-monte`, branch `monte-brainstorm-v1`, commit `51d8965245476574d2af17cd0fe4b082cfe13766`. The [release manifest](../vendor/release.json), [checksums](../vendor/SHA256SUMS), [installable package](../vendor/hermes-live-voice-1.1.0-monte.1.tgz), and [source archive](../vendor/hermes-live-voice-1.1.0-monte.1-source.tar.gz) are included in this repository. All 274 packaged files were compared byte for byte against both installed copies.

## Verification evidence

| Check | Result |
| --- | --- |
| Monte Chat `npm test` | 113 tests passed |
| HLV fork `npm test -- --reporter=dot` | 758 tests passed across 41 files |
| HLV `npm run typecheck` | Passed |
| HLV `npm run check:package` | Packed installation, activation, setup, upgrade, diagnostics, plugin, gateway, doctor, and CLI checks passed |
| HLV `npm run check:gateway` | Passed with a fake provider |
| HLV `npm run check:docs` | 25 Markdown files checked |
| Real installed Hermes plugin integration | Four tests passed using temporary repositories and an isolated temporary profile |
| Profile installer checks | Selected-provider credentials only; private files; existing profiles retained; Work state unchanged |
| Rollback helper checks | Refused active research without mutation; retained current Work tasks and session selection; created private v7 snapshots |
| Deployed gateway HTTP probes | `/health`: ok; `/ready`: ready; v7 advertised with v3–v6 compatibility and Brainstorm support |
| Discord command inspection | `/mode` registered with `mode` and `project` options and Work/Brainstorm choices |
| Deployed selection migration | v3 state retains the previous default Hermes session and focus |
| Service status | Voice gateway, Discord bridge, and research profile active with zero automatic restarts; original Work Hermes service remains active |

The tests cover independent switching while four Work calls are pending, mode/provider persistence rollback, denied execution in Brainstorm, replayed implementation submission, reconnect and focus isolation, accepted user decisions, interrupted buffered replies, both task follow-up paths, backend recovery/cancellation, and continued conversation during delayed research. Findings wait for microphone, provider response, and playback idleness; stale-topic findings are retained without announcement. Temporary Git repositories verify spoken project resolution, ambiguity, registry persistence, source refresh, and stale-evidence labelling in handoffs.

The real Hermes tests invoke plugin discovery and the actual agent dispatch path. They attempt shell execution, writes, delegation, messaging, discovery, a hidden tool with a write sentinel, forbidden files, traversal, and symlink escapes. All are blocked; approved repository reading/searching succeeds. Automated tests use temporary state and fake realtime providers. The following paid provider checks were run separately.

## Live provider preflights

`node deploy/smoke-openai.mjs` used the configured `gpt-realtime-2` model. Effective Brainstorm and Work configuration acknowledgements took **78 ms** and **66 ms** respectively. Labelled context insertion passed with **zero speech or tool events**. These measurements cover provider configuration, not the complete spoken or slash-command switch.

The initial live context check exposed OpenAI's 32-character custom item-id limit. The adapter now uses a 28-character identifier, with regression coverage, and the corrected check passed before rollout.

`node deploy/smoke-research.mjs` completed two bounded repository reads through the independent research profile using the configured Hermes model, `gpt-6-astra`:

| Run | Duration | Result |
| --- | --- | --- |
| `run_52f2825c3973435bbd70a7a496b24fb9` | 17,604 ms | Correct HLV dependency and `package.json:20` reference |
| `run_16383941aa92439e98fb2ac822dd8484` after rollout | 8,954 ms | Correct HLV dependency and `package.json:20` reference |

These are two research preflights, not conversational consultation counts. They submitted no Work implementation request.

## Deployment and recovery

The private pre-rollout backup is `/home/alex/.local/state/monte-chat-rollouts/20260906T202055Z`. It contains bridge state, HLV state, both original voice units, and the previous bridge source/package lock. The original globally installed HLV 1.1.0 remains available. Follow the [rollout and rollback instructions](brainstorm.md); the rollback helper preserves Work accepted after the backup.

The deployed gateway is installed under `~/.local/share/monte-chat/gateway`. Research uses `~/.hermes-research`, an independent auth store, API credential, sessions, and tool configuration. No Hermes core files were modified.

The user journal was unavailable during rollout, so service logs are retained in private files:

- `~/.local/state/hlv-discord/bridge.log`: `turn_first_audio` diagnostics and slash-mode confirmation latency.
- `~/.hermes/hermes-live/gateway.log`: `mode_switch` and `research_consultation` records.
- `~/.hermes-research/logs/gateway.log`: research startup, dispatch, and provider diagnostics.

## Pending ten-minute Discord acceptance

1. Join voice. Inspect `/mode`, then say “Let's brainstorm Monte Chat.” Confirm a brief acknowledgement, correct project, and uninterrupted Discord connection. Inspect `/mode` again.
2. Discuss a concrete design with at least five substantive exchanges. Include “Could we implement this differently?” and confirm it remains conversational. Record alternatives and explicitly accept one option with a constraint.
3. Start one deliberately slow, multi-file repository investigation. Keep at least five substantive exchanges moving while it remains pending. If normal research finishes too quickly, repeat this portion in staging with a controlled research completion delay; do not count a fast result as satisfying the pending-work criterion. A repeated consultation must return the existing receipt.
4. Confirm that the finding arrives at a pause after buffered playback drains. Interrupt with speech and confirm user input takes priority. Change topics during another investigation and verify its late result does not intrude on the new topic.
5. Reconnect and verify the selected mode, project, accepted design, constraints, and notes survive. Focus another thread and return; confirm discussion isolation and unchanged mode. Use `/new-conversation` to verify fresh context with the same mode preference.
6. Say “Back to work mode” and verify that this alone submits nothing. Return to Brainstorm, then explicitly request a small agreed implementation. Verify one Work submission includes the request, decisions, constraints, selected project, and relevant findings. Any already accepted Work should continue across switches.

Record start/end timestamps, project, discussion and investigation receipts, number of substantive exchanges while pending, reconnect outcome, and Work handoff outcome. Save the following measurements alongside this document:

| Measurement | Pending result |
| --- | --- |
| Turn to first audio: count, median, maximum | A short Discord call was observed September 7; repeat during the complete acceptance exercise |
| Spoken and slash mode-switch latency | Spoken switch observed at 144 ms on September 7; full exercise pending |
| Consultation calls and distinct research receipts | One research receipt observed September 7 and recovered through restart; full exercise pending |
| Five substantive exchanges while one slow investigation remains pending | Pending |
| Useful findings at a pause; interruption priority | Pending live validation |
| Agreed design survives reconnect and Work handoff | Pending live validation |

`turn_first_audio` measures from the bridge's end-of-input boundary to the first PCM audio it receives. Discord packet consumption does not establish when a remote device makes audio audible. Count distinct `research_consultation.receipt` values separately from repeated consultation calls.
