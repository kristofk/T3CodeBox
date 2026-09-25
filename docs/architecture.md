# Architecture

## Two images

| Image | Built from | What it adds |
| --- | --- | --- |
| `t3codebox` | `Dockerfile`, `rootfs/` | `t3 serve`, the five provider CLIs, the tools they need, the dashboard |
| `t3codebox-browser` | `browser/` | Chromium on linuxserver's remote desktop, with DevTools reachable by the agents |

Both images are released together, with the same tags, for amd64 and arm64.

### t3codebox

- **Base:** `debian:trixie-slim`, with `apt-get upgrade` at build time so Debian's security fixes reach every
  build. dpkg runs with `force-unsafe-io`, because unpacking on slow storage otherwise takes many minutes.
- **Node:** the newest LTS from nodejs.org, checksum-verified. It's for Codex, OpenCode, Playwright MCP,
  `skills` and the dashboard; T3 embeds its own Node.
- **T3 Code:** the official release tarball, checksum-verified, in `/opt/t3`, linked as `t3`. It needs
  `libatomic1`, which `trixie-slim` lacks.
- **Providers:** installed in system locations, never in home, with their self-updaters off
  (`DISABLE_AUTOUPDATER=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`). The image is the only update path, so every
  provider version is one that was tested.
  - Claude Code: the native binary from `downloads.claude.ai`, checked against the release manifest's
    SHA-256, in `/usr/local/bin`.
  - Cursor: the tarball whose URL `cursor.com/install` names, in `/opt/cursor-agent`. No checksum is
    published.
  - Grok Build: the binary named by `x.ai/cli/stable`, in `/usr/local/bin`. No checksum is published.
  - Codex (`@openai/codex`), OpenCode (`opencode-ai`), Playwright MCP (`@playwright/mcp`) and `skills`: with
    `npm install -g`.
  - The `PROVIDERS` build argument drops providers for a slimmer self-built image.
- **Other tools:** `gh` from GitHub's apt repository (T3 refuses gh older than 2.81), git, ssh, ripgrep,
  jq, python3, make, procps, tzdata, `libnss-wrapper`, `tini`.
- **git:** a system-wide credential helper sends github.com and gist.github.com to `gh`, so a `gh auth login`
  also covers `git push`. `safe.directory '*'` lets any owner's repositories under `/workspace` work.
- **Environment defaults:** `T3CODE_HOST=0.0.0.0`, `T3CODE_PORT=3773`, `T3CODEBOX_VERSION` (the image
  version, since labels are not visible inside the container).
- **Health check:** `GET /.well-known/t3/environment` every 30 s. T3 has no other health endpoint.

### t3codebox-browser

`lscr.io/linuxserver/chromium` with three changes:

- Chromium's flags `--user-data-dir=/config/profile --remote-debugging-port=9222
  --hide-crash-restore-bubble` are appended to linuxserver's `wrapped-chromium`, after `"$@"`, so they win
  and `CHROME_CLI` stays free for the user.
- An s6 service runs `socat` from port 9223 on the stack's private network to Chromium's loopback-only
  DevTools port 9222.
- An s6 oneshot generates the remote desktop password when `BROWSER_PASSWORD` is unset (kept in
  `/config/.t3codebox-password`, printed once), and writes a new session-cookie token on every start. A
  patched nginx config accepts that cookie in place of the password, because iOS Safari sends no basic-auth
  credentials on WebSockets and the desktop's stream is a WebSocket.

`TITLE` and `SELKIES_UI_TITLE` are set to "T3CodeBox browser".

## What runs in the main container

`tini` is PID 1 and runs `t3codebox-entrypoint`, which:

1. Rewrites nss_wrapper's copies of `passwd` and `group` (`/etc/t3codebox/`, loaded through `LD_PRELOAD`)
   so the uid the container runs as is the user `t3codebox`. This also covers `docker exec` under a custom
   uid.
2. Writes `T3CODEBOX_NAME` to `/etc/machine-info` as `PRETTY_HOSTNAME`, which T3 shows as the environment
   name ahead of the hostname.
3. Warns when home or `/workspace` is not writable.
4. Starts `t3codebox-browser-setup` in the background. It waits up to 30 s for the browser container and then
   adds a `browser` MCP server to each agent's user config, only where one is missing.
5. Starts the dashboard in a restart loop in the background, unless `DASHBOARD=off`.
6. Replaces itself with the command, `t3 serve` by default. When `t3 serve` exits, tini exits and the
   container stops.

## Users and data

- The image runs as its non-root user (uid/gid 1000 by default). Compose's `user: "${PUID}:${PGID}"`
  changes that, and `docker exec` then runs as the same user, so no root-owned files end up in home.
- Two volumes: home (`/home/t3codebox`: T3's state in `~/.t3`, every provider login, gh, git config, ssh,
  the dashboard's password and sessions in `~/.t3codebox`) and `/workspace` (repositories). They're separate
  so logins can be reset without losing repositories, and repositories can go on another disk without the
  secrets.
- `/workspace` never moves: T3 stores projects by absolute path.
- Nothing the image ships lives in home, because a volume is filled from the image only once.

## The agents' browser tool

- Every agent gets Playwright MCP, attached to the browser container's Chromium through
  `t3codebox-browser-mcp`. That launcher resolves the browser's IP on each start, because DevTools refuses
  Host headers that are not an IP or `localhost`. It passes `--cdp-endpoint http://<ip>:9223`.
- Page snapshots go to `~/.cache/playwright-mcp`, not into the agent's project.
- The registrations, each added only when missing and never changed afterwards:
  - Claude Code: `claude mcp add --scope user` (`~/.claude.json`);
  - Codex: `~/.codex/config.toml`;
  - OpenCode: `~/.config/opencode/opencode.json`, skipped when `opencode.jsonc` exists;
  - Cursor: `~/.cursor/mcp.json`;
  - Grok Build: `grok mcp add --scope user` (`~/.grok/config.toml`).
- `BROWSER_MCP=off` skips all of them.

## The dashboard

A status page with settings, served on port 3772 by `rootfs/usr/local/lib/t3codebox-dashboard/`:
`server.js` (Node's standard library only) and `index.html` (plain HTML, CSS and JavaScript, no build
step). The icon is copied from `Icon/final/adaptive/` at build time.

- **Sign-in:**
  - The password is `DASHBOARD_PASSWORD`, or one generated on first start into
    `~/.t3codebox/dashboard-password` (mode 600) and printed once.
  - Passwords are compared in constant time, and each wrong password waits a second, one at a time.
  - Each signed-in device gets a random cookie (`HttpOnly`, `SameSite=Strict`, not `Secure` so plain HTTP
    in a tailnet works).
  - `~/.t3codebox/dashboard-sessions.json` keeps a SHA-256 of each cookie, a label from the user agent and
    the sign-in and last-use times. A session lasts a year from its last use.
  - The file also keeps a scrypt fingerprint of the password, so a new password signs every device out.
- **Requests:**
  - POSTs must be JSON, which a cross-site form can't send.
  - The page's Content-Security-Policy allows only its own inline script and style, by hash.
  - Every input is checked before it reaches a CLI: nothing may start with `-`, and ids, names and URLs
    have strict formats. CLIs run with `execFile` or `spawn` and an argument list, never a shell.
- **What it reads:**
  - files: `/proc/self/mountinfo`, the cgroup v2 files, `/proc/<pid>/stat` and `/proc/<pid>/exe`
    (command lines are never read, because T3 passes bearer tokens on them), `SKILL.md` frontmatter;
  - Node's `os`;
  - the CLIs' own status commands, described in [External tools](external-tools.md).
  - Environment variables are only checked for being set.
- **Jobs:** slow actions are jobs: skill list, install and remove, and provider sign-ins.
  - A POST starts one and returns, and the page polls it every second.
  - One job per kind runs at a time, and the latest per kind is kept so a reloaded page picks it up.
  - A job can be stopped, which stops the CLI's whole process group: SIGTERM, then SIGKILL after 10 s.
  - A job can take one line of input (Claude's pasted code).
  - Processes the dashboard starts are left out of the "agents running" count.
- **Restart T3:** SIGTERM to `t3 serve` (the process tini started), then SIGKILL after 10 s. The container's
  restart policy brings it back.
- **QR codes:** its own encoder in `server.js` (byte mode, error correction level M, versions 1–40), for
  pairing links and sign-in links.
- **Tests:** `ci/dashboard.test.js` (`node:test`) runs from `make check` in `node:lts-slim`. It isn't shipped
  in the image.

## CI and releases

- **Portable CI:** all logic lives in `ci/*.sh` behind the `Makefile`. The GitHub workflows only call make
  targets, and `ci/forge.sh` is the only GitHub-specific script (releases and issues through `gh`). The same
  targets run locally with Docker.
- **Workflows:**
  - `pr.yml`: `make check`, then `make build test` on native amd64 and arm64 runners, for every pull request.
  - `edge.yml`: every push to `main` (Markdown-only changes skipped) runs the same build and test and moves
    the `edge` tag.
  - `release.yml`: every 15 minutes `make upstream` checks for a new T3 Code stable release; "Run workflow"
    rebuilds on demand. Each architecture runs `make build test publish` and pushes by digest without a tag.
    `make release` then combines the digests with `docker buildx imagetools create`, moves the tags and
    writes the GitHub release with component versions and test results.
  - `scan.yml`: a daily Trivy scan of `latest`. A critical finding with a fix triggers one rebuild, and its
    fingerprint goes into the release notes, so the same findings afterwards open an issue instead of
    looping. A high one opens an issue.
  - Build and test jobs stop after 30 minutes.
- **Tags**, the same on both images:
  - `latest`;
  - `<t3>`, e.g. `0.0.42`, which moves on rebuilds;
  - `<t3>-<n>`, immutable, where `n` counts builds of that T3 version;
  - `edge`, the newest `main`, with image version `<t3>-edge.<commit>`.
- **What `make test` checks** (`ci/test.sh`, one PASS/FAIL line each, all in the release notes):
  - non-root user, health endpoint, hostname and environment name, T3 version;
  - every CLI's version;
  - pairing link, state across a restart;
  - the dashboard: sign-in, status, providers, git author, pairing link with QR code, skills install and
    remove, sign-in flows, Restart T3;
  - no sudo and no Docker socket, a user name for a custom uid;
  - the browser's password, cookie and stream;
  - no zombie processes;
  - the MCP registrations, and an agent-side MCP connection driving the browser.
