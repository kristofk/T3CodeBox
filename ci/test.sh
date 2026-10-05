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
# Hub mode on, with a fake hub next to the box (ci/test.hub.yaml).
compose_hub() { $DOCKER compose --env-file /dev/null -f compose.yaml -f ci/test.compose.yaml -f ci/test.hub.yaml "$@"; }
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

for tool in claude codex cursor-agent grok opencode gh node skills mise cc; do
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
check "hub mode off: no hub process, no state, the Hub card says not connected, no shared skill links" in_t3 bash -c \
  '! pgrep -f "t3codebox-hub/[h]ub.js" && test ! -e ~/.t3codebox/hub.json && test ! -e ~/.t3codebox/shared-skills \
   && curl -fsS -b /tmp/dashboard-cookies http://127.0.0.1:3772/api/hub | jq -e ". == {configured: false, status: \"off\"}"'
check "scripts: MCP registration and shared skills, with stand-in agents (ci/scripts.test.sh)" bash -c \
  "$DOCKER run --rm --entrypoint bash -v \"\$PWD/ci:/ci:ro\" -e BIN=/usr/local/bin $LOCAL_IMAGE /ci/scripts.test.sh"
check "dashboard status: T3 up, the three volumes mounted, memory in use" in_t3 bash -c \
  'for i in $(seq 30); do curl -fsS -b /tmp/dashboard-cookies http://127.0.0.1:3772/api/status | jq -e ".t3.up and .mounts.home.kind == \"volume\" and .mounts.workspace.kind == \"volume\" and .mounts.toolchains.kind == \"volume\" and .memory.used > 0" && exit 0; sleep 2; done; exit 1'
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
check "dashboard installs two skills at once, updates them and removes them (anthropics/skills) with the skills CLI" in_t3 bash -c \
  'job() { for i in $(seq 180); do j=$(curl -fsS -b /tmp/dashboard-cookies "http://127.0.0.1:3772/api/jobs/$1"); [ "$(jq -r .job.state <<< "$j")" != running ] && break; sleep 1; done; echo "$j" > /tmp/skills-job.json; jq -r ".job.error // empty" <<< "$j"; [ "$(jq -r .job.state <<< "$j")" = done ]; }
   start() { curl -fsS -b /tmp/dashboard-cookies -H "Content-Type: application/json" -d "$2" "http://127.0.0.1:3772/api/skills/$1" | jq -r .job.id; }
   result() { jq -e ".job.result | $1" /tmp/skills-job.json >/dev/null || { jq -c .job.result /tmp/skills-job.json; return 1; }; }
   job "$(start install "{\"source\":\"anthropics/skills\",\"skills\":[\"internal-comms\",\"brand-guidelines\"]}")" && result "[.installed[].name] | sort == [\"brand-guidelines\", \"internal-comms\"]" \
   && test -f ~/.agents/skills/internal-comms/SKILL.md && test -L ~/.claude/skills/internal-comms && test -f ~/.agents/skills/brand-guidelines/SKILL.md \
   && curl -fsS -b /tmp/dashboard-cookies http://127.0.0.1:3772/api/skills | jq -e "[.installed[] | select(.source == \"anthropics/skills\") | .updateName] | sort == [\"brand-guidelines\", \"internal-comms\"]" >/dev/null \
   && job "$(start update "{}")" && result ".failed == []" \
   && jq ".skills[\"internal-comms\"].skillFolderHash = \"0000000000000000000000000000000000000000\"" ~/.agents/.skill-lock.json > /tmp/skill-lock.json && cp /tmp/skill-lock.json ~/.agents/.skill-lock.json \
   && job "$(start update "{\"skills\":[\"internal-comms\"]}")" && result ".updated == [\"internal-comms\"]" \
   && job "$(start remove "{\"folder\":\"internal-comms\"}")" && job "$(start remove "{\"folder\":\"brand-guidelines\"}")" \
   && test ! -e ~/.agents/skills/internal-comms && test ! -e ~/.agents/skills/brand-guidelines'
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
# Made-up logins: Codex stores an API key without checking it, and the others' files are written by hand.
check "dashboard signs out of Codex, Claude Code, OpenCode per provider and GitHub, and refuses what is not stored" in_t3 bash -c \
  'signout() { r=$(curl -sS -w "\n%{http_code}" -b /tmp/dashboard-cookies -H "Content-Type: application/json" -d "$1" http://127.0.0.1:3772/api/signout)
     [ "$(tail -n 1 <<< "$r")" = 202 ] || { head -n 1 <<< "$r"; return 1; }
     id=$(head -n 1 <<< "$r" | jq -r .job.id)
     for i in $(seq 60); do j=$(curl -fsS -b /tmp/dashboard-cookies "http://127.0.0.1:3772/api/jobs/$id"); [ "$(jq -r .job.state <<< "$j")" != running ] && break; sleep 1; done
     jq -r ".job.error // empty" <<< "$j"; [ "$(jq -r .job.state <<< "$j")" = done ]; }
   refused() { [ "$(curl -s -o /dev/null -w %{http_code} -b /tmp/dashboard-cookies -H "Content-Type: application/json" -d "$1" http://127.0.0.1:3772/api/signout)" = 409 ]; }
   echo sk-t3codebox-test | codex login --with-api-key >/dev/null && signout "{\"provider\":\"codex\"}" && ! codex login status >/dev/null && refused "{\"provider\":\"codex\"}" \
   && mkdir -p ~/.claude && echo "{\"claudeAiOauth\":{\"accessToken\":\"t3codebox-test\",\"refreshToken\":\"t3codebox-test\",\"expiresAt\":9999999999999,\"scopes\":[\"user:inference\"]}}" > ~/.claude/.credentials.json \
   && signout "{\"provider\":\"claude\"}" && test ! -e ~/.claude/.credentials.json \
   && mkdir -p ~/.local/share/opencode && echo "{\"anthropic\":{\"type\":\"api\",\"key\":\"t3codebox-test\"},\"openrouter\":{\"type\":\"api\",\"key\":\"t3codebox-test\"}}" > ~/.local/share/opencode/auth.json \
   && signout "{\"provider\":\"opencode\",\"account\":\"Anthropic\"}" && [ "$(jq -c keys ~/.local/share/opencode/auth.json)" = "[\"openrouter\"]" ] \
   && signout "{\"provider\":\"opencode\",\"account\":\"OpenRouter\"}" \
   && mkdir -p ~/.config/gh && printf "github.com:\n    users:\n        t3codebox-test:\n            oauth_token: gho_t3codebox_test\n    git_protocol: https\n    oauth_token: gho_t3codebox_test\n    user: t3codebox-test\n" > ~/.config/gh/hosts.yml \
   && if [ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then signout "{\"provider\":\"github\",\"account\":\"t3codebox-test\",\"host\":\"github.com\"}" && ! grep -q t3codebox-test ~/.config/gh/hosts.yml; \
      else refused "{\"provider\":\"github\",\"account\":\"t3codebox-test\",\"host\":\"github.com\"}" && rm ~/.config/gh/hosts.yml; fi'
check "dashboard refuses a GitHub sign-in while GH_TOKEN is set" in_t3 bash -c \
  'if [ -z "${GH_TOKEN:-}" ]; then echo "GH_TOKEN not set here; nothing to check"; exit 0; fi
   [ "$(curl -s -o /dev/null -w %{http_code} -b /tmp/dashboard-cookies -H "Content-Type: application/json" -d "{\"provider\":\"github\"}" http://127.0.0.1:3772/api/signin)" = 409 ]'
check "toolchains volume mounted at /toolchains, and no warning about it" bash -c \
  "$DOCKER exec $c awk '\$5 == \"/toolchains\" { found = 1 } END { exit !found }' /proc/self/mountinfo && ! $DOCKER logs $c 2>&1 | grep 'toolchains is not a volume'"
check "without the toolchains volume the entrypoint warns" bash -c \
  "$DOCKER run --rm $LOCAL_IMAGE true 2>&1 | grep -q '/toolchains is not a volume'"
check "mise settings: /workspace trusted, GitHub token from gh" in_t3 bash -c \
  '[ "$(mise settings get trusted_config_paths)" = "[\"/workspace\"]" ] && [ "$(mise settings get github.credential_command)" = "gh auth token" ]'
check "C compiler and the OpenSSL, zlib and libffi headers" in_t3 bash -c \
  'pkg-config --exists openssl zlib libffi && printf "#include <openssl/ssl.h>\n#include <zlib.h>\n#include <ffi.h>\nint main(void) { return 0; }\n" | cc -x c - -o /tmp/cc-test && /tmp/cc-test'
check "a project's pinned Node installs on first use into /toolchains, with its env and no mise trust" in_t3 bash -c \
  'mkdir -p /workspace/mise-test && cd /workspace/mise-test && printf "[tools]\nnode = \"22\"\n\n[env]\nT3CODEBOX_TEST = \"trusted\"\n" > mise.toml \
   && [ "$(node -p "process.versions.node.split(\".\")[0] + \" \" + process.env.T3CODEBOX_TEST")" = "22 trusted" ] \
   && [ "$(command -v node)" = /toolchains/shims/node ] && ls /toolchains/installs/node'
check "outside a pinned project, node is the image's Node" in_t3 bash -c \
  'cd /workspace && [ "$(node --version)" = "$(/usr/local/bin/node --version)" ] && [ "$(/usr/local/bin/node --version | cut -d. -f1)" != v22 ]'
check "the image's Node tools and the dashboard run the image's Node, in a project pinned to another" in_t3 bash -c \
  'cd /workspace/mise-test && for tool in codex playwright-mcp skills; do head -n 1 "$(readlink -f "$(command -v "$tool")")" | grep -qx "#!/usr/local/bin/node" && "$tool" --version >/dev/null || { echo "$tool"; exit 1; }; done \
   && [ "$(readlink "/proc/$(pgrep -f "^/usr/local/bin/node /usr/local/lib/t3codebox-dashboard/server.js" | head -n 1)/exe")" = /usr/local/bin/node ]'
check "a pinned tool that isn't installed installs on first use when its command is run" in_t3 bash -c \
  'mkdir -p /workspace/mise-test-shfmt && cd /workspace/mise-test-shfmt && printf "[tools]\nshfmt = \"3.10.0\"\n" > mise.toml \
   && [ "$(bash -c "shfmt --version")" = v3.10.0 ] && [ "$(command -v shfmt)" = /toolchains/shims/shfmt ]'
check "dashboard lists the toolchains with what pins them and their sizes, and removes the unused ones" in_t3 bash -c \
  'tools() { curl -fsS -b /tmp/dashboard-cookies http://127.0.0.1:3772/api/toolchains; }
   mise install shfmt@3.9.0 >/dev/null 2>&1 \
   && tools | jq -e ".total > 0 and any(.tools[]; .tool == \"shfmt\" and .version == \"3.10.0\" and .size > 0 and (.pinnedBy | index(\"/workspace/mise-test-shfmt/mise.toml\")) and (.unused | not))
                   and any(.tools[]; .tool == \"shfmt\" and .version == \"3.9.0\" and .unused and .pinnedBy == [])" >/dev/null \
   && id=$(curl -fsS -b /tmp/dashboard-cookies -H "Content-Type: application/json" -d "{}" http://127.0.0.1:3772/api/toolchains/prune | jq -r .job.id) \
   && for i in $(seq 120); do j=$(curl -fsS -b /tmp/dashboard-cookies "http://127.0.0.1:3772/api/jobs/$id"); [ "$(jq -r .job.state <<< "$j")" != running ] && break; sleep 1; done \
   && jq -r ".job.error // empty" <<< "$j" && [ "$(jq -r .job.state <<< "$j")" = done ] \
   && ! test -e /toolchains/installs/shfmt/3.9.0 && test -e /toolchains/installs/shfmt/3.10.0 && tools | jq -e "all(.tools[]; .unused | not)" >/dev/null'
check "a missing command points to mise, in bash -c and bash -lc" in_t3 bash -c \
  'for flag in -c -lc; do out=$(cd /tmp && bash "$flag" "cargo --version" 2>&1); [ $? = 127 ] && grep -q "mise use rust@latest" <<< "$out" || { echo "bash $flag: $out"; exit 1; }; done'
check "agents are told about mise: Claude Code's file, OpenCode's and Codex's resolved config" in_t3 bash -c \
  'cd /tmp && grep -q "mise use" /etc/claude-code/CLAUDE.md \
   && timeout 60 opencode debug config | grep -q /usr/local/share/t3codebox/agents.md \
   && timeout 60 codex debug prompt-input hello | grep -q "mise use"'
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

# ---- Hub mode (docs/hub.md), against ci/fake-hub.js; the box is recreated with and without it ----

skills_dir="$(cd "$OUT" && pwd)/skills"
mkdir -p "$skills_dir/t3codebox-test-skill"
printf -- '---\nname: t3codebox-test-skill\ndescription: A shared skill for the tests.\n---\n' > "$skills_dir/t3codebox-test-skill/SKILL.md"
chmod -R a+rX "$skills_dir"
export T3CODEBOX_TEST_SKILLS=$skills_dir
# Chosen passwords, as a hub sets them at install: they must work, and never show up in a log.
export TEST_DASHBOARD_PASSWORD=t3codebox-test-dashboard-$RANDOM$RANDOM TEST_BROWSER_PASSWORD=t3codebox-test-browser-$RANDOM$RANDOM
hub_seen() { timeout 15 $DOCKER exec t3codebox-test-hub curl -fsS http://127.0.0.1:8080/state; }
signin_dashboard() {
  for _ in $(seq 30); do
    in_t3 bash -c 'jq -n --arg p "${DASHBOARD_PASSWORD:-$(cat ~/.t3codebox/dashboard-password)}" "{password: \$p}" | curl -fsS -c /tmp/dashboard-cookies -H "Content-Type: application/json" -d @- http://127.0.0.1:3772/api/sign-in' 2>/dev/null && return 0
    sleep 2
  done
  return 1
}
hub_card() { in_t3 curl -fsS -b /tmp/dashboard-cookies http://127.0.0.1:3772/api/hub; }
until_card() { for _ in $(seq 60); do hub_card | jq -e "$1" >/dev/null 2>&1 && return 0; sleep 2; done; hub_card; return 1; }
# Every secret the fake hub has seen, and the code, absent from the box's logs and from every process's arguments.
no_secrets() {
  local secrets
  secrets=$(hub_seen | jq -r '(.codes + .keys + .tokens)[] | select(. != null)') || return 1
  [ -n "$secrets" ] || return 1
  ! $DOCKER logs t3codebox-test 2>&1 | grep -F -f <(echo "$secrets") \
    && ! in_t3 sh -c 'cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\0" "\n"' | grep -F -f <(echo "$secrets")
}

# A Cursor entry of the hub's name that the user made: hub mode must leave it as it is.
in_t3 bash -c 'f=~/.cursor/mcp.json; [ -s "$f" ] || echo "{}" > "$f"; jq ".mcpServers.hub = {url: \"https://mine.example.test/mcp\"}" "$f" > /tmp/c && cat /tmp/c > "$f" && cp "$f" ~/.t3codebox-test-cursor.json'
hub_sessions() { in_t3 t3 auth session list --json | jq '[.[] | select(.client.label // "" | startswith("Hub "))] | length'; }

hub_enrols() {
  until_card '.status == "connected" and .hub == "T3CodeBox test hub"' \
    && hub_seen | jq -e --arg v "$version" '.enrolments[0].box | .t3code == $v and .orchestrationProtocol >= 1 and (.agents | length) == 5 and .name == "T3CodeBox test'\''s box"'
}
hub_token_scoped() {
  hub_seen | jq -e '.checks[0] | .authenticated and (.scopes | sort) == ["orchestration:operate", "orchestration:read"] and .pairingLinks == 403'
}
hub_mcp_registered() {
  in_t3 bash -c 'jq -e ".mcpServers.hub.url == \"http://hub:8080/mcp\" and (.mcpServers.hub.headers.Authorization | startswith(\"Bearer \"))" ~/.claude.json \
    && grep -qx "\[mcp_servers.hub\]" ~/.codex/config.toml && grep -qx "\[mcp_servers.hub.headers\]" ~/.grok/config.toml \
    && jq -e ".mcp.hub.type == \"remote\"" ~/.config/opencode/opencode.json && cmp ~/.cursor/mcp.json ~/.t3codebox-test-cursor.json \
    && [ "$(stat -c %a ~/.t3codebox/hub.json)" = 600 ]'
}
hub_renews() {
  sleep 5
  hub_seen | jq -e '.renewals == 0' >/dev/null || { echo "renewed at once on a renewAfter in the past"; return 1; }
  in_t3 curl -fsS -b /tmp/dashboard-cookies -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:3772/api/hub/retry >/dev/null || return 1
  for _ in $(seq 45); do hub_seen | jq -e '.renewals >= 1' >/dev/null && break; sleep 2; done
  hub_seen | jq -e '.renewals >= 1 and .checks[-1].authenticated' >/dev/null || return 1
  for _ in $(seq 10); do [ "$(hub_sessions)" = 1 ] && return 0; sleep 1; done
  echo "T3 sessions for the hub: $(hub_sessions)"
  return 1
}
shared_skills_linked() {
  in_t3 bash -c 'for i in $(seq 30); do test -L ~/.claude/skills/t3codebox-test-skill && break; sleep 1; done
    test -L ~/.claude/skills/t3codebox-test-skill && test -L ~/.agents/skills/t3codebox-test-skill && test -L ~/.grok/skills/t3codebox-test-skill \
    && curl -fsS -b /tmp/dashboard-cookies http://127.0.0.1:3772/api/skills | jq -e "any(.installed[]; .name == \"t3codebox-test-skill\" and .mounted and .source == \"/skills\")" \
    && [ "$(curl -s -o /dev/null -w %{http_code} -b /tmp/dashboard-cookies -H "Content-Type: application/json" -d "{\"folder\":\"t3codebox-test-skill\"}" http://127.0.0.1:3772/api/skills/remove)" = 409 ]'
}
hub_left() {
  in_t3 bash -c 'for i in $(seq 60); do test ! -e ~/.t3codebox/hub.json && break; sleep 2; done
    test ! -e ~/.t3codebox/hub.json && ! jq -e ".mcpServers.hub" ~/.claude.json >/dev/null && ! grep -q "mcp_servers.hub" ~/.codex/config.toml ~/.grok/config.toml \
    && ! jq -e ".mcp.hub" ~/.config/opencode/opencode.json >/dev/null && cmp ~/.cursor/mcp.json ~/.t3codebox-test-cursor.json \
    && jq -e ".mcpServers.browser" ~/.claude.json >/dev/null \
    && for i in $(seq 30); do test ! -e ~/.claude/skills/t3codebox-test-skill && break; sleep 1; done; test ! -e ~/.claude/skills/t3codebox-test-skill' \
    && [ "$(hub_sessions)" = 0 ] && hub_seen | jq -e '.leaves == 1'
}
hub_leave_and_retry() {
  until_card '.status == "connected"' >/dev/null \
    && in_t3 curl -fsS -b /tmp/dashboard-cookies -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:3772/api/hub/leave >/dev/null \
    && until_card '.status == "left"' >/dev/null && hub_seen | jq -e '.leaves == 2' >/dev/null \
    && in_t3 bash -c '! jq -e .mcpServers.hub ~/.claude.json >/dev/null' && [ "$(hub_sessions)" = 0 ] \
    && in_t3 curl -fsS -b /tmp/dashboard-cookies -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:3772/api/hub/retry >/dev/null \
    && until_card '.status == "rejected" and (.error | test("used already"))' >/dev/null && hub_seen | jq -e '.refused == 1'
}

HUB_CODE=t3codebox-test-code-1 compose_hub up -d
wait_healthy && signin_dashboard
check "hub mode: the box enrols once T3 answers, with its versions and agents" hub_enrols
check "hub mode: the hub's token works on T3, for threads only: no pairing links" hub_token_scoped
check "hub mode: the hub's MCP server for every agent with its key; the user's own Cursor entry unchanged" hub_mcp_registered
check "hub mode: no renewal for a renewAfter in the past; Renew now renews, the old token revoked, the new one works" hub_renews
check "shared skills: /skills linked in for the agents, listed read-only on the dashboard" shared_skills_linked
check "hub mode: no enrolment code, key or token in the box's logs or any process's arguments" no_secrets
chosen_passwords() {
  for _ in $(seq 60); do
    [ "$($DOCKER exec $b curl -s -o /dev/null -w "%{http_code}" -u "abc:$TEST_BROWSER_PASSWORD" http://127.0.0.1:3000/)" = 200 ] && break
    sleep 2
  done
  [ "$($DOCKER exec $b curl -s -o /dev/null -w "%{http_code}" -u "abc:$TEST_BROWSER_PASSWORD" http://127.0.0.1:3000/)" = 200 ] \
    && hub_card >/dev/null \
    && ! $DOCKER logs t3codebox-test 2>&1 | grep -F -e "$TEST_DASHBOARD_PASSWORD" -e "dashboard password" \
    && ! $DOCKER logs t3codebox-test-browser 2>&1 | grep -F -e "$TEST_BROWSER_PASSWORD" -e "sign-in: user"
}
check "DASHBOARD_PASSWORD and BROWSER_PASSWORD work, and neither is printed in the logs" chosen_passwords

compose up -d
wait_healthy && signin_dashboard
check "hub mode switched off: the box leaves, removes only its entries, revokes the token, tells the hub; skill links go" hub_left

HUB_CODE=t3codebox-test-code-2 compose_hub up -d
wait_healthy && signin_dashboard
check "hub mode: a new code enrols again; Leave on the dashboard leaves; Retry with the used code is refused" hub_leave_and_retry

exit "$failed"
