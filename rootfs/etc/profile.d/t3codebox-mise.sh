# shellcheck shell=bash
# A missing command in bash: a tool the directory pins installs through mise and runs; anything else gets a
# hint, since nothing here can apt-get it. Every bash reads this: scripts and `bash -c` through BASH_ENV,
# login shells through /etc/profile, interactive ones through bash.bashrc.
command_not_found_handle() {
  local tool version
  if command -v mise >/dev/null && command -v jq >/dev/null; then
    # The registry tool of that name, else the one that provides the command (cargo: rust).
    tool=$(mise registry --json 2>/dev/null | jq -r --arg c "$1" \
      'first(.[] | select(.short == $c)) // first(.[] | select(.bins // [] | index($c))) | .short // empty' 2>/dev/null)
  fi
  if [ -n "$tool" ] && version=$(mise current "$tool" 2>/dev/null) && [ -n "$version" ]; then
    printf 't3codebox: installing %s %s, which this project pins, with mise\n' "$tool" "$version" >&2
    mise exec -- "$@"
    return
  fi
  printf 'bash: %s: command not found\n' "$1" >&2
  if [ -n "$tool" ]; then
    printf 'No root or apt-get here. Install it with mise: `mise use %s@latest` for this project, `mise use -g %s@latest` for every project.\n' \
      "$tool" "$tool" >&2
  elif command -v mise >/dev/null; then
    printf 'No root or apt-get here. mise installs languages and tools without root: `mise registry` lists them, `mise use github:<owner>/<repo>` takes a tool from its GitHub releases.\n' >&2
  fi
  return 127
}
