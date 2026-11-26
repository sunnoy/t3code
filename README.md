<p align="center">
  <img src="./assets/fork/icon-192.png" width="80" height="80" alt="T3C Code icon" />
</p>

<h1 align="center">T3C Code Server</h1>

<p align="center">
  <a href="https://github.com/sunnoy/t3code/releases"><strong>Releases</strong></a> ·
  <a href="./docs/README.md">Documentation</a>
</p>

**The C stands for Clean.** T3C Code is an unofficial, independently maintained **server-focused** fork of [T3 Code](https://github.com/pingdotgg/t3code). It has no affiliation with or endorsement from T3 Tools, Inc. This fork focuses on running a clean, self-hosted T3 server on Linux or macOS and connecting to it from the official desktop/web/mobile clients over localhost or a private network.

T3C Code runs coding agents on your machine under one interface: Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and [ACP](./docs/user/providers-acp.md) agents.

## What changes in this fork

- **Server-first distribution**: Publishes standalone server archives (`linux-x64`, `darwin-arm64`, `darwin-x64`) with the bundled web client and MIT license.
- **No direct credential scraping**: Account and quota checks stay inside each provider's native CLI/runtime. Claude voucher lookup and redemption are removed.
- **No telemetry or T3 Connect**: Telemetry and cloud relay are disabled. Connect directly over localhost, LAN, or VPN/Tailscale.
- **Fork-locked server updates**: `t3 update` and remote server updates pull exclusively from `sunnoy/t3code` Releases, so updating the official macOS desktop app will not overwrite your fork server with upstream binaries.

## Supported Server Archives

Download from [T3C Code Releases](https://github.com/sunnoy/t3code/releases):

| Platform            | Archive                            | Runtime Layout                                                                                                 |
| ------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Linux x64           | `t3-<version>-linux-x64.tar.gz`    | Node single-executable (SEA)                                                                                   |
| macOS Apple Silicon | `t3-<version>-darwin-arm64.tar.gz` | Node single-executable (SEA, ad-hoc signed)                                                                    |
| macOS Intel         | `t3-<version>-darwin-x64.tar.gz`   | Self-contained bundled Node + `./t3` launcher (`exec`, ad-hoc signed; avoids Node SEA segfault on Intel macOS) |

## Install

### Option 1: Install script (Linux x64, macOS arm64, macOS x64)

```sh
curl -fsSL https://raw.githubusercontent.com/sunnoy/t3code/fork/v0.1.12/scripts/install.sh | sh
```

The script verifies `SHA256SUMS`, unpacks into `~/.t3/runtime/versions/<version>/`, and installs the `t3` command into `~/.local/bin/t3`.

### Option 2: Manual archive download

1. Download the archive for your platform from [Releases](https://github.com/sunnoy/t3code/releases) and extract it.
2. On macOS, if downloaded through a browser, clear Gatekeeper quarantine first:

```sh
xattr -dr com.apple.quarantine ./t3-*-darwin-*
```

## Run as a Background Service (Auto-Start & Auto-Restart)

Running T3C Code as a background service keeps the server, active agent tasks, scheduled tasks, and workflows alive even when you close or quit the desktop app.

### Install the service

```sh
./t3 service install
```

- **Linux**: installs and starts a `systemd --user` unit (`~/.config/systemd/user/t3code.service`).
- **macOS (arm64 & Intel x64)**: installs and bootstraps a `launchd` LaunchAgent (`~/Library/LaunchAgents/com.t3tools.t3code.server.plist`) with:
  - `RunAtLoad = true` (starts automatically when you log in)
  - `KeepAlive = true` and `ThrottleInterval = 5` (restarts automatically if killed or crashed)
  - `ProcessType = Interactive` (prevents macOS background throttling)
  - **Double-layer supervision**: `launchd` supervises `t3 __service-launcher`, and `__service-launcher` supervises `t3 serve`. On Intel macOS, `./t3` uses `exec "$DIR/runtime/node" "$DIR/bin.mjs" "$@"`, replacing the shell PID in-place so `launchd` tracks the Node process directly.

### Foreground / LAN run

For a one-off foreground run instead of a background service:

```sh
./t3 serve        # localhost only (127.0.0.1:3773)
./t3 serve --lan  # bind on LAN / private network
```

To configure how other devices reach an installed background service, run:

```sh
t3 up
```

### Day-to-day service commands

```sh
t3 service status      # check installed service and running status
t3 service restart     # restart the background service
t3 service uninstall   # stop and remove the background service
t3 update              # update to the latest fork release from sunnoy/t3code
tail -f ~/.t3/userdata/logs/boot-service.log
```

## Connect the Official macOS App (Local or Remote Server)

You can use the official macOS desktop app (`T3 Code`) as a thin client against either a **local macOS T3C Server** or a **remote Linux T3C Server**:

1. Start T3C Server (`t3 service install` or `./t3 serve --lan`).
2. In the official Mac app **Settings**, turn off **Local environment** (`localEnvironmentEnabled: false`) so the official app's embedded server does not compete for `~/.t3`.
3. On the server host, generate a pairing link:

```sh
t3 pair
```

4. In the Mac app, open **Add environment** (Remote Link) and paste the pairing URL (e.g., `http://127.0.0.1:3773` for a local macOS server, or `http://<lan-ip>:3773` for a LAN Linux server).

Once connected via Remote Link:

- Closing or quitting the Mac app leaves the background server running.
- Use **Remote Link** (not SSH) when pairing the official Mac app with a fork server, so the official client never bootstraps an upstream binary over SSH.

## Sign in to an Agent

Install and sign in to your coding agents on the server host (such as [Claude Code](https://claude.com/product/claude-code) or [Codex CLI](https://developers.openai.com/codex/cli)). See the upstream [provider setup guide](./docs/user/install.md#providers).

## Documentation

- [Install and first run](./docs/user/install.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [FAQ](./docs/user/faq.md)

[All docs](./docs/README.md) has the full list.

## License and attribution

T3C Code is based on T3 Code by T3 Tools, Inc. The source code is distributed under the [MIT License](./LICENSE). The upstream name, logo, and other brand assets are subject to the [upstream trademark policy](./TRADEMARK.md).
