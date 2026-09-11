# Work and Brainstorm

During a voice call, say “let’s brainstorm Monte Chat” or use `/mode mode:brainstorm project:Monte Chat`. Monte discusses directly with OpenAI Realtime. `/mode` reports mode, selected project, investigation, and ongoing Work tasks. `/mode mode:work` restores normal routing without submitting a task. “Implement option B” first switches to Work and then submits the explicit request with discussion context. Hypothetical implementation questions remain conversational.

The mode preference survives service restarts. `/focus` and `/unfocus` change discussion context within the current Discord and realtime connections; focused discussions use `discord:<thread-id>`. `/new-conversation` renews the default discussion identifier and retains the mode. Existing accepted Work continues. Mode controls require an active call and protocol v7 with OpenAI; older Work clients remain supported by the gateway.

Research uses a separate Hermes profile. It permits only `repo_list`, `repo_read`, and `repo_search`, with an enforced tool-call hook and repository path restrictions. Shell, writes, delegation, messaging, discovery, and other integrations are blocked. One investigation may be outstanding per discussion. An existing receipt is returned for repeated or additional questions while that investigation is pending. If research is unavailable, Monte can continue discussing without claiming verification.

Findings are introduced after user input, provider responses, and Discord playback are idle. File references and uncertainties are retained. Findings from previous topics are archived without being announced in the current topic. The Discord consumption counter measures packets sent to Discord, rather than audio heard on a remote device.

The gateway privately stores 20 finalized dialogue messages / 20,000 characters, 6,000 characters of structured notes, and a 12,000-character project briefing per discussion. Decisions require a quote from finalized user dialogue. Interrupted replies are marked, including interruptions during buffered playback. Memory is independent of text mirroring and is restored in voice and attached to subsequent Work requests. Ordinary Hermes text chats do not automatically recall it.

Repository briefings carry a revision and working-tree fingerprint, refresh in the background, and refresh before Work handoff. A handoff labels research whose evidence fingerprint no longer matches. Context loading does not delay ordinary brainstorming; no Hermes summarization turn is needed.

# Configuration and release

The [HLV source fork](https://github.com/montethewolf/hermes-live-voice/tree/monte-brainstorm-v1) is checked out at `/home/alex/Development/hermes-live-voice-monte`, based on upstream v1.1.0 commit `ce16d93f475ad138a6efb018e4a0417c6c5a501c`. The matching gateway and SDK release is `1.1.0-monte.2`, pinned by `package.json` to `vendor/hermes-live-voice-1.1.0-monte.2.tgz`. A source archive and checksums accompany the package. Edit the source checkout, build and test, and produce a new version for subsequent releases. Installed package files are not the development source.

Gateway environment settings:

| Setting | Default / purpose |
| --- | --- |
| `HERMES_LIVE_VOICE_STATE_FILE` | `voice-state.json` alongside the HLV task-state file |
| `HERMES_LIVE_REPOSITORY_REGISTRY` | `repositories.json` alongside the task-state file |
| `HERMES_LIVE_REPOSITORY_ROOTS` | JSON array; defaults to `["/home/alex/Development"]` |
| `HERMES_LIVE_RESEARCH_PYTHON` | `python3`, used for bounded repository briefings |
| `HERMES_LIVE_RESEARCH_URL` | Separate loopback Hermes endpoint; unset disables consultations |
| `HERMES_LIVE_RESEARCH_API_KEY` | Separate research API credential |

The registry is seeded with Git repositories directly under configured roots, including a root that is itself a repository. Additional repositories may be registered explicitly. Each project has `id`, `name`, absolute canonical `path`, and optional `aliases`. Restart the gateway after editing registry entries. Repository symlinks, traversal, Git metadata, ignored files (including tracked ignored files), credential filenames, private-key content, binary files, large files, and hard links are excluded. Reads, searches, result sizes, and subprocess deadlines are bounded.

# Rollout

1. Back up `~/.local/state/hlv-discord`, `~/.hermes/hermes-live`, both voice service units, and the existing bridge source/package lock. Keep backups private. The implementation rollout backup location is recorded in `docs/brainstorm-validation.md`.
2. Install the pinned SDK with `npm ci`. Install the same tarball in an isolated gateway prefix:
   ```sh
   npm install --prefix "$HOME/.local/share/monte-chat/gateway" --omit=dev --ignore-scripts "$PWD/vendor/hermes-live-voice-1.1.0-monte.2.tgz"
   ```
3. Create the separate research profile using the existing Hermes Python environment:
   ```sh
   ~/.hermes/hermes-agent/venv/bin/python deploy/setup-research.py --plugin "$PWD/node_modules/hermes-live-voice/plugins/monte-research"
   ```
   This copies only the configured provider's credential entries to a private independent auth store. For a static-key provider, provision its model API key in the research profile's `.env`. Existing profiles are retained; upgrade their plugin files without replacing credentials or sessions. OAuth credentials can require independent reauthentication after expiry.
4. Seed the registry using `RepositoryRegistry.load()` from the installed gateway's `dist/application/brainstorm/repository-registry.js`. Run `deploy/research/run.py --check` with `HERMES_HOME` and `HERMES_LIVE_REPOSITORY_REGISTRY` set to the research home and gateway registry. Startup refuses to serve unless the three-tool allowlist and forbidden dispatch checks pass.
5. Install `deploy/hermes-research.service` to `~/.config/systemd/user/`. Install `deploy/gateway-monte.conf` as `~/.config/systemd/user/dev.hermes-live-voice.gateway.service.d/monte.conf` and `deploy/bridge-logging.conf` as `~/.config/systemd/user/hlv-discord.service.d/monte-logging.conf`. These templates use this machine's paths; adjust them for another installation. Create private log files at `~/.hermes/hermes-live/gateway.log` and `~/.local/state/hlv-discord/bridge.log` (mode 0600) to retain acceptance metrics when the user journal is unavailable. Reload systemd, enable/start the research unit, then restart the gateway and bridge. The research unit has a private state directory, filtered environment, and filesystem write protection outside its state.
6. Check service status, gateway capabilities (v7), and run `node deploy/smoke-openai.mjs` and `node deploy/smoke-research.mjs`. The first performs real provider configuration/context checks without requesting speech or Hermes work. The second performs one real read-only package inspection in the research profile.
7. Perform the human voice acceptance exercise in `docs/brainstorm-validation.md`.

# Rollback

Finish or cancel outstanding research through the v7 task controls before rollback. Stop `hlv-discord` and `dev.hermes-live-voice.gateway`. Run:

```sh
python3 deploy/prepare-rollback.py \
  --tasks "$HOME/.hermes/hermes-live/tasks-v1.json" \
  --selection "$HOME/.local/state/hlv-discord/state.json"
```

The helper refuses active research, snapshots v7 state, retains every current Work task, and converts current selection to the old v2 format. It preserves voice notes separately. Restore the prior bridge source/package lock from the backup, run `npm ci`, remove the `monte.conf` gateway override and `monte-logging.conf` bridge override, disable/stop the research unit, reload systemd, and start the original gateway and bridge. The original globally installed HLV 1.1.0 package remains available. Do not restore the old task-state backup over Work accepted since rollout.

# Provider contract

Runtime instruction/tool updates wait for OpenAI's effective `session.updated` acknowledgement. Context uses a labelled system `conversation.item.create` with a bounded custom item id; insertion alone never requests speech. Only findings delivery at an idle pause requests a response. See [OpenAI realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations).
