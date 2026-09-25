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

export COMPOSE_PROFILES=browser T3CODEBOX_NAME="T3CodeBox test's box"
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
    # Without the startup banner (it prints a short-lived pairing token) and the dashboard password.
    compose logs --no-color --tail 60 t3codebox 2>&1 | grep -vE 'Token:|Pairing URL|[█▀▄]|dashboard password' >&2 || true
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
check "hostname is t3codebox, not the container id" bash -c "[ \"\$($DOCKER exec $c hostname)\" = t3codebox ]"
check "environment label is T3CODEBOX_NAME" bash -c \
  "$DOCKER exec $c curl -fsS http://127.0.0.1:3773/.well-known/t3/environment | jq -e --arg name \"\$T3CODEBOX_NAME\" '.label == \$name'"
check "t3 --version is $version" bash -c "$DOCKER exec $c t3 --version | grep -q 'v$version\$'"

for tool in claude codex cursor-agent grok opencode gh node skills; do
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
check "dashboard answers on 3772 and refuses requests without a session" bash -c \
  "for i in \$(seq 30); do [ \"\$($DOCKER exec $c curl -s -o /dev/null -w %{http_code} http://127.0.0.1:3772/api/status)\" = 401 ] && exit 0; sleep 2; done; exit 1"
check "dashboard signs in with its generated password" in_t3 bash -c \
  'jq -n --arg p "$(cat ~/.t3codebox/dashboard-password)" "{password: \$p}" | curl -fsS -c /tmp/dashboard-cookies -H "Content-Type: application/json" -d @- http://127.0.0.1:3772/api/sign-in'
check "dashboard status: T3 up, both volumes mounted, memory in use" in_t3 bash -c \
  'for i in $(seq 30); do curl -fsS -b /tmp/dashboard-cookies http://127.0.0.1:3772/api/status | jq -e ".t3.up and .mounts.home.kind == \"volume\" and .mounts.workspace.kind == \"volume\" and .memory.used > 0" && exit 0; sleep 2; done; exit 1'
check "dashboard lists every provider with its version, and the pairing link" in_t3 bash -c \
  'for i in $(seq 30); do curl -fsS -b /tmp/dashboard-cookies http://127.0.0.1:3772/api/providers | jq -e "[.providers[] | select(.installed and .version != null)] | length == 6" && break; sleep 2; done \
   && curl -fsS -b /tmp/dashboard-cookies http://127.0.0.1:3772/api/providers | jq -e "[.providers[] | select(.installed and .version != null)] | length == 6" \
   && curl -fsS -b /tmp/dashboard-cookies http://127.0.0.1:3772/api/access | jq -e "any(.pairings[]; .label == \"t3codebox-test\")"'
check "claude auth status names ANTHROPIC_API_KEY (the dashboard's billing warning)" in_t3 bash -c \
  'ANTHROPIC_API_KEY=sk-ant-t3codebox-test claude auth status --json | jq -e ".apiKeySource == \"ANTHROPIC_API_KEY\""'
check "dashboard sets the git author" in_t3 bash -c \
  'curl -fsS -b /tmp/dashboard-cookies -H "Content-Type: application/json" -d "{\"name\":\"T3CodeBox Test\",\"email\":\"test@t3codebox.invalid\"}" http://127.0.0.1:3772/api/git >/dev/null \
   && [ "$(git config --global user.name)" = "T3CodeBox Test" ] && [ "$(git config --global user.email)" = test@t3codebox.invalid ]'
check "dashboard creates a pairing link with its QR code, lists it and revokes it" in_t3 bash -c \
  'listed() { t3 auth pairing list --json | jq -e "any(.[]; .label == \"dashboard-test\")" >/dev/null; }
   id=$(curl -fsS -b /tmp/dashboard-cookies -H "Content-Type: application/json" -d "{\"baseUrl\":\"https://t3codebox.test\",\"ttl\":\"15m\",\"label\":\"dashboard-test\"}" http://127.0.0.1:3772/api/pairing \
     | jq -er "select((.pairing.pairUrl | startswith(\"https://t3codebox.test/pair\")) and (.pairing.qr | length >= 21 and (map(length) | unique == [length]))) | .pairing.id") && listed \
   && curl -fsS -b /tmp/dashboard-cookies -H "Content-Type: application/json" -d "{\"id\":\"$id\"}" http://127.0.0.1:3772/api/pairing/revoke && ! listed'
check "dashboard installs and removes a skill (anthropics/skills internal-comms) with the skills CLI" in_t3 bash -c \
  'job() { for i in $(seq 180); do j=$(curl -fsS -b /tmp/dashboard-cookies "http://127.0.0.1:3772/api/jobs/$1"); [ "$(jq -r .job.state <<< "$j")" != running ] && break; sleep 1; done; jq -r ".job.error // empty" <<< "$j"; [ "$(jq -r .job.state <<< "$j")" = done ]; }
   start() { curl -fsS -b /tmp/dashboard-cookies -H "Content-Type: application/json" -d "$2" "http://127.0.0.1:3772/api/skills/$1" | jq -r .job.id; }
   job "$(start install "{\"source\":\"anthropics/skills\",\"skill\":\"internal-comms\"}")" \
   && test -f ~/.agents/skills/internal-comms/SKILL.md && test -L ~/.claude/skills/internal-comms \
   && curl -fsS -b /tmp/dashboard-cookies http://127.0.0.1:3772/api/skills | jq -e "any(.installed[]; .folder == \"internal-comms\")" >/dev/null \
   && job "$(start remove "{\"folder\":\"internal-comms\"}")" && test ! -e ~/.agents/skills/internal-comms'
check "dashboard signs in to Claude: sign-in link shown, the pasted code reaches claude, Claude's answer comes back" in_t3 bash -c \
  'job() { curl -fsS -b /tmp/dashboard-cookies "http://127.0.0.1:3772/api/jobs/$1"; }
   id=$(curl -fsS -b /tmp/dashboard-cookies -H "Content-Type: application/json" -d "{\"provider\":\"claude\"}" http://127.0.0.1:3772/api/signin | jq -r .job.id)
   for i in $(seq 30); do job "$id" | jq -e ".job.prompt.pasteWanted and (.job.prompt.url | startswith(\"https://claude.com/cai/oauth/authorize\"))" >/dev/null && break; sleep 1; done
   curl -fsS -b /tmp/dashboard-cookies -H "Content-Type: application/json" -d "{\"id\":\"$id\",\"code\":\"t3codebox-test-code#state\"}" http://127.0.0.1:3772/api/signin/code
   for i in $(seq 60); do state=$(job "$id" | jq -r .job.state); [ "$state" != running ] && break; sleep 1; done
   job "$id" | jq -r ".job.error // empty"; [ "$state" = failed ] && ! claude auth status >/dev/null'
check "dashboard stops a sign-in with its process, and does not count it as a running agent" in_t3 bash -c \
  'id=$(curl -fsS -b /tmp/dashboard-cookies -H "Content-Type: application/json" -d "{\"provider\":\"claude\"}" http://127.0.0.1:3772/api/signin | jq -r .job.id)
   for i in $(seq 30); do pgrep -f "claude [a]uth login" >/dev/null && break; sleep 1; done
   curl -fsS -b /tmp/dashboard-cookies http://127.0.0.1:3772/api/status | jq -e ".agents.claude == 0" >/dev/null \
   && curl -fsS -b /tmp/dashboard-cookies -H "Content-Type: application/json" -d "{\"id\":\"$id\"}" http://127.0.0.1:3772/api/jobs/stop \
   && for i in $(seq 20); do [ "$(curl -fsS -b /tmp/dashboard-cookies "http://127.0.0.1:3772/api/jobs/$id" | jq -r .job.state)" = stopped ] && ! pgrep -f "claude [a]uth login" >/dev/null && exit 0; sleep 1; done; exit 1'
check "dashboard refuses a GitHub sign-in while GH_TOKEN is set" in_t3 bash -c \
  'if [ -z "${GH_TOKEN:-}" ]; then echo "GH_TOKEN not set here; nothing to check"; exit 0; fi
   [ "$(curl -s -o /dev/null -w %{http_code} -b /tmp/dashboard-cookies -H "Content-Type: application/json" -d "{\"provider\":\"github\"}" http://127.0.0.1:3772/api/signin)" = 409 ]'
check "no sudo and no Docker socket" in_t3 bash -c '! command -v sudo && [ ! -e /var/run/docker.sock ]'
check "custom uid has a user name, in docker exec too" bash -c \
  "$DOCKER rm -f t3codebox-test-uid >/dev/null 2>&1; $DOCKER run -d --name t3codebox-test-uid --user 4242:4242 $LOCAL_IMAGE sleep infinity >/dev/null && sleep 2 \
   && [ \"\$($DOCKER exec t3codebox-test-uid whoami)\" = t3codebox ] && $DOCKER exec t3codebox-test-uid ssh -G localhost >/dev/null; r=\$?; $DOCKER rm -f t3codebox-test-uid >/dev/null; exit \$r"
check "browser generated and stored a password" bash -c \
  "for i in \$(seq 30); do $DOCKER exec $b test -s /config/.t3codebox-password && exit 0; sleep 2; done; exit 1"
check "browser remote desktop requires the password" bash -c \
  "$DOCKER exec $b sh -c '[ \"\$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:3000/)\" = 401 ] && [ \"\$(curl -s -o /dev/null -w %{http_code} -u abc:\$(cat /config/.t3codebox-password) http://127.0.0.1:3000/)\" = 200 ]'"
check "a password login's cookie opens the desktop stream (Safari sends no basic auth on WebSockets)" bash -c \
  "$DOCKER exec $b sh -c 'c=\$(curl -s -o /dev/null -D - -u abc:\$(cat /config/.t3codebox-password) http://127.0.0.1:3000/ | grep -o \"t3codebox_session=[A-Za-z0-9]*\") && [ \"\$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:3000/websocket)\" = 401 ] && [ \"\$(curl -s -o /dev/null -w %{http_code} -H \"Cookie: \$c\" http://127.0.0.1:3000/websocket)\" != 401 ]'"
check "no zombie processes" bash -c "! $DOCKER exec $c ps -eo stat | grep -q '^Z'"
check "browser MCP server registered for the agents" in_t3 bash -c \
  'for i in $(seq 45); do jq -e .mcpServers.browser ~/.claude.json && jq -e .mcpServers.browser ~/.cursor/mcp.json && jq -e .mcp.browser ~/.config/opencode/opencode.json && grep -q "^\[mcp_servers.browser\]" ~/.codex/config.toml && grep -q "^\[mcp_servers.browser\]" ~/.grok/config.toml && exit 0; sleep 1; done; exit 1'
check "agent-side MCP connection drives the browser, leaving nothing in the project" bash -c \
  "for i in \$(seq 30); do $DOCKER exec $b sh -c 'curl -fsS http://127.0.0.1:9222/json/version' >/dev/null 2>&1 && break; sleep 2; done; $DOCKER exec $c node -e \"\$(cat ci/mcp-probe.js)\" && $DOCKER exec $c test ! -e /workspace/.playwright-mcp"
# Every call has a time limit: `docker exec` into a container that restarts underneath it, or a T3 that is
# still starting, hung an arm64 run for 40 minutes without one. A failure prints the container's state.
check "Restart T3 on the dashboard restarts the container, and T3 comes back" bash -c \
  "before=\$($DOCKER inspect -f '{{.State.StartedAt}}' $c) \
   && timeout 30 $DOCKER exec $c curl -fsS --max-time 10 -b /tmp/dashboard-cookies -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:3772/api/restart >/dev/null \
   && for i in \$(seq 60); do sleep 2; [ \"\$(timeout 10 $DOCKER inspect -f '{{.State.StartedAt}}' $c)\" != \"\$before\" ] \
        && timeout 15 $DOCKER exec $c curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:3773/.well-known/t3/environment 2>/dev/null && exit 0; done; \
   timeout 10 $DOCKER inspect -f 'state {{.State.Status}}, started {{.State.StartedAt}} (was \$before), restarts {{.RestartCount}}' $c; exit 1"

exit "$failed"
