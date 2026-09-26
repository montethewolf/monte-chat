# Background services

Start with the [README](../README.md). Use the actual Node, checkout, profile,
gateway CLI, and config paths discovered there. Examples containing `/absolute/`
are templates: replace those paths before installation. Service managers do not
expand the README's shell variables or load your interactive shell configuration.
Do not overwrite existing custom service files without preserving their settings.

## Gateway

The pinned CLI's `setup` normally installs
`dev.hermes-live-voice.gateway` as a Linux systemd user service or a macOS LaunchAgent.
Its generated definition records the absolute Node/CLI paths and
`HERMES_LIVE_CONFIG_FILE`, but **does not inherit your shell's project-root
environment**. Load the extra file from README step 3 as follows.

### Linux

Create the directory if needed:

```sh
mkdir -p "$HOME/.config/systemd/user/dev.hermes-live-voice.gateway.service.d"
```

Write `projects.conf` there with this content:

```ini
[Service]
EnvironmentFile=%h/.config/monte-chat/gateway.env
```

If Git/Python are outside the service's PATH, set the actual PATH in this drop-in
as well, retaining standard system directories. For example, adapt
`Environment="PATH=/absolute/tool/bin:/usr/local/bin:/usr/bin:/bin"`.
The gateway env file can set `HERMES_LIVE_RESEARCH_PYTHON` to an absolute Python path.

Apply the configuration:

```sh
systemctl --user daemon-reload
systemctl --user restart dev.hermes-live-voice.gateway.service
systemctl --user status dev.hermes-live-voice.gateway.service --no-pager
journalctl --user -u dev.hermes-live-voice.gateway.service -n 60 --no-pager
```

Inspect the effective unit to ensure it uses the pinned gateway CLI. Fresh installs
do not need `deploy/gateway-monte.conf`: that old drop-in requires a separate
research service and a maintainer-specific Node path. On an existing installation,
review such overrides deliberately; do not remove a legacy research backend while
it still owns accepted work.

### macOS

The generated plist is
`~/Library/LaunchAgents/dev.hermes-live-voice.gateway.plist`. After setup, edit its
`ProgramArguments` array so the arguments are ordered like this:

```xml
<key>ProgramArguments</key>
<array>
  <string>/absolute/path/to/node</string>
  <string>--env-file=/absolute/home/.config/monte-chat/gateway.env</string>
  <string>/absolute/home/.local/share/monte-chat/gateway/node_modules/hermes-live-voice/dist/cli.js</string>
  <string>serve</string>
</array>
```

Keep the generated `EnvironmentVariables` dictionary, including its actual
`HERMES_LIVE_CONFIG_FILE`. Add an explicit `PATH` there containing Git and Python
if needed; launchd does not inherit your shell's PATH. Escape XML characters in
paths (for example `&` as `&amp;`). Do not insert shell quotes inside strings.

Validate and reload the installed LaunchAgent:

```sh
plutil -lint "$HOME/Library/LaunchAgents/dev.hermes-live-voice.gateway.plist"
launchctl bootout "gui/$(id -u)/dev.hermes-live-voice.gateway"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.hermes-live-voice.gateway.plist"
launchctl print "gui/$(id -u)/dev.hermes-live-voice.gateway"
```

Skip `bootout` if the agent is not loaded. Inspect its `StandardOutPath` and
`StandardErrorPath` for logs. Setup, upgrade, and the pinned CLI's
`service restart` regenerate this plist; reapply the extra env-file argument
after those operations. A routine reload with `launchctl` retains it.

macOS background startup is an installation recipe, not a recorded cross-platform
acceptance result. Use the foreground command in the README until native
dependencies, launchd configuration, and a real Discord call have been verified.

## Discord bridge

Complete the foreground call check first, then stop that foreground process.
Use the same Node executable that passed `npm test`. Never start a second bridge
with the same bot token during service testing.

### Linux bridge

Create `~/.config/systemd/user/hlv-discord.service`, adapting this definition:

```ini
[Unit]
Description=Monte Chat Discord voice bridge
After=network-online.target dev.hermes-live-voice.gateway.service
Wants=network-online.target

[Service]
Type=simple
ExecStart="/absolute/path/to/node" "/absolute/path/to/monte-chat/src/index.js"
EnvironmentFile=%h/.config/hlv-discord/env
WorkingDirectory="/absolute/path/to/monte-chat"
UMask=0077
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Use the user's actual checkout; `deploy/hlv-discord.service` assumes
`~/Development/monte-chat` and is not ready to copy to an arbitrary location.
If the gateway uses another supervisor, adapt the ordering dependency accordingly.

```sh
systemctl --user daemon-reload
systemctl --user enable --now hlv-discord.service
systemctl --user status hlv-discord.service --no-pager
journalctl --user -u hlv-discord.service -n 60 --no-pager
```

For an always-on host whose user services should survive logout, enable lingering
for that user if appropriate to the host: `loginctl enable-linger "$USER"`.
Reconnect from Discord after service startup and repeat the short call check.

### macOS bridge

Create `~/Library/LaunchAgents` if needed and a private log directory, such as
`~/.local/state/hlv-discord`. Write
`~/Library/LaunchAgents/dev.monte-chat.discord.plist` with the following content,
replacing **every** `/absolute/` path and escaping XML characters in paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.monte-chat.discord</string>
  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/to/node</string>
    <string>--env-file=/absolute/home/.config/hlv-discord/env</string>
    <string>/absolute/path/to/monte-chat/src/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>/absolute/path/to/monte-chat</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>/absolute/home/.local/state/hlv-discord/bridge.log</string>
  <key>StandardErrorPath</key><string>/absolute/home/.local/state/hlv-discord/bridge.error.log</string>
</dict>
</plist>
```

Set mode 600 on the plist, then validate and load it in the logged-in user session:

```sh
plutil -lint "$HOME/Library/LaunchAgents/dev.monte-chat.discord.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.monte-chat.discord.plist"
launchctl print "gui/$(id -u)/dev.monte-chat.discord"
```

If already loaded, `launchctl bootout "gui/$(id -u)/dev.monte-chat.discord"` before
bootstrapping the updated definition. LaunchAgents run in the user's login session;
this does not establish startup before login. Check both logs and repeat the call
check after loading it.

## Stopping and troubleshooting

On Linux use `systemctl --user stop hlv-discord.service` to stop the bridge, and
the corresponding gateway unit to stop the voice gateway. On macOS use `bootout`
with the relevant label as shown above. Stopping the bridge detaches the call;
it does not cancel accepted Hermes work. Check active tasks before stopping a
gateway for upgrades.

Keep the absolute pinned CLI path for `doctor`, `launch-check`, and gateway service
commands. Ensure its shell uses the same `HERMES_HOME` and
`HERMES_LIVE_CONFIG_FILE` as installation. Inherited shell environment can override
managed config, so compare the effective service config when a foreground process
works but a background process fails. Avoid pasting secret-bearing config or
environment dumps into support messages.
