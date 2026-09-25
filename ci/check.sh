#!/bin/bash
# Lint: shellcheck for the scripts, hadolint for the Dockerfiles, compose file validity; then the dashboard's
# unit tests (ci/dashboard.test.js, not shipped in the image).
# Ignored on purpose: versions are resolved at build time (DL3007, DL3008, DL3016), `cd` inside RUN (DL3003),
# the shell-form HEALTHCHECK expands T3CODE_PORT (DL3025), pipefail is set through SHELL (DL4006).
. "$(dirname "$0")/lib.sh"

scripts=(ci/*.sh Icon/render.sh rootfs/usr/local/bin/* rootfs/etc/profile.d/*.sh rootfs/usr/local/lib/t3codebox/runtimes/runtime browser/rootfs/etc/s6-overlay/s6-rc.d/*/run)
$DOCKER run --rm -v "$ROOT:/src:ro" -w /src koalaman/shellcheck:stable -S warning "${scripts[@]}"
for dockerfile in Dockerfile browser/Dockerfile; do
  $DOCKER run --rm -i hadolint/hadolint:latest hadolint --no-color --failure-threshold warning \
    --ignore DL3003 --ignore DL3007 --ignore DL3008 --ignore DL3016 --ignore DL3025 --ignore DL4006 - < "$dockerfile"
done
COMPOSE_PROFILES=browser $DOCKER compose --env-file /dev/null -f compose.yaml config -q
$DOCKER run --rm -v "$ROOT:/src:ro" -w /src node:lts-slim node --test ci/dashboard.test.js
echo "check passed"
