# syntax=docker/dockerfile:1
# T3CodeBox: the T3 Code server (`t3 serve`) with the coding-agent CLIs it drives.
FROM debian:trixie-slim

# T3 Code release to install, e.g. 0.0.42. `make build` fills it with the latest stable release.
ARG T3_VERSION
# Providers to install; drop names to slim a self-built image.
ARG PROVIDERS="claude codex cursor grok opencode"
# Version string for the OCI labels, e.g. 0.0.42-1.
ARG IMAGE_VERSION=dev
ARG TARGETARCH

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

LABEL org.opencontainers.image.title="T3CodeBox" \
      org.opencontainers.image.description="Unofficial, unaffiliated, self-proclaimed flagship container for T3 Code that just works." \
      org.opencontainers.image.source="https://github.com/kristofk/T3CodeBox" \
      org.opencontainers.image.url="https://github.com/kristofk/T3CodeBox" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${IMAGE_VERSION}"

# Base tools, and gh from GitHub's apt repository (T3 refuses gh older than 2.81). The C compiler and the most
# common library headers are for what agents build: Rust links with cc, and native npm, pip and gem packages
# compile against OpenSSL, zlib and libffi. Agents can't apt-get the rest.
RUN export DEBIAN_FRONTEND=noninteractive \
 && echo force-unsafe-io > /etc/dpkg/dpkg.cfg.d/docker-unsafe-io \
 && apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client jq ripgrep procps less tzdata \
      python3 make libnss-wrapper tini xz-utils libatomic1 \
      build-essential pkg-config libssl-dev zlib1g-dev libffi-dev \
 && install -d -m 755 /etc/apt/keyrings \
 && curl -fsSL -o /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Node, newest LTS, from nodejs.org with checksum check. Used by Codex, OpenCode and Playwright MCP; T3 embeds its own.
RUN case "$TARGETARCH" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; esac \
 && version=$(curl -fsSL https://nodejs.org/dist/index.json | jq -r '[.[] | select(.lts != false)][0].version') \
 && file="node-${version}-linux-${arch}.tar.xz" \
 && cd /tmp \
 && curl -fsSLO "https://nodejs.org/dist/${version}/${file}" \
 && curl -fsSL "https://nodejs.org/dist/${version}/SHASUMS256.txt" | grep " ${file}\$" | sha256sum -c - \
 && tar -xJf "$file" -C /usr/local --strip-components=1 --no-same-owner \
 && rm -f "$file" /usr/local/CHANGELOG.md /usr/local/README.md /usr/local/LICENSE \
 && node --version

# T3 Code from the official release tarball, checksum checked.
RUN test -n "$T3_VERSION" || { echo "T3_VERSION build argument is required" >&2; exit 1; } \
 && case "$TARGETARCH" in amd64) arch=x64 ;; arm64) arch=arm64 ;; esac \
 && file="t3-${T3_VERSION}-linux-${arch}.tar.gz" \
 && base="https://github.com/pingdotgg/t3code/releases/download/v${T3_VERSION}" \
 && cd /tmp \
 && curl -fsSLO "${base}/${file}" \
 && curl -fsSL "${base}/SHA256SUMS" | grep " \*\?${file}\$" | sha256sum -c - \
 && mkdir -p /opt/t3 \
 && tar -xzf "$file" -C /opt/t3 --strip-components=1 --no-same-owner \
 && rm -f "$file" \
 && ln -s /opt/t3/t3 /usr/local/bin/t3

# Provider CLIs in system locations. Home is not writable for them, so self-updaters cannot replace them;
# the image is the only update path. The same goes for `skills`, which the dashboard installs skills with.
# The npm packages' commands run the image's Node by its path: `env node` would find a project's Node
# through mise's shims, which come first on PATH.
RUN has() { [[ " $PROVIDERS " == *" $1 "* ]]; } \
 && case "$TARGETARCH" in amd64) arch=x64 grok_arch=x86_64 ;; arm64) arch=arm64 grok_arch=aarch64 ;; esac \
 && if has claude; then \
      base=https://downloads.claude.ai/claude-code-releases; \
      version=$(curl -fsSL "$base/latest"); \
      sum=$(curl -fsSL "$base/$version/manifest.json" | jq -r --arg p "linux-$arch" '.platforms[$p].checksum'); \
      curl -fsSL -o /usr/local/bin/claude "$base/$version/linux-$arch/claude"; \
      echo "$sum  /usr/local/bin/claude" | sha256sum -c -; \
      chmod 755 /usr/local/bin/claude; \
    fi \
 && if has cursor; then \
      url=$(curl -fsSL https://cursor.com/install | sed -n 's/^DOWNLOAD_URL="\(.*\)"$/\1/p'); \
      url=${url//'${OS}'/linux}; url=${url//'${ARCH}'/$arch}; \
      mkdir -p /opt/cursor-agent; \
      curl -fsSL "$url" | tar -xzf - -C /opt/cursor-agent --strip-components=1 --no-same-owner; \
      ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent; \
    fi \
 && if has grok; then \
      version=$(curl -fsSL https://x.ai/cli/stable | head -n1 | tr -d '[:space:]'); \
      curl -fsSL -o /usr/local/bin/grok "https://x.ai/cli/grok-${version}-linux-${grok_arch}"; \
      chmod 755 /usr/local/bin/grok; \
    fi \
 && packages="@playwright/mcp skills" \
 && if has codex; then packages="$packages @openai/codex"; fi \
 && if has opencode; then packages="$packages opencode-ai"; fi \
 && npm install -g --no-fund --no-audit --loglevel=error $packages \
 && for package in $packages; do \
      dir=/usr/local/lib/node_modules/$package; \
      for bin in $(jq -r '.bin | if type == "string" then . else .[] end' "$dir/package.json"); do \
        if head -n 1 "$dir/$bin" | grep -q '^#!/usr/bin/env node\b'; then sed -i '1s|^#!/usr/bin/env node|#!/usr/local/bin/node|' "$dir/$bin"; fi; \
        if head -n 1 "$dir/$bin" | grep -q '^#!.*env.*node'; then echo "$dir/$bin still runs the first node on PATH" >&2; exit 1; fi; \
      done; \
    done \
 && npm cache clean --force \
 && rm -rf /root/.npm /root/.cache /tmp/*

# mise, for the toolchains agents install without root. They go in the /toolchains volume; mise itself is
# updated only with the image, like the providers.
RUN case "$TARGETARCH" in amd64) arch=x64 ;; arm64) arch=arm64 ;; esac \
 && sums=$(curl -fsSL https://github.com/jdx/mise/releases/latest/download/SHASUMS256.txt) \
 && file=$(grep -oE "mise-v[0-9.]+-linux-${arch}\$" <<< "$sums") \
 && version=${file#mise-v} && version=${version%-linux-*} \
 && curl -fsSL -o /usr/local/bin/mise "https://github.com/jdx/mise/releases/download/v${version}/${file}" \
 && echo "$(awk -v f="./$file" '$2 == f { print $1 }' <<< "$sums")  /usr/local/bin/mise" | sha256sum -c - \
 && chmod 755 /usr/local/bin/mise \
 && install -d /usr/local/lib/mise \
 && touch /usr/local/lib/mise/.disable-self-update \
 && mise --version \
 && rm -rf /root/.cache /root/.local

# git: gh answers for github.com, so a `gh auth login` covers pushes; any owner may own /workspace repos.
RUN git config --system credential.https://github.com.helper '' \
 && git config --system --add credential.https://github.com.helper '!/usr/bin/gh auth git-credential' \
 && git config --system --add credential.https://gist.github.com.helper '' \
 && git config --system --add credential.https://gist.github.com.helper '!/usr/bin/gh auth git-credential' \
 && git config --system safe.directory '*' \
 && git config --system init.defaultBranch main

# User lookups go through nss_wrapper's copies of passwd and group, which the entrypoint rewrites for
# the uid the container runs as, so `docker exec` under a custom uid has a user name too.
# /etc/machine-info is writable the same way, for the entrypoint to set T3CODEBOX_NAME.
RUN groupadd --gid 1000 t3codebox \
 && useradd --uid 1000 --gid 1000 --create-home --home-dir /home/t3codebox --shell /bin/bash t3codebox \
 && install -d -o 1000 -g 1000 /workspace /toolchains \
 && install -d -m 755 /etc/t3codebox \
 && install -m 666 /etc/passwd /etc/t3codebox/passwd \
 && install -m 666 /etc/group /etc/t3codebox/group \
 && install -m 666 /dev/null /etc/t3codebox/machine-info \
 && ln -s /etc/t3codebox/machine-info /etc/machine-info

COPY rootfs/ /
COPY Icon/final/adaptive/t3codebox-48.svg /usr/local/lib/t3codebox-dashboard/icon.svg

# What every agent is told about the box: Claude Code and OpenCode read the file from /etc (see rootfs/etc),
# Codex gets it as developer instructions. Interactive bash sources the missing-command hint too. Node and
# Python, which the image has, go through rootfs/usr/local/lib/t3codebox/runtimes/runtime until mise has
# shims for them, so a pinned version installs on first use there too.
RUN install -D -m 644 /usr/local/share/t3codebox/agents.md /etc/claude-code/CLAUDE.md \
 && install -d -m 755 /etc/codex \
 && echo "developer_instructions = $(jq -Rs . /usr/local/share/t3codebox/agents.md)" > /etc/codex/config.toml \
 && python3 -c 'import tomllib; tomllib.load(open("/etc/codex/config.toml", "rb"))' \
 && echo '. /etc/profile.d/t3codebox-mise.sh' >> /etc/bash.bashrc \
 && for name in node npm npx python python3 pip pip3; do ln -s runtime "/usr/local/lib/t3codebox/runtimes/$name"; done

ENV T3CODEBOX_VERSION=${IMAGE_VERSION} \
    HOME=/home/t3codebox \
    PATH=/toolchains/shims:/usr/local/lib/t3codebox/runtimes:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/t3codebox/.local/bin \
    MISE_DATA_DIR=/toolchains \
    BASH_ENV=/etc/profile.d/t3codebox-mise.sh \
    LANG=C.UTF-8 \
    T3CODE_HOST=0.0.0.0 \
    T3CODE_PORT=3773 \
    DISABLE_AUTOUPDATER=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    LD_PRELOAD=libnss_wrapper.so \
    NSS_WRAPPER_PASSWD=/etc/t3codebox/passwd \
    NSS_WRAPPER_GROUP=/etc/t3codebox/group

USER 1000:1000
WORKDIR /workspace
# 3773: T3, 3772: the dashboard (rootfs/usr/local/lib/t3codebox-dashboard).
EXPOSE 3772 3773

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS -o /dev/null "http://127.0.0.1:${T3CODE_PORT}/.well-known/t3/environment" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/t3codebox-entrypoint"]
CMD ["t3", "serve"]
