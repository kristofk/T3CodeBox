# syntax=docker/dockerfile:1
# T3CodeBox browser: linuxserver/chromium (remote desktop on port 3000) with the DevTools port
# reachable on the stack's private network, so the agents in the t3codebox container can drive it.
FROM lscr.io/linuxserver/chromium:latest

ARG IMAGE_VERSION=dev

LABEL org.opencontainers.image.title="T3CodeBox browser" \
      org.opencontainers.image.description="The Chromium that T3CodeBox's agents drive while you watch from the couch. Unofficial, unaffiliated." \
      org.opencontainers.image.source="https://github.com/kristofk/T3CodeBox" \
      org.opencontainers.image.url="https://github.com/kristofk/T3CodeBox" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${IMAGE_VERSION}"

# Browser tab and sidebar titles, through linuxserver's own settings; the browser service can override them.
ENV TITLE="T3CodeBox browser" \
    SELKIES_UI_TITLE="T3CodeBox browser"

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

# Upgrade: Debian's security fixes (Chromium included) reach the image with every build, not only
# when linuxserver rebuilds its base.
RUN export DEBIAN_FRONTEND=noninteractive \
 && echo force-unsafe-io > /etc/dpkg/dpkg.cfg.d/docker-unsafe-io \
 && apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends socat \
 && rm -rf /var/lib/apt/lists/*

# DevTools needs a non-default profile directory (Chrome 136+) and listens on loopback only (Chrome 113+).
# The flags go last, after the wrapper's bare --user-data-dir, so they win; CHROME_CLI stays free for the user.
RUN sed -i \
      -e 's|^\( *\)"\$@" > /dev/null 2>&1$|\1"$@" --user-data-dir=/config/profile --remote-debugging-port=9222 --hide-crash-restore-bubble > /dev/null 2>\&1|' \
      -e 's|rm -f \$HOME/.config/chromium/Singleton\*|rm -f $HOME/.config/chromium/Singleton* /config/profile/Singleton*|' \
      /usr/bin/wrapped-chromium \
 && grep -q -- '--remote-debugging-port=9222' /usr/bin/wrapped-chromium \
 && grep -q '/config/profile/Singleton' /usr/bin/wrapped-chromium

# Session cookie: Safari does not send basic-auth credentials on WebSockets, so the remote desktop's
# stream failed on iPhones. A successful password login now sets a cookie that nginx accepts in place
# of the password; the token behind it is new on every container start (init-t3codebox-password).
# The lines stay commented like linuxserver's own auth lines, which init-nginx enables with PASSWORD.
RUN sed -i \
      -e 's|#auth_basic  *"Login";|#auth_basic $t3codebox_auth;|' \
      -e 's|^\( *\)location SUBFOLDER {$|&\n\1  #add_header Set-Cookie "t3codebox_session=$t3codebox_session; Path=/; Secure; HttpOnly; SameSite=Strict";|' \
      /defaults/default.conf \
 && [ "$(grep -c 'auth_basic $t3codebox_auth' /defaults/default.conf)" = 2 ] \
 && [ "$(grep -c 'Set-Cookie "t3codebox_session' /defaults/default.conf)" = 2 ]

COPY rootfs/ /

# 3000: remote desktop over HTTP (put TLS in front), 3001: same over self-signed HTTPS,
# 9223: DevTools for the private network only; never publish it.
EXPOSE 3000 3001 9223
