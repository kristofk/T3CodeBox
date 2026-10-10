#!/bin/bash
# Unit tests for t3codebox-mcp and t3codebox-shared-skills: each test gets an empty home and stand-ins for the
# agent CLIs, which record their arguments. Needs bash, jq, awk and flock: ci/test.sh runs it in the built image
# against the installed scripts; from a checkout it tests rootfs/.
#   ci/scripts.test.sh            BIN=/usr/local/bin ci/scripts.test.sh
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BIN=${BIN:-$ROOT/rootfs/usr/local/bin}
[ -x "$BIN/t3codebox-mcp" ] || BIN=/usr/local/bin
KEY=k3y-0123456789abcdef-SECRET
HUB='{"url": "https://hub.example.test/mcp", "headers": {"Authorization": "Bearer '"$KEY"'"}}'
BROWSER='{"command": "/usr/local/bin/t3codebox-browser-mcp"}'
declare -A REAL=([jq]=$(command -v jq) [awk]=$(command -v awk) [grep]=$(command -v grep))

failed=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1: $2"; failed=1; }

# A fresh home with stand-ins for the five agents (or the ones named), and every command's arguments logged.
setup() {
  T=$(mktemp -d)
  export HOME=$T/home
  mkdir -p "$HOME" "$T/bin" "$T/real"
  ln -s "$BIN/t3codebox-mcp" "$BIN/t3codebox-shared-skills" "$T/bin/"
  local agents=${*:-claude codex cursor-agent grok opencode}
  for agent in $agents; do
    case $agent in
      claude)
        cat > "$T/bin/claude" <<'EOF'
#!/bin/bash
echo "claude $*" >> "$HOME/../args"
# claude mcp add --scope user <name> -- <command>
[ "$1 $2" = "mcp add" ] || exit 1
f=$HOME/.claude.json; [ -s "$f" ] || echo '{}' > "$f"
jq --arg n "$5" --arg c "$7" '.mcpServers[$n] = {type: "stdio", command: $c, args: [], env: {}}' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
EOF
        ;;
      grok)
        cat > "$T/bin/grok" <<'EOF'
#!/bin/bash
echo "grok $*" >> "$HOME/../args"
# grok mcp add --scope user <name> <command>
[ "$1 $2" = "mcp add" ] || exit 1
mkdir -p "$HOME/.grok"
printf '[mcp_servers.%s]\ncommand = "%s"\nargs = []\nenabled = true\n' "$5" "$6" >> "$HOME/.grok/config.toml"
EOF
        ;;
      *) printf '#!/bin/sh\necho "%s $*" >> "$HOME/../args"\n' "$agent" > "$T/bin/$agent" ;;
    esac
  done
  # jq, awk and grep log their arguments, to show the key never is one.
  for tool in jq awk grep; do
    printf '#!/bin/bash\necho "%s $*" >> "$HOME/../args"\nexec %s "$@"\n' "$tool" "${REAL[$tool]}" > "$T/bin/$tool"
  done
  chmod +x "$T/bin/"*
  export PATH=$T/bin:/usr/bin:/bin
}
teardown() { chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"; }
mcp() { local spec=$1; shift; t3codebox-mcp "$@" <<< "$spec"; }

# ---- t3codebox-mcp ----

setup
out=$(mcp "$BROWSER" add browser | sort | xargs)
if [ "$out" = "claude codex cursor grok opencode" ] \
  && jq -e '.mcpServers.browser.command == "/usr/local/bin/t3codebox-browser-mcp"' "$HOME/.claude.json" >/dev/null \
  && jq -e '.mcpServers.browser == {command: "/usr/local/bin/t3codebox-browser-mcp", args: []}' "$HOME/.cursor/mcp.json" >/dev/null \
  && jq -e '.mcp.browser == {type: "local", command: ["/usr/local/bin/t3codebox-browser-mcp"], enabled: true}' "$HOME/.config/opencode/opencode.json" >/dev/null \
  && grep -qx 'command = "/usr/local/bin/t3codebox-browser-mcp"' "$HOME/.codex/config.toml" \
  && grep -qx '\[mcp_servers.browser\]' "$HOME/.grok/config.toml" \
  && [ -z "$(mcp "$BROWSER" add browser)" ]; then
  pass "a local server is added for all five agents, once, through claude's and grok's own commands"
else
  fail "local server" "$out"
fi
teardown

setup
mkdir -p "$HOME/.cursor"
echo '{"mcpServers": {"hub": {"url": "https://mine.example.test/mcp"}}}' > "$HOME/.cursor/mcp.json"
cp "$HOME/.cursor/mcp.json" "$T/cursor-before"
out=$(mcp "$HUB" add hub | sort | xargs)
cp "$T/args" "$T/args-add"
if [ "$out" = "claude codex grok opencode" ] \
  && jq -e --arg k "Bearer $KEY" '.mcpServers.hub == {type: "http", url: "https://hub.example.test/mcp", headers: {Authorization: $k}}' "$HOME/.claude.json" >/dev/null \
  && jq -e --arg k "Bearer $KEY" '.mcp.hub == {type: "remote", url: "https://hub.example.test/mcp", headers: {Authorization: $k}, enabled: true}' "$HOME/.config/opencode/opencode.json" >/dev/null \
  && grep -qxF "http_headers = { \"Authorization\" = \"Bearer $KEY\" }" "$HOME/.codex/config.toml" \
  && grep -qx '\[mcp_servers.hub.headers\]' "$HOME/.grok/config.toml" && grep -qxF "Authorization = \"Bearer $KEY\"" "$HOME/.grok/config.toml" \
  && cmp -s "$HOME/.cursor/mcp.json" "$T/cursor-before"; then
  pass "a remote server with a key is added where it is missing; a user's entry of that name is left as it is"
else
  fail "remote server" "$out"
fi
modes=$(stat -c %a "$HOME/.claude.json" "$HOME/.codex/config.toml" "$HOME/.grok/config.toml" "$HOME/.config/opencode/opencode.json" | sort -u | xargs)
if [ "$modes" = 600 ]; then pass "files with the key are readable by the user only"; else fail "file modes" "$modes"; fi
if ! grep -q -- "$KEY" "$T/args-add" && ! grep -qE '^(claude|grok) ' "$T/args-add" && grep -q '^jq ' "$T/args-add"; then
  pass "the key is never a command-line argument, and claude and grok are not run for it"
else
  fail "key in arguments" "$(grep -E -- "$KEY|^(claude|grok) " "$T/args-add" | head -n 3)"
fi

# The user changes one of the entries the box added; leaving removes only those still as the box made them.
jq '.mcp.hub.url = "https://mine.example.test/mcp"' "$HOME/.config/opencode/opencode.json" > "$T/oc" && cat "$T/oc" > "$HOME/.config/opencode/opencode.json"
echo '{"url": "https://hub.example.test/mcp"}' > "$T/spec"
out=$(t3codebox-mcp remove hub claude codex grok opencode < "$T/spec" | sort | xargs)
if [ "$out" = "claude codex grok" ] \
  && jq -e '.mcpServers | has("hub") | not' "$HOME/.claude.json" >/dev/null \
  && ! grep -qs 'mcp_servers.hub' "$HOME/.codex/config.toml" "$HOME/.grok/config.toml" \
  && jq -e '.mcp.hub.url == "https://mine.example.test/mcp"' "$HOME/.config/opencode/opencode.json" >/dev/null \
  && cmp -s "$HOME/.cursor/mcp.json" "$T/cursor-before"; then
  pass "remove takes out the box's entries and leaves one the user changed, and agents it did not add to"
else
  fail "remove" "$out"
fi
teardown

setup
mcp "$BROWSER" add browser >/dev/null
mcp "$HUB" add hub >/dev/null
mcp "$BROWSER" add zz >/dev/null
echo '{"url": "https://hub.example.test/mcp"}' | t3codebox-mcp remove hub codex grok >/dev/null
if [ "$(grep -c '^\[' "$HOME/.codex/config.toml")" = 2 ] && grep -qx '\[mcp_servers.zz\]' "$HOME/.codex/config.toml" \
  && grep -qx '\[mcp_servers.browser\]' "$HOME/.grok/config.toml" && grep -qx '\[mcp_servers.zz\]' "$HOME/.grok/config.toml" \
  && ! grep -q 'headers\|hub' "$HOME/.grok/config.toml"; then
  pass "removing a table in the middle of a TOML file keeps the tables around it"
else
  fail "TOML in the middle" "$(cat "$HOME/.grok/config.toml")"
fi
teardown

setup
mkdir -p "$HOME/.config/opencode" "$HOME/.cursor"
echo '{ // mine' > "$HOME/.config/opencode/opencode.jsonc"
echo 'not json' > "$HOME/.cursor/mcp.json"
out=$(mcp "$HUB" add hub 2>"$T/err" | sort | xargs)
if [ "$out" = "claude codex grok" ] && grep -q 'skipped OpenCode' "$T/err" && grep -q 'skipped .*mcp.json: not plain JSON' "$T/err" \
  && [ "$(cat "$HOME/.cursor/mcp.json")" = "not json" ] && [ ! -e "$HOME/.config/opencode/opencode.json" ]; then
  pass "an opencode.jsonc, or a config that is not plain JSON, is skipped and left as it is"
else
  fail "skipped files" "$out $(cat "$T/err")"
fi
teardown

setup claude codex
bad=0
for spec in '{"url": "https://h.test/x", "headers": {"A": "a\"b"}}' '{"url": "https://h.test/x", "headers": {"A": "a\\b"}}' \
  '{"url": "https://h.test/x", "headers": {"A": "a\nb"}}' '{"url": "https://h.test/x", "headers": {"A b": "x"}}' '{"url": "https://h.test/x\"y"}' \
  '{"url": "file:///etc/passwd"}' '{"url": "https://h.test", "command": "/bin/sh"}' '{"command": "/bin/sh -c x"}' 'not json'; do
  mcp "$spec" add evil 2>/dev/null && bad=1
  mcp "$spec" add evil 2>/dev/null; [ $? = 2 ] || bad=1
done
for name in '../x' 'a]b' '-x' ''; do mcp "$HUB" add "$name" 2>/dev/null; [ $? = 2 ] || bad=1; done
if [ "$bad" = 0 ] && [ ! -e "$HOME/.claude.json" ] && [ ! -s "$HOME/.codex/config.toml" ]; then
  pass "specs and names that could break out of a config file are refused, and nothing is written"
else
  fail "hostile specs" "$(ls -A "$HOME")"
fi
teardown

setup
mkdir -p "$HOME/.codex" "$HOME/.grok" "$HOME/.config/opencode" "$HOME/dotfiles" "$T/claude"
printf '[mcp_servers."hub"]\nurl = "https://mine.example.test/mcp"\n' > "$HOME/.codex/config.toml"
printf '[mcp_servers.browser\nbroken = \n' > "$HOME/.grok/config.toml"
echo '{"mcp": "not an object"}' > "$HOME/.config/opencode/opencode.json"
echo '{}' > "$HOME/dotfiles/cursor-mcp.json" && mkdir -p "$HOME/.cursor" && ln -s ../dotfiles/cursor-mcp.json "$HOME/.cursor/mcp.json"
cp "$HOME/.codex/config.toml" "$T/codex.before"; cp "$HOME/.grok/config.toml" "$T/grok.before"; cp "$HOME/.config/opencode/opencode.json" "$T/opencode.before"
SECRET_URL='{"url": "https://hub.example.test/mcp?token=QUERY-SECRET", "headers": {"Authorization": "Bearer '"$KEY"'"}}'
out=$(CLAUDE_CONFIG_DIR=$T/claude t3codebox-mcp add hub <<< "$SECRET_URL" 2>"$T/err" | sort | xargs)
if [ "$out" = "claude cursor" ] && [ -s "$T/claude/.claude.json" ] && [ ! -e "$HOME/.claude.json" ] \
  && cmp -s "$HOME/.codex/config.toml" "$T/codex.before" && cmp -s "$HOME/.grok/config.toml" "$T/grok.before" && grep -q 'grok/config.toml: not valid TOML' "$T/err" \
  && cmp -s "$HOME/.config/opencode/opencode.json" "$T/opencode.before" && grep -q 'not an object' "$T/err" \
  && [ -L "$HOME/.cursor/mcp.json" ] && jq -e '.mcpServers.hub' "$HOME/dotfiles/cursor-mcp.json" >/dev/null; then
  pass "a user's table in another TOML form, invalid TOML, a JSON section of another type are left alone; CLAUDE_CONFIG_DIR and linked files are followed"
else
  fail "other forms" "$out $(cat "$T/err")"
fi
echo '{"url": "https://hub.example.test/mcp?token=QUERY-SECRET"}' > "$T/spec"
out=$(CLAUDE_CONFIG_DIR=$T/claude t3codebox-mcp remove hub claude cursor < "$T/spec" | sort | xargs)
cp "$T/args" "$T/args-both"
if [ "$out" = "claude cursor" ] && ! grep -q 'QUERY-SECRET' "$T/args-both" && [ -L "$HOME/.cursor/mcp.json" ]; then
  pass "a URL is never a command-line argument either, adding or removing"
else
  fail "URL in arguments" "$out $(grep QUERY-SECRET "$T/args-both" | head -n 2)"
fi
teardown

setup codex
mcp "$HUB" add hub >/dev/null
printf '\n# my important note about the next table\n[mcp_servers.mine]\ncommand = "/bin/true"\n' >> "$HOME/.codex/config.toml"
echo '{"url": "https://hub.example.test/mcp"}' | t3codebox-mcp remove hub codex >/dev/null
if grep -qx '# my important note about the next table' "$HOME/.codex/config.toml" && grep -qx '\[mcp_servers.mine\]' "$HOME/.codex/config.toml" \
  && ! grep -q 'hub' "$HOME/.codex/config.toml"; then
  pass "removing a TOML table keeps the user's comments around it"
else
  fail "comments" "$(cat "$HOME/.codex/config.toml")"
fi
teardown

# ---- t3codebox-shared-skills ----

skill() { mkdir -p "$SKILLS/$1" && printf -- '---\nname: %s\n---\n' "$1" > "$SKILLS/$1/SKILL.md"; }
links() { find "$HOME" -type l -printf '%P -> %l\n' | sort; }

setup
export T3CODEBOX_SKILLS_DIR=$T/skills SKILLS=$T/skills
skill review; skill deploy; skill own; mkdir -p "$SKILLS/no-skill-md" "$SKILLS/bad name"; skill "bad name"
mkdir -p "$HOME/.claude/skills/own" "$HOME/.agents/skills"
ln -s /elsewhere "$HOME/.agents/skills/deploy"
chmod -R a-w "$SKILLS"
sum=$(find "$SKILLS" -exec stat -c '%n %a %Y' {} + | sort | md5sum)
t3codebox-shared-skills > "$T/log"
expected="$(printf '%s\n' \
  ".agents/skills/deploy -> /elsewhere" ".agents/skills/own -> $SKILLS/own" ".agents/skills/review -> $SKILLS/review" \
  ".claude/skills/deploy -> $SKILLS/deploy" ".claude/skills/review -> $SKILLS/review" \
  ".grok/skills/deploy -> $SKILLS/deploy" ".grok/skills/own -> $SKILLS/own" ".grok/skills/review -> $SKILLS/review" | sort)"
if [ "$(links)" = "$expected" ] && grep -q "bad name' skipped" "$T/log" && grep -q 'deploy not linked into .*/.agents/skills' "$T/log" \
  && [ "$(find "$SKILLS" -exec stat -c '%n %a %Y' {} + | sort | md5sum)" = "$sum" ]; then
  pass "shared skills are linked in for every agent, around what is there already, without writing to the folder"
else
  fail "shared skills" "$(links; cat "$T/log")"
fi

chmod -R u+w "$SKILLS"; rm -rf "$SKILLS/review"; chmod -R a-w "$SKILLS"
rm "$HOME/.grok/skills/own" && mkdir "$HOME/.grok/skills/own"
t3codebox-shared-skills > "$T/log"
if ! links | grep -q review && grep -q 'links removed: review' "$T/log" && [ -d "$HOME/.grok/skills/own" ] && [ ! -L "$HOME/.grok/skills/own" ] \
  && ! grep -q 'grok/skills/own' "$HOME/.t3codebox/shared-skills"; then
  pass "a skill that is gone loses its links; an entry the user put in place of a link stays theirs"
else
  fail "skill gone" "$(links; cat "$T/log")"
fi

ln -s "$SKILLS/deploy" "$T/handmade" && mv "$T/handmade" "$HOME/.agents/skills/handmade-deploy"
chmod -R u+w "$SKILLS"; rm -rf "$SKILLS"
t3codebox-shared-skills > "$T/log"
if [ "$(links)" = "$(printf '%s\n' ".agents/skills/deploy -> /elsewhere" ".agents/skills/handmade-deploy -> $SKILLS/deploy")" ] \
  && [ ! -e "$HOME/.t3codebox/shared-skills" ] && [ -d "$HOME/.claude/skills/own" ]; then
  pass "without the shared folder every link it made goes, and nothing else"
else
  fail "folder gone" "$(links)"
fi
teardown

setup claude
export T3CODEBOX_SKILLS_DIR=$T/skills SKILLS=$T/skills T3CODEBOX_SKILLS_INTERVAL=1
skill one
t3codebox-shared-skills --watch > "$T/log" &
watcher=$!
sleep 1.5; skill two; sleep 2
ok=0; [ -L "$HOME/.claude/skills/two" ] && ok=1
rm -rf "$SKILLS"; sleep 2.5
if [ "$ok" = 1 ] && ! kill -0 "$watcher" 2>/dev/null && [ -z "$(links)" ] && [ ! -e "$HOME/.agents/skills" ]; then
  pass "--watch links a new skill within its interval, and stops after cleaning up when the folder goes"
else
  kill "$watcher" 2>/dev/null
  fail "--watch" "$(links; cat "$T/log")"
fi
teardown

setup
export T3CODEBOX_SKILLS_DIR=$T/none
t3codebox-shared-skills --watch > "$T/log"
if [ ! -s "$T/log" ] && [ -z "$(ls -A "$HOME")" ]; then
  pass "without a shared folder or earlier links it does nothing and returns"
else
  fail "no folder" "$(ls -A "$HOME"; cat "$T/log")"
fi
teardown

exit "$failed"
