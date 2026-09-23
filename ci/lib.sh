# Shared settings for the ci/*.sh scripts. Every value can be set from the environment.
# shellcheck shell=bash
set -euo pipefail

DOCKER=${DOCKER:-docker}
REGISTRY=${REGISTRY:-ghcr.io/kristofk}
IMAGE=${IMAGE:-$REGISTRY/t3codebox}
BROWSER_IMAGE=${BROWSER_IMAGE:-$REGISTRY/t3codebox-browser}
# Local tags that build.sh produces and test.sh checks.
LOCAL_IMAGE=${LOCAL_IMAGE:-t3codebox:test}
LOCAL_BROWSER_IMAGE=${LOCAL_BROWSER_IMAGE:-t3codebox-browser:test}
OUT=${OUT:-ci-out}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

cd "$ROOT"
mkdir -p "$OUT"

# Latest stable T3 Code version (GitHub's "latest release" skips preview and nightly pre-releases).
# Authenticated when GH_TOKEN is set: anonymous API calls from CI runners get rate-limited.
latest_t3_version() {
  local auth=() version
  [ -n "${GH_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GH_TOKEN")
  version=$(curl -fsSL "${auth[@]}" https://api.github.com/repos/pingdotgg/t3code/releases/latest | jq -r '.tag_name | ltrimstr("v")')
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "could not read the latest T3 Code version (got '$version')" >&2
    return 1
  fi
  echo "$version"
}

t3_version() {
  if [ -z "${T3_VERSION:-}" ]; then
    T3_VERSION=$(latest_t3_version)
  fi
  echo "$T3_VERSION"
}

arch() {
  case "$(uname -m)" in
    x86_64 | amd64) echo amd64 ;;
    aarch64 | arm64) echo arm64 ;;
    *) uname -m ;;
  esac
}

# Does the registry have this tag? Works for private images once logged in.
tag_exists() {
  $DOCKER buildx imagetools inspect "$1" >/dev/null 2>&1
}

# First unused build number for a T3 Code version: 1 for a new version, higher for rebuilds.
next_build_number() {
  local n=1
  while tag_exists "$IMAGE:$1-$n"; do
    n=$((n + 1))
  done
  echo "$n"
}
