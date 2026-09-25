# Decisions

What was decided, and why. Change an entry when the decision changes, and say why in the pull request.

## Principle

T3CodeBox is for developers who want everything working out of the box, and at the same time for people
who know containers and want every default easy to change. Every default works without edits; every default
can be changed in the obvious place: `.env`, `compose.yaml` or a build argument.

## Names

The product is **T3CodeBox**, in titles, docs and release names. Everything Docker or a command needs is
lowercase `t3codebox`: images, compose project, containers, volumes, the image's user and its home. The
repository keeps the capitals; GitHub URLs ignore case. Our own settings are uppercase (`T3CODEBOX_TAG`,
`BROWSER_PASSWORD`, `DASHBOARD_PORT`, …); `T3CODE_*` stays T3's own.

## The image

1. **All five providers in one image:** Claude Code, Codex, Cursor, Grok Build and OpenCode. A provider that
   isn't turned on in T3's Settings → Providers does nothing, so there's no runtime opt-out. People who
   build their own image can drop providers with the `PROVIDERS` build argument.
2. **The image is the only update path.** Providers go in system locations with their self-updaters off, so
   every provider version in a release is the one that passed the tests. A new release comes with every new
   T3 Code stable, and security rebuilds pick up newer components.
3. **Non-root, no sudo, no Docker socket.** The image runs as its own user. Compose's `user:` sets the uid, and
   nss_wrapper gives any uid a user name, so `docker exec` works as the same user and leaves no root-owned
   files in home.
4. **Three volumes.** Home holds state and logins; `/workspace` holds repositories; `/toolchains` holds
   what agents install with mise. They have different sizes, sensitivity and lifecycles: logins can be
   reset without losing repositories, repositories and toolchains can go on a big disk without the secrets,
   and toolchains can be deleted and installed again. The `/workspace` path never changes, because T3 stores projects by
   absolute path.
5. **Loopback ports.** Every port is published on `127.0.0.1` only, with HTTPS in front from the host's
   `tailscale serve` or a reverse proxy. Plain LAN access is a documented edit of the `ports:` lines.
6. **No sign-in code in the image.** T3 passes the environment to the provider CLIs, so every sign-in
   method a CLI supports works, and the README shows each one's headless command. One method per provider:
   Claude Code in particular prefers `ANTHROPIC_API_KEY` over a subscription login and bills the API.
7. **No automatic project registration.** T3's Add Project clones into `/workspace`; existing checkouts are
   added with `t3 project add` (#6).

## The browser

8. **A separate container on linuxserver/chromium.** It's a phone-usable remote desktop with a password,
   maintained by linuxserver, available for amd64 and arm64. Being a separate container keeps site cookies
   away from the agents' credentials, lets the browser restart on its own, and adds no weight for people who
   turn it off.
   - Considered and not used: neko (better mobile input, but needs a UDP port range, which is awkward behind
     loopback and Tailscale), Kasm images (weaker outside Kasm Workspaces), browserless (headless only).
   - T3's own preview browser lives in the client, on the user's computer, so it can't be what agents on a
     server drive.
9. **On by default.** The browser is a compose profile that `.env.example` turns on. One deleted line turns
   it off. Its password is generated on first start unless set.
10. **One browser tool for all agents: Playwright MCP,** installed in the image, not fetched with `npx`. It's
    registered in each agent's user config only when missing, and never changed afterwards.
    chrome-devtools-mcp may come as an opt-in second tool (#12).

## Releases and CI

11. **Stable only.** A new T3 Code stable release triggers a build with the newest version of everything
    else. T3's preview and nightly builds aren't followed (#2).
12. **Tested before tagged.** Each architecture is built and tested on a native runner and pushed by digest.
    Only when all pass are the tags moved and the release written.
13. **Security rebuilds.** The daily Trivy scan rebuilds on a critical finding that has a fix, and opens an
    issue for a high one. Unfixed findings are ignored. "Run workflow" rebuilds by hand for what the scanner
    can't see, like T3's embedded Node or Claude Code's native binary.
14. **Tags:**
    - `latest`, then `<t3>` (moves on rebuilds), then `<t3>-<n>` (never moves).
    - There's no `0.0` tag while T3 is at 0.0.x.
    - **`edge`** is the newest `main`, tested the same way but not released, so a change can be tried on a
      real box first. It isn't advertised beyond the README's tags table. `edge` and `latest` share the home
      volume format, so switching back to `latest` keeps the data.
15. **Portable CI.** All logic is in `ci/*.sh` behind `make`, so the same targets run locally and in CI, and
    moving to another forge means replacing `ci/forge.sh`.
16. **Unofficial and MIT.** MIT covers the files in this repository. The images bundle third-party
    software under its own terms, and Claude Code and Cursor need the user's own accounts.

## The dashboard (#19)

17. **In the main image, not the browser container.** Only the main container can read the logins, skills and
    T3's state and run the CLIs, without a Docker socket.
18. **Node's standard library only:** one server file and one plain page, with no npm packages, framework or
    build step. It starts from the entrypoint in a restart loop, so a crash never takes T3 down.
    `DASHBOARD=off` turns it off.
19. **One password, then per-device sessions.** The bar is the same as T3's: network access plus one
    credential. The dashboard can pair devices and install skills, so its password is worth as much as a
    shell in the container. Devices stay signed in for a year from last use; a new password signs every
    device out.
20. **It drives the real CLIs.** It uses the CLIs' own status and sign-in commands and T3's `auth`
    commands, rather than reading or writing their files. Environment variables are only checked for
    being set. Command lines are never read.
21. **Slow actions are server-side jobs** that the page polls every second, rather than a live stream. A
    job keeps running when a phone locks or the page reloads, and the page picks it up again.
22. **The `skills` CLI is installed in the image,** like the other tools, so the tested version ships. The
    skills it installs live in the home volume and are never pinned.
23. **Its own QR encoder.** T3 draws QR codes only inside itself, and the dashboard is how the first device
    gets paired, before any T3 app is. The encoder is checked against a reference library.
24. **Sign-in through the providers' headless flows,** with the link, the code and a QR code on the page.
    - OpenCode keeps its terminal command, because its sign-in is a different menu per provider (#37).
    - API keys aren't typed into the page: they're long-lived secrets and stay in `.env`.
    - GitHub isn't offered while `GH_TOKEN` is set, because gh uses the token and won't store a sign-in.

## Toolchains (#11)

26. **mise installs what agents need, without root.** Considered and not used: asdf (slower, a plugin per
    language), Nix and devbox (large, awkward without root), Homebrew on Linux (its own prefix, compiles
    often). mise reads `.tool-versions` too, downloads prebuilt Node, Python, Ruby, Go and Java, and its
    registry covers many CLIs, which matters where nobody can `apt-get`.
27. **mise's defaults, with two exceptions.** Pinned versions install on first use and `.nvmrc`-style files
    are ignored, as mise does; `MISE_IDIOMATIC_VERSION_FILE_ENABLE_TOOLS` turns those on. The exceptions:
    `mise.toml` files under `/workspace` are trusted, because an agent runs the repository's code anyway,
    and mise asks `gh` for a GitHub token, so `GH_TOKEN` counts too.
28. **Shims first on `PATH`, the image's tools on the image's Node.** A repository's pinned Node or Python
    applies to what agents run; the image's Node tools and the dashboard run `/usr/local/bin/node` by path,
    so a pin never breaks Codex or the browser tool. Shims last would have silently ignored exactly those
    pins. So would a fresh volume, which has no shims yet: a stand-in for Node and Python and the
    missing-command hint install a pinned version on first use there too.
29. **A C compiler and a few headers in the image,** about 250 MB: Rust can't link without `cc`, and native
    packages need OpenSSL, zlib and libffi. Erlang and PHP, which build from source with many more
    libraries, are for images built on this one (#13).
30. **No toolchains in the image.** Everything beyond the image's Node and Python installs on first use into
    the volume, so the image and its release scope stay as they were.
31. **Agents are told in files the image owns** (`/etc/claude-code`, `/etc/opencode`, `/etc/codex`), never
    in the user's own instruction files in home. Cursor and Grok Build have no such file, so a missing
    command in bash says how to install it, for every agent.

## Documentation

25. **Docs live in this repository,** in `docs/`, not in a wiki, GitBook or a Pages site. Anyone who clones
    the repository, agents included, has them, and a change updates its docs in the same reviewed pull
    request. Open work lives in GitHub issues.

## Prior art

Community images for T3 Code, none official:

- `dizys/t3code-docker`:
  - a Node base, with T3 and the providers pinned through npm, and PUID/PGID;
  - a setup page, and headless Chromium with Playwright MCP and chrome-devtools-mcp (no desktop you can
    use from a phone);
  - multi-arch CI with a large smoke test.
- `traktuner/docker-t3-code`: read-only root file system, Traefik and Cloudflare Access.
- `idevakk/t3code-docker`: sshd inside, for the desktop app's SSH route.
