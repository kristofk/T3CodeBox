# Architecture

## Two images

| Image | Built from | What it adds |
| --- | --- | --- |
| `t3codebox` | `Dockerfile`, `rootfs/` | `t3 serve`, the five provider CLIs, the tools they need, mise, the dashboard |
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
- **Build tools:** `build-essential`, `pkg-config` and the headers of OpenSSL, zlib and libffi, for what
  agents build (Rust links with `cc`; native npm, pip and gem packages compile against these).
- **mise:** the release binary from GitHub, checked against the release's `SHASUMS256.txt`, in
  `/usr/local/bin`, with self-update turned off (`/usr/local/lib/mise/.disable-self-update`). See
  [Toolchains](#toolchains).
- **git:** a system-wide credential helper sends github.com and gist.github.com to `gh`, so a `gh auth login`
  also covers `git push`. `safe.directory '*'` lets any owner's repositories under `/workspace` work.
- **Environment defaults:** `T3CODE_HOST=0.0.0.0`, `T3CODE_PORT=3773`, `T3CODEBOX_VERSION` (the image
  version, since labels are not visible inside the container), `MISE_DATA_DIR=/toolchains`,
  `BASH_ENV=/etc/profile.d/t3codebox-mise.sh`, and `PATH` starting with `/toolchains/shims`.
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
3. Warns when home, `/workspace` or `/toolchains` is not writable, and when `/toolchains` is not a mount
   (a `compose.yaml` from before the toolchains volume).
4. Starts `t3codebox-browser-setup` in the background. It waits up to 30 s for the browser container and then
   adds a `browser` MCP server to each agent's user config, only where one is missing.
5. Starts `t3codebox-shared-skills --watch` in the background: it links the skills in `/skills` in for the agents
   and checks again every minute while the folder is there. Without it, one pass removes links an earlier start
   made, and it ends. See [Hub mode and shared skills](#hub-mode-and-shared-skills).
6. With `T3CODEBOX_HUB_URL` set, or an enrolment left from an earlier start, starts hub mode in the background,
   restarted 30 s after it fails. Otherwise nothing.
7. Starts the dashboard in a restart loop in the background, unless `DASHBOARD=off`. It runs on
   `/usr/local/bin/node` by path, never a mise shim.
8. Replaces itself with the command, `t3 serve` by default. When `t3 serve` exits, tini exits and the
   container stops.

## Users and data

- The image runs as its non-root user (uid/gid 1000 by default). Compose's `user: "${PUID}:${PGID}"`
  changes that, and `docker exec` then runs as the same user, so no root-owned files end up in home.
- Three volumes: home (`/home/t3codebox`: T3's state in `~/.t3`, every provider login, gh, git config, ssh,
  the dashboard's password and sessions in `~/.t3codebox`, mise's settings, trust records and download
  cache), `/workspace` (repositories) and `/toolchains` (what agents install with mise). They're separate so
  logins can be reset without losing repositories, and repositories and toolchains can go on another disk
  without the secrets.
- `/toolchains` is its own top-level mount, not a volume inside home: Docker would create a missing parent
  such as `~/.local/share` as root, and OpenCode keeps its login there.
- `/workspace` never moves: T3 stores projects by absolute path.
- Nothing the image ships lives in home, because a volume is filled from the image only once.

## Toolchains

Agents install languages and tools with mise, without root (#11).

- **Where:** mise's data directory is `/toolchains` (`MISE_DATA_DIR`), the toolchains volume: installs in
  `/toolchains/installs`, downloads in `/toolchains/downloads`, shims in `/toolchains/shims`. Its settings,
  trust records and cache stay in home (`~/.config/mise`, `~/.local/state/mise`, `~/.cache/mise`).
- **Shims first on `PATH`:** a shim runs the version the current directory pins in `mise.toml` or
  `.tool-versions`, installs it on first use if missing, and falls back to the next program on `PATH` when
  nothing is pinned. `PATH` is set in the image, so T3, the agents and every shell they start get it
  without `mise activate`.
- **Before the first install:** mise creates a shim only once a version of the tool is installed, so on a
  fresh volume nothing would catch a pinned version. Two things do:
  - For Node and Python, which the image has, `/usr/local/lib/t3codebox/runtimes` comes next on `PATH`
    with `node`, `npm`, `npx`, `python`, `python3`, `pip` and `pip3`, all links to one script. When the
    directory pins that language (`mise current`), it runs the command through `mise exec`, which installs
    the version; otherwise it runs the image's.
  - For everything else, bash's missing-command hint runs the command through `mise exec` when the
    directory pins a tool that provides it.
  - After that install, the tool's shims exist and take over.
- **The image's Node tools:** Codex, Playwright MCP and `skills` are npm packages whose commands start with
  `#!/usr/bin/env node`, which would find a project's Node through the shims. The Dockerfile rewrites their
  first line to `#!/usr/local/bin/node`, and fails the build if one still uses `env node`. The dashboard is
  started with `/usr/local/bin/node`. OpenCode's command is a native binary; Claude Code, Cursor, Grok
  Build and T3 bring their own runtimes.
- **The image's settings,** in `/etc/mise/config.toml`: `trusted_config_paths = ["/workspace"]`, and
  `github.credential_command = "gh auth token"`, so a `GH_TOKEN` reaches mise too (mise reads gh's stored
  login itself, but not `GH_TOKEN`). A user's `~/.config/mise/config.toml` wins over it.
- **What the agents are told:** `/usr/local/share/t3codebox/agents.md`, a few lines on mise and the missing
  root. Claude Code gets it as `/etc/claude-code/CLAUDE.md`, OpenCode through `instructions` in
  `/etc/opencode/opencode.json`, Codex as `developer_instructions` in `/etc/codex/config.toml`, generated
  at build time. Cursor and Grok Build have no system-wide instructions file.
- **The missing-command hint:** `/etc/profile.d/t3codebox-mise.sh` defines bash's
  `command_not_found_handle`. It finds the mise tool that provides the command (`cargo`: `rust`). If the
  directory pins it, it installs and runs it; otherwise it suggests `mise use <tool>@latest`, or points to
  `mise registry`, and exits 127. Every bash reads it: `bash -c` and scripts through `BASH_ENV`,
  login shells through `/etc/profile`, interactive shells through `/etc/bash.bashrc`.

## The agents' browser tool

- Every agent gets Playwright MCP, attached to the browser container's Chromium through
  `t3codebox-browser-mcp`. That launcher resolves the browser's IP on each start, because DevTools refuses
  Host headers that are not an IP or `localhost`. It passes `--cdp-endpoint http://<ip>:9223`.
- Page snapshots go to `~/.cache/playwright-mcp`, not into the agent's project.
- The registrations, made with `t3codebox-mcp`, each added only when missing and never changed afterwards:
  - Claude Code: `claude mcp add --scope user` (`~/.claude.json`);
  - Codex: `~/.codex/config.toml`;
  - OpenCode: `~/.config/opencode/opencode.json`, skipped when `opencode.jsonc` exists;
  - Cursor: `~/.cursor/mcp.json`;
  - Grok Build: `grok mcp add --scope user` (`~/.grok/config.toml`).
- `BROWSER_MCP=off` skips all of them.
- `t3codebox-mcp add|remove <name>` is the one place that writes MCP entries, for the browser and for a hub. The
  server comes as JSON on stdin, a local command or a URL with headers, so a key in a header is never a command-line
  argument. A local server goes through `claude mcp add` and `grok mcp add` as before; a remote one is written to
  their files directly, in the form their own `mcp add --transport http --header` writes, and a file that gets a key
  is made readable by the user only. `remove` takes out only the named agents' entries whose command or URL is still
  the one given. Names, URLs and header values that could end a TOML or JSON string are refused. A lock in
  `~/.t3codebox` keeps two registrations at one start from overwriting each other.

## Hub mode and shared skills

Off unless set; [docs/hub.md](hub.md) is the user's guide and the protocol.

- **Hub mode** is `rootfs/usr/local/lib/t3codebox-hub/hub.js`, Node's standard library only, started by the
  entrypoint when `T3CODEBOX_HUB_URL` is set or `~/.t3codebox/hub.json` exists. One loop: each step reads the
  settings and the state file, does one thing (enrol, renew, leave, or nothing) and says how long to wait; between
  steps it looks for a request from the dashboard (`~/.t3codebox/hub-request`) every 2 s. It ends once hub mode is
  off and the enrolment is gone.
- **The token for the hub:** `t3 auth pairing create --ttl 5m` for a single-use credential, exchanged at T3's
  `POST /oauth/token` on loopback for an access token with the scopes `orchestration:read orchestration:operate`
  only (see [External tools](external-tools.md#access-tokens-for-other-services)). The pairing's label (`Hub
  <id>`) becomes the session's, which is how the box finds the session to revoke later.
- **State:** `~/.t3codebox/hub.json`, mode 600: the hub's addresses and key, the status and last error, a hash of the
  code it is about, the T3 session the hub holds, and a token minted for an attempt that hasn't got through, reused
  for every retry while it has a day left. The code itself and a delivered token are never kept.
- **Secrets** stay out of logs, command lines and the dashboard: the code and token go only in request bodies, the
  key only in `Authorization` headers and, through `t3codebox-mcp`'s stdin, the agents' configs. Text from a hub is
  shown as one line of plain text.
- **Requests to the hub** never follow redirects, time out after 15 s, and read at most 64 KB. Renewal and leave
  addresses must be on the enrolment address's origin.
- **Tokens it can take back:** a token whose T3 session isn't listed, or with other scopes than asked for, is
  revoked and never sent. A revocation that fails is tried again at later steps (`stale` in the state file), and
  leaving keeps the state until every token is revoked, and only then tells the hub. Renewals are at most once an
  hour; a token revoked by hand (looked for every hour and before every renewal the box makes on its own) makes the
  card show an error instead of a new token.
- **Shared skills:** `t3codebox-shared-skills` links each folder with a `SKILL.md` in `/skills` into
  `~/.agents/skills`, `~/.claude/skills` and `~/.grok/skills` for the agents that are installed, where nothing of
  that name is. The links it made are listed in `~/.t3codebox/shared-skills`; it removes one only when it is in that
  list and still points where it made it. It never writes to `/skills`.

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
  - Behind a proxy that signs users in itself, `DASHBOARD_PROXY_SECRET` (32 characters or more) in the
    `X-T3CodeBox-Proxy-Secret` header signs a request in, compared in constant time like the password, and never for
    a request with `Sec-Fetch-Site: cross-site`. Such a request gets no cookie.
- **Under a path prefix:** every address the page uses is relative, the sign-in is a `fetch`, the cookie has
  `Path=/`, and the server never redirects, so a proxy can serve it under a prefix it strips. The page adds a
  missing trailing slash with `history.replaceState` before its first request.
- **Requests:**
  - POSTs must be JSON, which a cross-site form can't send.
  - The page's Content-Security-Policy allows only its own inline script and style, by hash.
  - Every input is checked before it reaches a CLI: nothing may start with `-`, and ids, names and URLs
    have strict formats. CLIs run with `execFile` or `spawn` and an argument list, never a shell.
- **What it reads:**
  - files: `/proc/self/mountinfo`, the cgroup v2 files, `/proc/<pid>/stat` and `/proc/<pid>/exe`
    (command lines are never read, because T3 passes bearer tokens on them), `SKILL.md` frontmatter;
  - Node's `os`;
  - the CLIs' own status commands, described in [External tools](external-tools.md), and `mise ls` for
    the toolchains, with `du` for their sizes.
  - Environment variables are only checked for being set.
- **Jobs:** slow actions are jobs: skill list, install, update and remove, provider sign-ins and
  sign-outs, removing unused toolchains (`mise prune --yes`), and the hub's Retry and Leave, which leave a request
  for hub mode and wait until its state file changes.
- **Hub card:** the status comes with every health poll, from the state file through the same code hub mode uses,
  without the key or tokens. Skills whose folder is in `/skills` are listed as read-only, and removing one is
  refused.
  - A POST starts one and returns, and the page polls it every second.
  - One job per kind runs at a time, and the latest per kind is kept so a reloaded page picks it up.
  - A job can be stopped, which stops the CLI's whole process group: SIGTERM, then SIGKILL after 10 s.
  - A job can take one line of input (Claude's pasted code).
  - Processes the dashboard starts are left out of the "agents running" count.
- **Restart T3:** SIGTERM to `t3 serve` (the process tini started), then SIGKILL after 10 s. The container's
  restart policy brings it back.
- **QR codes:** its own encoder in `server.js` (byte mode, error correction level M, versions 1–40), for
  pairing links and sign-in links.
- **Tests:** `ci/dashboard.test.js` (`node:test`) runs from `make check` in `node:lts-slim`, and so does
  `ci/hub.test.js` for hub mode, against a fake hub and a fake T3 on loopback. Neither is shipped in the image.
  `ci/scripts.test.sh` tests `t3codebox-mcp` and `t3codebox-shared-skills` with stand-in agent CLIs; `make test`
  runs it in the built image.

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
  - the dashboard: sign-in, status, providers, git author, pairing link with QR code, skills install,
    update and remove, sign-in and sign-out flows, the toolchains list and removing unused ones, Restart T3;
  - no sudo and no Docker socket, a user name for a custom uid;
  - toolchains: the volume and the warning without it, mise's settings, the compiler and headers, a pinned
    Node installing on first use in a project, the image's Node outside it and for the image's tools, a
    pinned tool installing when its command is first run, the missing-command hint, the agents' instructions
    in Codex's and OpenCode's resolved config;
  - the browser's password, cookie and stream;
  - no zombie processes;
  - the MCP registrations, and an agent-side MCP connection driving the browser;
  - with hub mode off, that nothing of it runs; then, with `ci/test.hub.yaml`, a fake hub (`ci/fake-hub.js`) next to
    the box: enrolment, the token's scopes as T3 sees them, the MCP entries next to a user's own, renewal, shared
    skills, no secret in logs or command lines, leaving when the setting goes, Leave and Retry on the dashboard, and
    chosen dashboard and browser passwords that are not printed.
