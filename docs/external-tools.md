# External tools

What T3 Code, the provider CLIs, `skills` and Chromium actually do, as far as T3CodeBox relies on it. Each
section says which versions it was checked against. When a new version behaves differently, fix the code
and this page together.

## T3 Code (0.0.42)

- **Release asset:** `t3-<version>-linux-{x64,arm64}.tar.gz` with `SHA256SUMS` on the GitHub release.
  - It's one self-contained `t3` executable with Node embedded, prebuilt native modules, the web client
    (`client/`) and a `resource-monitor` helper. It needs glibc 2.34 or newer and `libatomic.so.1`.
  - About 61 MB compressed, 205 MB unpacked. `t3 --version` prints `t3 v0.0.42`.
- **`t3 serve`:** reads `T3CODE_HOST`, `T3CODE_PORT` (default 3773) and `T3CODE_HOME` (default `~/.t3`).
  It's headless and doesn't open a project from its working directory.
  - Every start prints a banner with a short-lived pairing token, a URL for the container's own address and
    a QR code. `ci/test.sh` keeps that out of logs it prints.
- **Health:** there is no `/api/health`; `GET /.well-known/t3/environment` answers when the server is up.
  - It returns JSON with `serverVersion` and `label`, the environment name: `PRETTY_HOSTNAME` from
    `/etc/machine-info`, else the hostname.
- **State** is all under `T3CODE_HOME`:
  - `userdata/`: `state.sqlite`, `secrets/`, `logs/`, `settings.json`, `attachments/`, `browser-artifacts/`;
  - `caches/`, `worktrees/`, `tools/`. Antigravity's ACP adapter is installed here by T3 itself.
  - Paired devices live in `state.sqlite` and survive restarts and upgrades.
- **Logs:** `userdata/logs/server.trace.ndjson`, one JSON span per line: HTTP requests, WebSocket upgrades,
  session checks, RPC calls. Rotation keeps 10 files of 10 MiB, about 10 hours at light use (#20).
- **Pairing:**
  - `t3 auth pairing create --base-url <url> --ttl <ttl> --label <label> --json` prints `id`, `credential`
    (a 12-character code), `label`, `scopes`, `expiresAt` and `pairUrl` (`<base>/pair#token=<credential>`).
    Links are single-use.
  - `t3 auth pairing list --json` shows unused links (`id`, `label`, `scopes`, `createdAt`, `expiresAt`),
    never the links themselves. `t3 auth pairing revoke <id>` revokes one.
  - `t3 auth session list --json` shows paired clients: `sessionId`, `method`, `scopes`, `client` (`label`,
    `ipAddress`, `userAgent`, `deviceType`, `os`, `browser`), `issuedAt`, `expiresAt` (30 days after pairing),
    `lastConnectedAt`, `connected`. `connected` read `false` for a client that was connected, so don't rely
    on it. `t3 auth session revoke <sessionId>` revokes one.
  - All of these work while `t3 serve` runs.
  - `t3 pair` prints a pairing link and a terminal QR code, but has no `--base-url`. In a container it
    advertises the container's own address, which other devices can't reach.
  - T3 draws QR codes only inside itself: the terminal output above, and the app's Settings → Connections.
    There is no command that returns one.
- **Projects:** `t3 project add <path> [--title]`, `remove`, `rename`. It works against a running server and
  refuses duplicates.
- **T3 Connect:** `t3 connect login` in the container, then a restart; the link takes effect on the next
  server start. Signing in to T3 Connect from the self-hosted web client fails, because its sign-in keys
  are limited to t3.codes.
- **Remote access:** the client talks to the server over one WebSocket. The hosted web app and the browser's
  clipboard need HTTPS; the desktop app also works over plain HTTP inside a tailnet.
  - `t3 serve --tailscale-serve` needs `tailscaled` in the same environment, so in a container use the
    host's `tailscale serve`.
- **Providers:** T3 runs each provider's CLI with the server's environment and never reads provider
  credentials itself. It finds the binaries on `PATH`, as `claude`, `codex`, `cursor-agent`, `grok` and
  `opencode`.
  - Its in-app "Update now" only runs an installer it can prove owns the binary, so it leaves the image's
    providers alone.
- **Pull requests** go through `gh`; pushes use plain `git` with whatever credentials are set up.
- **Updates:** clients show a notice when the server is behind. A server update interrupts running agents;
  "Continue threads after restarts" resumes supported threads.
- **Release trains:** stable (about 1.6 a week, often with next-day follow-ups), preview (the maintainers'
  pipeline tests, never offered as updates) and nightly (every 30 minutes when `main` changed). Stable is a
  rebuild of the latest nightly's commit.
- T3 declined official container support (pingdotgg/t3code#5287).

## Provider CLIs

Checked in the image with Claude Code 2.1.280–281, Codex 0.156–0.157, Cursor 2026.09.18–23, Grok Build
1.0.41, OpenCode 1.18.32 and gh 2.101.0.

### Where logins live

| Provider | Login stored in | Or from the environment |
| --- | --- | --- |
| Claude Code | `~/.claude/.credentials.json`, `~/.claude.json` | `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` |
| Codex | `~/.codex/auth.json` | see #36 |
| Cursor | `~/.config/cursor/` | `CURSOR_API_KEY` |
| Grok Build | `~/.grok/auth.json` | `XAI_API_KEY` |
| OpenCode | `~/.local/share/opencode/auth.json` | the providers' usual variables |
| GitHub (`gh`) | `~/.config/gh/hosts.yml` | `GH_TOKEN` |

Claude Code's precedence: a cloud provider, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper`,
`CLAUDE_CODE_OAUTH_TOKEN`, Anthropic profiles, then the login. In non-interactive use, which is how T3
runs it, `ANTHROPIC_API_KEY` always wins, so it bills the API even next to a subscription login.
`claude setup-token` prints a one-year subscription token that can't use Remote Control or claude.ai
connectors.

### Status commands

- `claude auth status --json`:
  - `loggedIn`, `authMethod`, `email`, `subscriptionType`, and exit 1 when signed out.
  - `authMethod` is `claude.ai`, `oauth_token` (with `CLAUDE_CODE_OAUTH_TOKEN`), `api_key` (with only
    `ANTHROPIC_API_KEY`) or `none`.
  - With `ANTHROPIC_API_KEY` next to a login it keeps `claude.ai` but adds
    `"apiKeySource": "ANTHROPIC_API_KEY"` and nulls the email: the key wins.
- `codex login status` prints text:
  - "Logged in using ChatGPT", "Logged in using an API key - sk-…" (a masked key; the dashboard keeps only
    the method), or "Not logged in" with exit 1.
  - With only `OPENAI_API_KEY` set it still says "Not logged in" (#36).
- `cursor-agent status --format json`: `status`, `isAuthenticated`, `hasAccessToken`, `hasRefreshToken`,
  `message`. A made-up `CURSOR_API_KEY` still reads unauthenticated.
- Grok Build has no status command; a login is `~/.grok/auth.json`.
- `opencode auth list` prints clack output with ANSI codes:
  - a "Credentials" block, and, when provider variables are set, an "Environment" block;
  - each entry is a `●  <Provider> <type or VARIABLE>` line, with the last word dimmed.
- `gh auth status --json hosts`: for each host, a list of accounts with `state`, `active`, `login`,
  `tokenSource` (a file path or `GH_TOKEN`) and `scopes`. It never includes the token.
  - Signed out: `{"hosts":{}}` and exit 0. The text form `gh auth status` prints a masked token line instead.

### Headless sign-in

Checked without a terminal, the way the dashboard runs them.

| Provider | Command | What it prints and waits for |
| --- | --- | --- |
| Claude Code | `claude auth login` | `https://claude.com/cai/oauth/authorize?…` and `Paste code here if prompted >`. It reads the pasted `code#state` from stdin; the PKCE challenge and state live in that process. A wrong code fails in about 3 s with "Login failed: Request failed with status code 400" and exit 1. |
| Codex | `codex login --device-auth` | https://auth.openai.com/codex/device and a code like `ABCD-12345` (valid 15 minutes). Device code sign-in must be on in ChatGPT's security settings. The default `codex login` needs a callback on port 1455 on the server instead. |
| Cursor | `cursor-agent login` with `NO_OPEN_BROWSER=1` | A `https://cursor.com/loginDeepControl?…` link, then it waits. |
| Grok Build | `grok login --device-auth` | `https://accounts.x.ai/oauth2/device?user_code=…` and the same code on its own line. |
| GitHub | `gh auth login --hostname github.com --git-protocol https --web --skip-ssh-key` | The code and https://github.com/login/device. A clipboard warning comes first. It refuses while `GH_TOKEN` is set. |
| OpenCode | `opencode auth login` | A menu of providers, then of methods, which needs a terminal. `-p <provider>` and `-m <method>` skip the menus; the methods differ per provider (#37). |

The codes look like `XXXX-XXXX` or `XXXX-XXXXX`. Grok's link carries the code and Claude's has `code=true`, so
read the code only after taking the links out.

### Processes

How to tell which agent a process is, without reading command lines (T3 passes tokens on them):

- Claude Code (`/usr/local/bin/claude`), Codex (the native `bin/codex` inside the npm package, plus a
  `codex-code-mode-host` helper), Grok Build and OpenCode (`opencode-ai/bin/opencode.exe`) show up by
  `/proc/<pid>/comm` or `/proc/<pid>/exe`.
- Cursor runs as its bundled `/opt/cursor-agent/node`, with comm `MainThread`, so only the exe path tells.
- Node 24 names its main thread `MainThread`; T3's embedded Node names it `node-MainThread`.
- Codex's npm wrapper runs the native binary as a child. To stop a Codex sign-in, stop the whole process
  group, or the native binary keeps polling.

## skills (1.7.0)

The `skills` CLI from npm, which installs agent skills from GitHub repositories:

- **Global installs** (`-g`) copy a skill to `~/.agents/skills/<name>`. For Claude Code and Grok Build it
  links the copy into `~/.claude/skills` and `~/.grok/skills`. Codex, Cursor and OpenCode are "universal"
  agents that read `~/.agents/skills` directly. A lock file is kept in `~/.agents/.skill-lock.json`. In an
  empty home, it creates `~/.claude/skills` itself.
- **`skills add <repo> -l`** lists a repository's skills on stdout. The output is clack's, with spinner
  redraws (`ESC[1G ESC[J`). Under "Available Skills", a name follows `│` and four spaces, and its
  description six. `--json` can't be combined with `-l`.
- **`skills add <repo> --skill <name> -g -y --agent <agents…> --json`**:
  - prints a JSON array on stdout (`name`, `status`, `agents`, `mode`, `security` with `gen`, `socket`,
    `snyk`) and progress on stderr;
  - an unknown skill fails with "No matching skills found for: <name>".
- **`skills remove <folder> -g -y`** matches folder names, also for skills copied in by hand, and removes the
  copy, the links and the lock entry.
- It asks skills.sh for the security checks and reports installs to it, unless `DO_NOT_TRACK` or
  `DISABLE_TELEMETRY` is set.
- When it runs inside an agent, it detects that and installs without asking.

Other skill folders:
- claude.ai syncs skills into `~/.claude/skills/synced/<org>/`.
- Codex ships built-in skills in `~/.codex/skills/.system/`.
- `~/.codex/.tmp/` is Codex's plugin cache, not installed skills.

## Chromium and linuxserver/chromium

- **DevTools:**
  - Since Chromium 113, `--remote-debugging-address` is ignored, and DevTools listens on loopback only,
    headless or not.
  - Since Chrome 136 the debugging port opens only with a non-default `--user-data-dir`.
  - DevTools rejects Host headers that are not an IP or `localhost`.
  - The working pattern: a forwarder in the browser's network namespace, with clients connecting by IP.
    `webSocketDebuggerUrl` then carries that IP and the forwarded port.
  - Playwright's `connectOverCDP` sends no Origin, so no `--remote-allow-origins` is needed.
- **Playwright MCP:**
  - It needs Node 18 or newer, and `--cdp-endpoint` attaches it to a running browser. It reuses the
    existing tab, so what an agent drives is what the remote desktop shows.
  - It writes page snapshots to `.playwright-mcp/` in its working directory, which is the agent's project,
    unless given `--output-dir`.
- **linuxserver/chromium:**
  - It runs Selkies (not KasmVNC) in `websockets` mode by default, on Wayland (labwc). nginx serves port
    3000 (HTTP, for use behind TLS) and port 3001 (self-signed HTTPS).
  - Basic auth comes from `PASSWORD`, written by the `init-nginx` oneshot; the user is `CUSTOM_USER`,
    default `abc`. The profile lives in `/config`. Extra flags go in `CHROME_CLI`. It supports amd64 and
    arm64 on Debian trixie. The base has no `socat`.
  - `wrapped-chromium` passes a bare `--user-data-dir`; flags appended after `"$@"` win.
  - The desktop's stream is a WebSocket at `/websocket`, behind the same basic auth. iOS Safari sends no
    basic-auth credentials on WebSockets and asks for the password again forever.
- chrome-devtools-mcp needs Node 20.19+ or 22.12+ and targets Google Chrome (#12).

## Docker

- **`docker exec`:** a `docker exec` running while its container restarts can hang with no time limit. Put
  `timeout` on docker calls in scripts that restart containers.
- **cgroup v2:**
  - `memory.current` includes the page cache; `docker stats` subtracts `inactive_file` from `memory.stat`.
  - `memory.max` and `cpu.max` read `max` without a limit.
  - `/proc/uptime` and the load average are the host's. A container's uptime comes from PID 1's start
    time (`/proc/1/stat` field 22, in ticks of 1/100 s).
- **Mounts:** in `/proc/self/mountinfo`, a named volume's root ends in `/volumes/<name>/_data`. A bind
  mount's root is the path inside its source file system, not the host path.
