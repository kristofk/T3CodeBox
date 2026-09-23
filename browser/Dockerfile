# syntax=docker/dockerfile:1
# T3CodeBox browser: linuxserver/chromium (remote desktop on port 3000) with the DevTools port
# reachable on the stack's private network, so the agents in the t3codebox container can drive it.
FROM lscr.io/linuxserver/chromium:latest

ARG IMAGE_VERSION=dev

LABEL org.opencontainers.image.title="T3CodeBox browser" \
      org.opencontainers.image.description="Chromium remote desktop that T3CodeBox agents drive through DevTools" \
      org.opencontainers.image.source="https://github.com/kristofk/T3CodeBox" \
      org.opencontainers.image.url="https://github.com/kristofk/T3CodeBox" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${IMAGE_VERSION}"

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

RUN export DEBIAN_FRONTEND=noninteractive \
 && apt-get update \
 && apt-get install -y --no-install-recommends socat \
 && rm -rf /var/lib/apt/lists/*

# DevTools needs a non-default profile directory (Chrome 136+) and listens on loopback only (Chrome 113+).
# The flags go last, after the wrapper's bare --user-data-dir, so they win; CHROME_CLI stays free for the user.
RUN sed -i \
      -e 's|^\( *\)"\$@" > /dev/null 2>&1$|\1"$@" --user-data-dir=/config/profile --remote-debugging-port=9222 > /dev/null 2>\&1|' \
      -e 's|rm -f \$HOME/.config/chromium/Singleton\*|rm -f $HOME/.config/chromium/Singleton* /config/profile/Singleton*|' \
      /usr/bin/wrapped-chromium \
 && grep -q -- '--remote-debugging-port=9222' /usr/bin/wrapped-chromium \
 && grep -q '/config/profile/Singleton' /usr/bin/wrapped-chromium

COPY rootfs/ /

# 3000: remote desktop over HTTP (put TLS in front), 3001: same over self-signed HTTPS,
# 9223: DevTools for the private network only; never publish it.
EXPOSE 3000 3001 9223
