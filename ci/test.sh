#!/bin/bash
# Start the locally built images with compose.yaml and check them. One PASS/FAIL line per check;
# the results and the component versions land in $OUT for the release notes.
. "$(dirname "$0")/lib.sh"

version=$(cat "$OUT/t3-version" 2>/dev/null || t3_version)
a=$(arch)
results="$OUT/test-results-$a.txt"
versions="$OUT/versions-$a.txt"
: > "$results"
: > "$versions"

export COMPOSE_PROFILES=browser
export T3CODEBOX_IMAGE=${LOCAL_IMAGE%:*} T3CODEBOX_BROWSER_IMAGE=${LOCAL_BROWSER_IMAGE%:*} T3CODEBOX_TAG=${LOCAL_IMAGE##*:}
compose() { $DOCKER compose --env-file /dev/null -f compose.yaml -f ci/test.compose.yaml "$@"; }
c=t3codebox-test
b=t3codebox-test-browser
in_t3() { $DOCKER exec "$c" "$@"; }

failed=0
check() {
  local name=$1
  shift
  local output
  if output=$("$@" 2>&1); then
    echo "PASS $name" | tee -a "$results"
  else
    echo "FAIL $name: $(echo "$output" | tail -n 3 | tr '\n' ' ')" | tee -a "$results"
    failed=1
  fi
}

cleanup() {
  if [ "$failed" = 1 ]; then
    # Without the startup banner: it prints a short-lived pairing token.
    compose logs --no-color --tail 60 t3codebox 2>&1 | grep -vE 'Token:|Pairing URL|[█▀▄]' >&2 || true
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_healthy() {
  for _ in $(seq 60); do
    in_t3 curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:3773/.well-known/t3/environment 2>/dev/null && return 0
    sleep 2
  done
  return 1
}

compose down -v --remove-orphans >/dev/null 2>&1 || true
compose up -d

check "container runs as non-root (uid 1000)" bash -c "[ \"\$($DOCKER exec $c id -u)\" = 1000 ]"
check "health endpoint answers" wait_healthy
check "t3 --version is $version" bash -c "$DOCKER exec $c t3 --version | grep -q 'v$version\$'"

for tool in claude codex cursor-agent grok opencode gh node; do
  if v=$(in_t3 "$tool" --version 2>&1 | head -n 1); then
    echo "PASS $tool --version: $v" | tee -a "$results"
    echo "$tool $v" >> "$versions"
  else
    echo "FAIL $tool --version: $v" | tee -a "$results"
    failed=1
  fi
done
echo "t3 $version" >> "$versions"
$DOCKER exec "$b" chromium --version >> "$versions" 2>/dev/null || true

check "pairing link minted with --base-url" bash -c \
  "$DOCKER exec $c t3 auth pairing create --base-url https://t3codebox.test --ttl 10m --label t3codebox-test --json | grep -q 'https://t3codebox.test'"
check "state survives a restart" bash -c \
  "$DOCKER restart $c >/dev/null && sleep 2 && for i in \$(seq 60); do $DOCKER exec $c t3 auth pairing list --json 2>/dev/null | grep -q t3codebox-test && exit 0; sleep 2; done; exit 1"
check "no sudo and no Docker socket" in_t3 bash -c '! command -v sudo && [ ! -e /var/run/docker.sock ]'
check "custom uid has a user name, in docker exec too" bash -c \
  "$DOCKER rm -f t3codebox-test-uid >/dev/null 2>&1; $DOCKER run -d --name t3codebox-test-uid --user 4242:4242 $LOCAL_IMAGE sleep infinity >/dev/null && sleep 2 \
   && [ \"\$($DOCKER exec t3codebox-test-uid whoami)\" = t3codebox ] && $DOCKER exec t3codebox-test-uid ssh -G localhost >/dev/null; r=\$?; $DOCKER rm -f t3codebox-test-uid >/dev/null; exit \$r"
check "browser generated and stored a password" bash -c \
  "for i in \$(seq 30); do $DOCKER exec $b test -s /config/.t3codebox-password && exit 0; sleep 2; done; exit 1"
check "browser remote desktop requires the password" bash -c \
  "$DOCKER exec $b sh -c '[ \"\$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:3000/)\" = 401 ] && [ \"\$(curl -s -o /dev/null -w %{http_code} -u abc:\$(cat /config/.t3codebox-password) http://127.0.0.1:3000/)\" = 200 ]'"
check "no zombie processes" bash -c "! $DOCKER exec $c ps -eo stat | grep -q '^Z'"
check "browser MCP server registered for the agents" in_t3 bash -c \
  'for i in $(seq 45); do jq -e .mcpServers.browser ~/.claude.json && jq -e .mcpServers.browser ~/.cursor/mcp.json && jq -e .mcp.browser ~/.config/opencode/opencode.json && grep -q "^\[mcp_servers.browser\]" ~/.codex/config.toml && grep -q "^\[mcp_servers.browser\]" ~/.grok/config.toml && exit 0; sleep 1; done; exit 1'
check "agent-side MCP connection drives the browser" bash -c \
  "for i in \$(seq 30); do $DOCKER exec $b sh -c 'curl -fsS http://127.0.0.1:9222/json/version' >/dev/null 2>&1 && break; sleep 2; done; $DOCKER exec $c node -e \"\$(cat ci/mcp-probe.js)\""

exit "$failed"
