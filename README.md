# Monte Chat

Talk to your existing Hermes agent through Discord voice. Monte Chat supports
interruptible replies, project brainstorming, background work, saved conversations,
optional text transcripts, and command approvals during a call.

```text
Discord app ⇄ Monte Chat voice bot ⇄ Hermes Live Voice gateway
                                         ├─ realtime voice provider
                                         └─ your existing Hermes agent and tools
```

This repository contains the Discord bridge and the matching **custom
`hermes-live-voice` release `1.1.0-monte.3`, protocol v8**, including its source
archive. No Hermes source edits are required. Install the bundled gateway, not
the upstream npm release: the additional discussion and approval features depend
on this fork. Package name, CLI, and bridge service names still use `hlv-discord`.

## Give this to Hermes

Clone this repository on the machine where Hermes runs, then tell Hermes:

> Read Monte Chat's README.md and follow its installation instructions to connect
> this checkout to my existing Hermes. Inspect my installation first, use the
> bundled gateway release, and ask me for the Discord setup and credentials you
> cannot discover. Configure my project folders and verify a first voice call.

### Instructions for the installing agent

1. Discover the operating system, actual checkout and Node paths, Hermes command,
   active Hermes profile/home, service manager, and any existing voice gateway.
   Preserve the user's existing model, tools, credentials, conversations, and
   approval policy. Run as the same OS user as Hermes.
2. Collect the missing choices together: Discord server/user/channel, dedicated
   voice bot credentials, voice-provider access, and local project directories.
   Have the user enter secrets privately into configuration or the setup prompt;
   do not echo tokens into chat, logs, or command-line arguments.
3. Follow the steps below using discovered absolute paths. Keep a private backup
   of any existing configuration/service definitions before changing them. Setup
   can refresh the Hermes gateway; if that would interrupt this chat or active
   work, finish preparation and explain the required restart before performing it.
4. Use the version in `package.json` and [release manifest](vendor/release.json).
   Historical rollout documents and `deploy/smoke-*.mjs` refer to the maintainer's
   accounts and projects; they are not fresh-install instructions.
5. Report which checks passed, the remaining human call checks, and the local
   config/service paths. Do not report success based only on a running process.

## Requirements and scope

- An existing working Hermes installation on the same host/user as this bridge.
  Local access to its state database is needed for Discord thread focus and status
  briefs. A remote Hermes API alone does not provide those features.
- Node.js **22.12 or newer**, npm, Git, Python 3, make, and a C++ compiler. The
  `webrtcvad` dependency compiles a native addon. On Debian/Ubuntu the build
  prerequisites are `python3`, `make`, and `build-essential`; on macOS use the
  Command Line Tools and an available Python 3.
- A Discord server where you can install a bot and use a normal voice channel.
  This bridge follows **one configured Discord user** per installation.
- Access to the **OpenAI realtime provider** for the Work/Brainstorm experience
  described here, using an API key available to the gateway. Voice-provider
  usage is separate from Hermes model usage. Other HLV providers are outside
  this installation recipe; mock mode cannot validate voice.

Linux/systemd on a Raspberry Pi is the deployment covered by the existing
validation records. The bridge suite passed 117 tests on Node 26.8.1 during the
handoff review. macOS service instructions are included but a fresh macOS install
has not been validated here. Native Windows and split-host deployment are not
covered. Tests do not replace a real call on the recipient's machine.

The bundled gateway records Hermes 0.18.2 as its upstream minimum and 0.20.0 as
its upstream tested version. **The API capability checks below are authoritative
for this integration**, especially on newer or customized Hermes installations.

## 1. Install the bridge and matching gateway

If not already cloned:

```sh
git clone https://github.com/montethewolf/monte-chat.git
cd monte-chat
```

Run subsequent shell examples in the same shell from this checkout. Discover and
record these paths; replace the Hermes home if the user runs a named/custom profile:

```sh
MONTE_CHAT_DIR="$(pwd -P)"
MONTE_NODE="$(node -p 'process.execPath')"
MONTE_HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
MONTE_GATEWAY_DIR="$HOME/.local/share/monte-chat/gateway"
MONTE_GATEWAY_CLI="$MONTE_GATEWAY_DIR/node_modules/hermes-live-voice/dist/cli.js"
export HERMES_HOME="$MONTE_HERMES_HOME"
export HERMES_LIVE_CONFIG_FILE="$MONTE_HERMES_HOME/hermes-live/config.env"
node --version
npm --version
hermes --version
npm ci
npm test
```

Use the same Node installation for npm, the tests, and both services. Tests use
temporary state and fake transports, with no Discord/provider credentials, but
need permission to spawn Git/Python processes and bind local test sockets.

Verify the vendor artifacts from `vendor/` with `sha256sum -c SHA256SUMS` on Linux
or `shasum -a 256 -c SHA256SUMS` on macOS. Then, from the checkout:

```sh
npm install --prefix "$MONTE_GATEWAY_DIR" --omit=dev --ignore-scripts \
  "$MONTE_CHAT_DIR/vendor/hermes-live-voice-1.1.0-monte.3.tgz"
"$MONTE_NODE" "$MONTE_GATEWAY_CLI" version
```

Expected version: `1.1.0-monte.3`. Keep this installation directory available to
the service. Use this CLI's absolute path throughout; a global `hermes-live` may
refer to a different release. Do not run an upstream `@latest` upgrade over it.

## 2. Connect the gateway to Hermes

For a **new voice installation**, choose a task-state path in the selected Hermes
profile before setup. For an existing voice installation retain its configured
state path instead:

```sh
export HERMES_LIVE_TASK_STATE_FILE="$MONTE_HERMES_HOME/hermes-live/tasks-v1.json"
"$MONTE_NODE" "$MONTE_GATEWAY_CLI" setup --provider openai
```

Run setup in a terminal capable of accepting its private API-key prompt. An agent
without an interactive terminal can use `--non-interactive` after the key is
available in the process environment, an existing managed config, or the selected
Hermes profile's `.env`. Missing values cause an error, not an automatic fallback.
If Hermes is not on PATH, add `--hermes-command /absolute/path/to/hermes`.

For a normal local Hermes endpoint (`http://127.0.0.1:8642`), setup can enable
`API_SERVER_ENABLED`, create/reuse `API_SERVER_KEY` in the selected Hermes `.env`,
install/enable the bundled `hermes-live` Dashboard plugin, and install/start the
voice gateway service. When the Hermes API is unavailable, it can invoke
`hermes gateway install --force`. Inspect existing service customizations first.
Keep the normal Hermes profile; a separate research profile is not needed for v8.

For an existing custom endpoint or a Hermes process managed by Docker or another
supervisor, enable its authenticated API through that installation's normal
configuration. Supply its key as `HERMES_AGENT_API_SERVER_KEY` and use
`setup --provider openai --hermes-url http://127.0.0.1:ACTUAL_PORT --no-service`.
`--no-service` prevents setup from managing Hermes/gateway services, but still
writes voice configuration and installs the plugin. It requires an already
working Hermes API. If needed, `--no-enable` leaves plugin enablement to you.
Use the foreground gateway command in the next section, or configure the host's
existing supervisor to run that same command.

Setup writes a private managed config at `$HERMES_LIVE_CONFIG_FILE`. Keep the
gateway on loopback (`127.0.0.1`); the phone connects through Discord, so no public
gateway port is needed. Record the **actual** `HERMES_LIVE_PORT`; setup can choose
a free port other than 8788. Keep PCM16 input and output for the Discord bridge.

Run the pinned CLI's `doctor` and resolve missing Hermes run/session capabilities.
These include run submission/status/events/stop/approval response and session
resources/chat/streaming/model selection. In-call approvals also need Hermes
approval events with request identities. Do not work around missing capabilities
by disabling approvals; use a compatible Hermes installation.

## 3. Configure project discovery and check the gateway

The fork's default project root is the maintainer's `/home/alex/Development`.
**Override it on every new installation.** Create
`~/.config/monte-chat/gateway.env` with mode 600 in a private directory:

```dotenv
HERMES_LIVE_REPOSITORY_ROOTS='["/absolute/path/to/your/projects"]'
```

Replace the example with the user's directories (a JSON array of absolute paths).
Use `[]` if no projects should be discovered. Discovery inspects each root and
its immediate child Git repositories, not an arbitrary recursive tree. Git and
Python 3 must be available to the gateway process; use
`HERMES_LIVE_RESEARCH_PYTHON=/absolute/path/to/python3` here if needed.

This is a **separate environment file**. Do not put repository settings into
HLV's managed `config.env`: its allowlist rejects them. Do not put them only in
the Discord bridge's env file: that is a different process.

For the managed gateway, follow [gateway service configuration](docs/services.md#gateway)
to load this environment file and restart the gateway. For foreground operation,
with no other gateway instance running:

```sh
"$MONTE_NODE" --env-file="$HOME/.config/monte-chat/gateway.env" \
  "$MONTE_GATEWAY_CLI" serve
```

The foreground process also needs the `HERMES_LIVE_CONFIG_FILE` exported above.
Leave it running while using the bridge. In a separate shell with the same path
variables, run:

```sh
"$MONTE_NODE" "$MONTE_GATEWAY_CLI" doctor
"$MONTE_NODE" "$MONTE_GATEWAY_CLI" launch-check
```

`doctor` diagnoses configuration/API readiness. `launch-check` opens a real
provider session and starts a bounded Hermes worker, so it uses the configured
accounts and may incur usage charges. Require a passing result. The underlying
`/ready` endpoint should return HTTP 200; authenticated gateways require a Bearer
header. A successful `/health` alone only proves the process is alive.

## 4. Create a dedicated Discord voice bot

Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
Give it a bot and install it into the user's server with the `bot` and
`applications.commands` scopes. Grant View Channels, Connect, Speak, Send
Messages, and Send Messages in Threads in the channels/threads it will use.
The bridge does not require privileged intents or Administrator permission.

**Use a separate application/token from Hermes's existing Discord text bot.**
The bridge replaces its application's guild slash-command list on startup.
The text bot can remain in the same server for normal Hermes chats and `/focus`.

Collect the bot token, application ID, server (guild) ID, and the human user's
ID. Discord's Developer Mode exposes Copy ID actions. Optionally choose a text
channel for notices/transcripts; both bots need access to threads used for focus.
Only the configured user's speech and commands will be accepted.

Create `~/.config/hlv-discord` privately. Copy [deploy/env.example](deploy/env.example)
to `~/.config/hlv-discord/env` **only if it does not already exist**, set mode 600,
and fill in:

| Variable | Value |
| --- | --- |
| `DISCORD_TOKEN` | Dedicated voice bot token |
| `DISCORD_APP_ID` | Its application ID |
| `DISCORD_GUILD_ID` | Server ID |
| `DISCORD_USER_ID` | Human user ID, not either bot's ID |
| `HLV_URL` | `ws://127.0.0.1:ACTUAL_PORT/v1/live` from gateway setup |
| `HLV_TOKEN` | Same value as `HERMES_LIVE_AUTH_TOKEN`, if gateway auth is enabled |
| `HERMES_HOME` | Absolute path to the selected Hermes profile |
| `DISCORD_TEXT_CHANNEL_ID` | Optional destination for notices and mirrored text |

`HLV_TOKEN` is the **voice gateway token**, not the Hermes API key or provider key.
The latter keys belong in the gateway configuration. Config file values do not
expand `~` or `$HOME`: write literal absolute paths. Default state paths follow
the OS user's home; leave overrides commented unless intentionally changing them.

## 5. Verify a first call, then enable background startup

With the gateway ready, run one bridge instance in the foreground:

```sh
"$MONTE_NODE" --env-file="$HOME/.config/hlv-discord/env" \
  "$MONTE_CHAT_DIR/src/index.js"
```

Look for `slash commands registered` and `discord ready`. From the configured
Discord account, join a normal server voice channel; the bot follows. Use `/join`
if needed. The user should verify:

1. A spoken question receives audible output, and speaking over a longer reply
   interrupts it. `/join` should report listening when both connections are ready.
2. `/mode mode:brainstorm` works; asking about an actual configured project finds
   it. Request a harmless repository lookup and verify Hermes returns findings.
3. `/mode mode:work` works. An explicitly requested small task reaches the user's
   normal Hermes tools. Test an approval if Hermes requests one; never change
   approval policy just to make the check pass.
4. Leave/rejoin and confirm the conversation can resume. Test `/mirror mode:on`
   and `/mirror mode:off` if transcripts are wanted; off is the default.
5. If thread focus is wanted, message the existing Hermes text bot in a thread
   first, then use `/focus` there. Check that the expected conversation is selected
   and `/unfocus` returns to the default. Plain voice works without text-bot setup.

These are human checks; report any that remain untested. For an audio-only
diagnostic, stop the normal bridge and run the same command with `--loopback`;
it echoes speech through the Discord audio chain without contacting HLV.
It still connects to Discord and is not a provider/Hermes integration test.

After the call succeeds, stop the foreground bridge and follow
[background service instructions](docs/services.md#discord-bridge). Run only one
bridge per bot token and one gateway per configured port/state file. The detailed
[voice validation checklist](docs/validation.md) covers longer reliability checks.

## Everyday use and troubleshooting

| Command | Purpose |
| --- | --- |
| `/join`, `/leave` | Start/resume listening, or leave and suppress auto-follow |
| `/mode` | Inspect Work/Brainstorm and project selection during a call |
| `/focus`, `/unfocus` | Select a thread's Hermes conversation or the default |
| `/new-conversation` | Start fresh and clear focus; accepted background work continues |
| `/brief` | Refresh the context brief |
| `/mirror mode:on`, `/mirror mode:off` | Enable/disable transcript and task-result posts |

For voice requests to control mirroring, optionally adapt and install the
[Hermes control skill](deploy/hermes-skill/SKILL.md) through the user's normal
Hermes skill workflow. It needs this checkout's absolute path and the bridge env
file. Direct CLI control needs no global install:

```sh
"$MONTE_NODE" --env-file="$HOME/.config/hlv-discord/env" \
  "$MONTE_CHAT_DIR/bin/hlv-discord-ctl.js" mirror status
```

| Symptom | Check |
| --- | --- |
| Native addon or DAVE binding fails | Compiler/Python prerequisites, supported Node, and a fresh `npm ci` on this machine; do not copy another machine's `node_modules` |
| Bot does not follow/respond | Correct human/server/application IDs, channel permissions, only one bridge process |
| Gateway reconnects continually | Actual port, matching gateway token, pinned package version, `doctor`, and gateway logs |
| Mode controls unavailable | An active call, OpenAI provider, and the bundled v8 gateway as well as SDK |
| Projects missing | Project-root environment loaded by the gateway service, real Git repositories, Git/Python on service PATH |
| `/focus` cannot resolve thread | Prior Hermes text conversation in that thread, matching profile, local readable `state.db` |
| Unreadable saved state | Preserve the file and inspect the error; do not delete state to force startup |

For behavior, diagnostics, persistence, and source layout, see
[operations](docs/operations.md). [Current release details](docs/natural-hermes.md)
and [validation records](docs/natural-hermes-validation.md) describe the existing
deployment; the v7 research rollout is retained only as historical documentation.

## Updating an existing installation

Back up current state, config, and service definitions before an update. Use the
new checkout's lockfile and matching bundled gateway together; rerun the checks
above and retain project-root service settings. Do not replace current task state
with an old backup or change the user's selected profile. The old
`deploy/gateway-monte.conf`, `deploy/hermes-normal-profile.conf`, research setup,
and smoke probes are maintainer deployment artifacts, not templates to apply
blindly to another user's installation. Rollback across gateway versions needs
the release-specific state conversion described in the release docs.
