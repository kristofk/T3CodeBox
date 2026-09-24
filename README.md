<picture>
  <source media="(prefers-color-scheme: dark)" srcset="Icon/final/dark/t3codebox-48.svg">
  <img src="Icon/final/light/t3codebox-48.svg" alt="T3CodeBox icon" width="96" height="96">
</picture>

# T3CodeBox

[![Release build](https://github.com/kristofk/T3CodeBox/actions/workflows/release.yml/badge.svg)](https://github.com/kristofk/T3CodeBox/actions/workflows/release.yml)
[![Security scan](https://github.com/kristofk/T3CodeBox/actions/workflows/scan.yml/badge.svg)](https://github.com/kristofk/T3CodeBox/actions/workflows/scan.yml)
[![Latest release](https://img.shields.io/github/v/release/kristofk/T3CodeBox?label=latest&sort=date)](https://github.com/kristofk/T3CodeBox/releases/latest)
[![Released](https://img.shields.io/github/release-date/kristofk/T3CodeBox?label=released)](https://github.com/kristofk/T3CodeBox/releases/latest)
[![T3 Code upstream](https://img.shields.io/github/v/release/pingdotgg/t3code?label=T3%20Code%20stable)](https://github.com/pingdotgg/t3code/releases/latest)
[![Licence](https://img.shields.io/github/license/kristofk/T3CodeBox)](LICENSE)

A container image for the [T3 Code](https://github.com/pingdotgg/t3code) server, the half of T3 Code that runs the coding agents, plus a browser the agents can drive and you can watch and control from any device, including your phone. Put it on a home server and connect from the T3 Code desktop app, the web app or your phone.

Everything works without edits, and every default can be changed in the obvious place.

Unofficial: not affiliated with T3 Code or Ping.

## What you get

| | |
| --- | --- |
| `ghcr.io/kristofk/t3codebox` | `t3 serve` from the official T3 Code release, with Claude Code, Codex, Cursor, Grok Build and OpenCode, `gh`, `git`, `ssh`, `ripgrep`, Node LTS and Python, plus a dashboard that shows the box's health and sign-ins. Runs as a non-root user and needs no Docker socket. |
| `ghcr.io/kristofk/t3codebox-browser` | Chromium on a remote desktop you open in any browser ([linuxserver/chromium](https://docs.linuxserver.io/images/docker-chromium/)), password protected. All five agents get a `browser` tool (Playwright MCP) that drives it. |

Both images support amd64 and arm64. A new build is released automatically when T3 Code publishes a stable release, and only after both architectures pass the tests.

## Quick start

```sh
mkdir t3codebox && cd t3codebox
curl -fsSLO https://raw.githubusercontent.com/kristofk/T3CodeBox/main/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/kristofk/T3CodeBox/main/.env.example
docker compose up -d
```

T3 Code now listens on `127.0.0.1:3773`, the browser's remote desktop on `127.0.0.1:3774` and the dashboard on `127.0.0.1:3772`. All are bound to loopback: put HTTPS in front (next section) before you use them from another device.

The browser and dashboard passwords are printed once in the logs:

```sh
docker logs t3codebox-browser | grep password
docker logs t3codebox | grep 'dashboard password'
```

## Connect

### Tailscale (recommended)

Serve the ports on your tailnet with real HTTPS from the host's Tailscale:

```sh
tailscale serve --bg --https=3773 http://127.0.0.1:3773
tailscale serve --bg --https=3774 http://127.0.0.1:3774
tailscale serve --bg --https=3772 http://127.0.0.1:3772
```

Then create a pairing link for your server's tailnet name and open it on the device you want to connect (desktop app, web app or phone):

```sh
docker exec t3codebox t3 auth pairing create --base-url https://<host>.<tailnet>.ts.net:3773 --ttl 30d
```

A pairing link is a password: do not paste it into chats or logs. List and revoke links with `docker exec t3codebox t3 auth pairing list` and `t3 auth pairing revoke <id>`. Paired devices stay signed in across restarts and updates until 30 days after pairing; then pair them again. The dashboard counts down to each device's expiry.

The desktop app also connects over plain HTTP inside a tailnet; the web app, and the browser's clipboard, need HTTPS.

### T3 Connect

T3's own relay, no port forwarding needed. Works alongside Tailscale.

```sh
docker exec -it t3codebox t3 connect login
docker restart t3codebox
```

### LAN or reverse proxy

- **Reverse proxy** (Caddy, Traefik, nginx, Nginx Proxy Manager): proxy HTTPS to `127.0.0.1:3773`, `127.0.0.1:3774` and `127.0.0.1:3772` with WebSocket support, and use the proxy's URL as `--base-url`.
- **LAN without TLS**: publish on all interfaces by editing the `ports:` lines in `compose.yaml` (`"3773:3773"`). The browser also serves self-signed HTTPS on its port 3001 (`"3775:3001"`); use that one from phones, because the desktop's session cookie needs HTTPS and iOS Safari needs the cookie.

## The dashboard

A status page for the box, made for phones as much as for desktops. Open `https://<host>.<tailnet>.ts.net:3772` (or your proxy URL) and sign in with the dashboard password.

- **Health**, refreshed every 5 seconds: T3 up or down, the image, T3 and provider versions, uptime, CPU and memory against the container's limits, whether the home and workspace folders are mounted (a folder that is not mounted loses its data when the container is recreated), free space, running agents and the browser. Folder sizes on request.
- **Providers**: whether Claude Code, Codex, Cursor, Grok Build, OpenCode and GitHub are signed in, how and as whom, with the sign-in command for the ones that are not.
- **T3 access**: paired devices with a countdown to their expiry, and unused pairing links.
- **Skills**: the skills installed for each agent, the ones synced from claude.ai and Codex's built-in ones.
- **Dashboard devices**: every browser signed in to the dashboard, each with a Sign out button.

Whatever needs attention is red and also listed at the top, such as T3 not answering, a folder that is not mounted, Claude Code billing `ANTHROPIC_API_KEY` to the API, two sign-in methods set for one provider, or a paired device expiring within 7 days. The page shows no secrets; variables in `.env` are only checked for being set.

The generated password is kept in the home volume. Read it with `docker exec t3codebox cat /home/t3codebox/.t3codebox/dashboard-password`, or ask an agent in T3 for it. Set your own with `DASHBOARD_PASSWORD`; changing the password signs every device out. A device stays signed in for a year after it last opened the dashboard, across restarts and updates.

The dashboard runs next to T3 in the same container and never takes T3 down with it. `DASHBOARD=off` turns it off.

## Sign in to the agents

Each provider signs in the way its own CLI does; T3 passes the container environment to them. Run the command, open the printed URL on any device, and paste the code back if asked. Logins live in the home volume and survive updates.

| Provider | Headless sign-in | Or set in `.env` |
| --- | --- | --- |
| Claude Code | `docker exec -it t3codebox claude auth login` | `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY` |
| Codex | `docker exec -it t3codebox codex login --device-auth` (turn on device code sign-in in ChatGPT's security settings first) | `OPENAI_API_KEY` |
| Cursor | | `CURSOR_API_KEY` |
| Grok Build | `docker exec -it t3codebox grok login --device-auth` | `XAI_API_KEY` |
| OpenCode | `docker exec -it t3codebox opencode auth login` | the provider's usual variable |
| GitHub (`gh`, pull requests, `git push`) | `docker exec -it t3codebox gh auth login` | `GH_TOKEN` |

Use one method per provider. Claude Code in particular prefers `ANTHROPIC_API_KEY` over a subscription login and bills the API without asking; check what it uses on the dashboard, with `docker exec t3codebox claude auth status` or on T3's provider card. For several accounts of one provider, add provider instances in T3's settings.

Turn on the providers you use in T3's Settings → Providers; the others do nothing.

Commits: T3 does not set a commit author. Set `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` (and the `GIT_COMMITTER_*` pair) in `.env`, or run `docker exec t3codebox git config --global user.name "..."`. A `gh auth login` also covers `git push` to GitHub.

## Projects

Repositories live in `/workspace`. In T3, **Add Project** (Cmd/Ctrl+K) clones from GitHub or any Git URL into a folder you choose; pick one under `/workspace`.

Existing checkouts in the workspace volume:

```sh
docker exec t3codebox t3 project add /workspace/<repo>
# every repository at once:
docker exec t3codebox bash -c 'for d in /workspace/*/.git; do t3 project add "${d%/.git}"; done'
```

## The browser

Open `https://<host>.<tailnet>.ts.net:3774` (or your proxy URL), sign in as `abc` with the browser password, and you see the Chromium the agents drive. It works from a phone. Sign in to sites there when an agent needs an account.

After the password prompt, a session cookie keeps you signed in (Safari sends no password on the desktop's WebSocket stream, so the cookie carries it). The cookie stops working when the browser container restarts; you are then asked for the password again.

**Caution:** an agent driving a signed-in browser acts on whatever a web page tells it (prompt injection). Sign in only to accounts the agents may touch.

- Set your own password: `BROWSER_PASSWORD` in `.env`. The generated one is kept in `/config/.t3codebox-password` in the browser volume: `docker exec t3codebox-browser cat /config/.t3codebox-password`.
- Browser without the agents' tool: `BROWSER_MCP=off`.
- No browser at all: delete the `COMPOSE_PROFILES=browser` line from `.env`, then `docker compose up -d --remove-orphans`.
- Tab and sidebar title: `T3CodeBox browser`; change it with `TITLE` and `SELKIES_UI_TITLE` in the `browser` service.
- More Chromium flags or desktop settings: every [linuxserver/chromium](https://docs.linuxserver.io/images/docker-chromium/) variable works (for example `CHROME_CLI`), set in the `browser` service.

On start, T3CodeBox adds a `browser` MCP server to each agent's user config (`~/.claude.json`, `~/.codex/config.toml`, `~/.config/opencode/opencode.json`, `~/.cursor/mcp.json`, `~/.grok/config.toml`) when it is missing. It never changes an entry you made; delete or rename the entry to use your own.

## Settings

All in `.env` (see [`.env.example`](.env.example)):

| Variable | Default | |
| --- | --- | --- |
| `COMPOSE_PROFILES` | `browser` | Delete to run without the browser |
| `T3CODEBOX_TAG` | `latest` | Image tag for both images |
| `PUID`, `PGID` | `1000` | User and group of both containers |
| `TZ` | `Etc/UTC` | Time zone |
| `T3CODEBOX_HOSTNAME` | `t3codebox` | Container hostname, and the environment name in T3 Code clients |
| `T3CODEBOX_NAME` | unset | Environment name with spaces or capitals (`Kris's NAS`); wins over the hostname |
| `T3CODE_PORT` | `3773` | Host port of T3 Code (on 127.0.0.1) |
| `BROWSER_PORT` | `3774` | Host port of the remote desktop (on 127.0.0.1) |
| `BROWSER_PASSWORD` | generated | Remote desktop password, user `abc` |
| `BROWSER_MCP` | on | `off`: agents get no browser tool |
| `DASHBOARD_PORT` | `3772` | Host port of the dashboard (on 127.0.0.1) |
| `DASHBOARD_PASSWORD` | generated | Dashboard password |
| `DASHBOARD` | on | `off`: no dashboard |
| `T3CODE_TELEMETRY_ENABLED` | T3's default | `false` turns off T3's anonymous telemetry |

Memory limit: uncomment `mem_limit` in `compose.yaml`. T3's own `T3CODE_*` variables work too; add them to the `environment:` list.

## Data

| Volume | Path | Holds |
| --- | --- | --- |
| `t3codebox-home` | `/home/t3codebox` | T3's state (`~/.t3`: threads, settings, paired devices), every provider login, `gh`, git config, SSH keys, the dashboard password and signed-in devices (`~/.t3codebox`) |
| `t3codebox-workspace` | `/workspace` | Your repositories. The path is fixed: T3 stores projects by absolute path |
| `t3codebox-browser` | `/config` in the browser | Chromium profile, cookies, the browser password |

Home and workspace are separate so you can reset logins without losing repositories, or put repositories on a big disk without the secrets. Back up the home volume like a password store.

### Bind mounts and your own user id

To keep the data in plain folders, change the `volumes:` lines in `compose.yaml` to `./home:/home/t3codebox` and `./workspace:/workspace` in the `t3codebox` service, and `./browser:/config` in the `browser` service.

Create the folders first and give them to the ids in `PUID`/`PGID`:

```sh
mkdir -p home workspace browser && sudo chown 1000:1000 home workspace browser
```

The image runs as `PUID:PGID` (compose `user:`), so `docker exec` commands run as the same user and never leave root-owned files behind. Named volumes only work with the default 1000:1000; for other ids use bind mounts.

## Updating

```sh
docker compose pull && docker compose up -d
```

Tags, the same on both images:

| Tag | Meaning |
| --- | --- |
| `latest` | Newest build that passed the tests |
| `0.0.42` | Newest build for T3 Code 0.0.42; moves on security rebuilds |
| `0.0.42-1`, `0.0.42-2`, … | One exact build, never moves. `-1` is the first build for that T3 Code version, higher numbers are security rebuilds |

The providers are updated only through the image: their self-updaters are off, so every provider's version matches what was tested. Every release lists its exact component versions and test results on the [releases page](https://github.com/kristofk/T3CodeBox/releases).

An update restarts the server and interrupts running agents. Turn on **Continue threads after restarts** in T3's Settings → General to resume them. Watchtower and similar tools work; nothing special is needed.

## Build it yourself

```sh
git clone https://github.com/kristofk/T3CodeBox && cd T3CodeBox
make build test                          # latest stable T3 Code, this machine's architecture
make build T3_VERSION=0.0.42             # a specific T3 Code release
make build PROVIDERS="claude codex"      # only some providers
```

`make build` produces `t3codebox:test` and `t3codebox-browser:test`; set `T3CODEBOX_IMAGE=t3codebox T3CODEBOX_TAG=test T3CODEBOX_BROWSER_IMAGE=t3codebox-browser` to run them with `compose.yaml`. The scripts in `ci/` need bash, Docker with buildx and compose; `DOCKER="sudo -E docker"` if your Docker needs sudo. CI runs the same `make` targets.

## How releases are made

- Every 15 minutes CI checks for a new stable T3 Code release. A new one is built with the newest version of every other component, on native amd64 and arm64 runners, and tested on each: non-root user, health endpoint, T3 version, every provider CLI, pairing link, state across a restart, the dashboard's sign-in and status, no sudo and no Docker socket, the browser and an agent-side connection to it. Only then are the tags moved.
- A daily Trivy scan checks the published images. A critical finding with a fix triggers a rebuild; a high one opens an issue.
- T3 Code preview and nightly builds are not followed.

## Icon

The icon is in [`Icon/`](Icon): SVGs for light and dark backgrounds and PNGs. For a start page such as Homepage, Homarr, Dashy or Unraid, use `https://raw.githubusercontent.com/kristofk/T3CodeBox/main/Icon/final/png/t3codebox-512.png`.

## Licence

MIT for the files in this repository. The images bundle third-party software under its own terms. Claude Code and Cursor are proprietary and need your own accounts, as do the other providers' services.
