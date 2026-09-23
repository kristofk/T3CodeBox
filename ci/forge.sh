#!/bin/bash
# Everything that talks to the code forge (GitHub, through gh). Swap this file to move forges.
#   forge.sh release <tag> <title> <notes-file>
#   forge.sh issue <title> <body-file>     (skipped when an open issue has the same title)
#   forge.sh rebuild <reason>              (starts the release workflow)
set -euo pipefail

case "${1:-}" in
  release)
    gh release create "$2" --title "$3" --notes-file "$4"
    ;;
  issue)
    if gh issue list --state open --search "in:title \"$2\"" --json title --jq '.[].title' | grep -qxF "$2"; then
      echo "open issue exists: $2"
    else
      gh issue create --title "$2" --body-file "$3"
    fi
    ;;
  rebuild)
    gh workflow run release.yml -f reason="$2"
    ;;
  *)
    echo "usage: forge.sh release|issue|rebuild ..." >&2
    exit 2
    ;;
esac
