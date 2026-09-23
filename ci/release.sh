#!/bin/bash
# Combine the per-architecture digests into multi-arch images, move the tags and publish release notes.
# Tags: <t3>-<n> (immutable; n counts builds for that T3 version), <t3> and latest.
. "$(dirname "$0")/lib.sh"

version=$(cat "$OUT/t3-version")
reason=${REASON:-new T3 Code release}
read -r -a archs <<< "${ARCHS:-amd64 arm64}"
forge=${FORGE:-$ROOT/ci/forge.sh}

for a in "${archs[@]}"; do
  for key in t3codebox browser; do
    [ -s "$OUT/digest-$key-$a" ] || { echo "missing $OUT/digest-$key-$a" >&2; exit 1; }
  done
done

# The tag chosen by upstream.sh (already baked into the image labels), unless another build took it.
tag=${IMAGE_VERSION:-}
if [ -z "$tag" ] || tag_exists "$IMAGE:$tag"; then
  tag="$version-$(next_build_number "$version")"
fi
echo "releasing $tag"

combine() {
  local name=$1 key=$2 sources=()
  for a in "${archs[@]}"; do
    sources+=("$name@$(cat "$OUT/digest-$key-$a")")
  done
  $DOCKER buildx imagetools create -t "$name:$tag" -t "$name:$version" -t "$name:latest" "${sources[@]}"
}
combine "$IMAGE" t3codebox
combine "$BROWSER_IMAGE" browser

notes="$OUT/release-notes.md"
{
  echo "T3 Code $version. Reason for this build: $reason."
  echo
  echo "| Image | Tags |"
  echo "| --- | --- |"
  echo "| \`$IMAGE\` | \`$tag\`, \`$version\`, \`latest\` |"
  echo "| \`$BROWSER_IMAGE\` | \`$tag\`, \`$version\`, \`latest\` |"
  for a in "${archs[@]}"; do
    echo
    echo "### $a"
    echo
    echo "Components:"
    echo
    sed 's/^/- /' "$OUT/versions-$a.txt"
    echo
    echo "Tests:"
    echo
    sed 's/^/- /' "$OUT/test-results-$a.txt"
  done
  echo
  echo "Cursor and Grok publish no checksums for their downloads; every other component is checksum-verified or comes from a signed package repository."
} > "$notes"

$forge release "$tag" "T3CodeBox $tag" "$notes"
