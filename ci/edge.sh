#!/bin/bash
# Combine the per-architecture digests into multi-arch images and move the edge tag: the newest main,
# tested on every architecture but not released. Never touches latest or the version tags, and makes no
# release notes; the components and test results are printed here instead.
. "$(dirname "$0")/lib.sh"

read -r -a archs <<< "${ARCHS:-amd64 arm64}"

for a in "${archs[@]}"; do
  for key in t3codebox browser; do
    [ -s "$OUT/digest-$key-$a" ] || { echo "missing $OUT/digest-$key-$a" >&2; exit 1; }
  done
done

combine() {
  local name=$1 key=$2 sources=() flags annotations=()
  for a in "${archs[@]}"; do
    sources+=("$name@$(cat "$OUT/digest-$key-$a")")
  done
  flags=$(index_annotations "${sources[0]}")
  [ -n "$flags" ] && mapfile -t annotations <<< "$flags"
  $DOCKER buildx imagetools create -t "$name:edge" "${annotations[@]}" "${sources[@]}"
}
combine "$IMAGE" t3codebox
combine "$BROWSER_IMAGE" browser

echo "edge is now ${IMAGE_VERSION:-this build}: $IMAGE:edge, $BROWSER_IMAGE:edge"
for a in "${archs[@]}"; do
  echo
  echo "$a components:"
  sed 's/^/  /' "$OUT/versions-$a.txt"
  echo "$a tests:"
  sed 's/^/  /' "$OUT/test-results-$a.txt"
done
