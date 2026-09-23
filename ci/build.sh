#!/bin/bash
# Build both images for this machine's architecture and load them as the local test tags.
. "$(dirname "$0")/lib.sh"

version=$(t3_version)
image_version=${IMAGE_VERSION:-$version-dev}
echo "building T3CodeBox for T3 Code $version ($(arch))"

$DOCKER buildx build --pull --load \
  --build-arg T3_VERSION="$version" \
  --build-arg IMAGE_VERSION="$image_version" \
  ${PROVIDERS:+--build-arg PROVIDERS="$PROVIDERS"} \
  -t "$LOCAL_IMAGE" .

$DOCKER buildx build --pull --load \
  --build-arg IMAGE_VERSION="$image_version" \
  -t "$LOCAL_BROWSER_IMAGE" browser

echo "$version" > "$OUT/t3-version"
