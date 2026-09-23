#!/bin/bash
# Push this architecture's images by digest, without a tag. release.sh combines the architectures
# and moves the tags. Runs after build.sh and test.sh on the same builder, so the layers come from
# its cache and match what was tested.
. "$(dirname "$0")/lib.sh"

version=$(cat "$OUT/t3-version")
image_version=${IMAGE_VERSION:-$version-dev}
a=$(arch)

push() {
  local name=$1 context=$2 key=$3 local_image=$4 digest tested pushed
  shift 4
  $DOCKER buildx build --provenance=false \
    --build-arg IMAGE_VERSION="$image_version" "$@" \
    --output "type=image,name=$name,push-by-digest=true,name-canonical=true,push=true" \
    --metadata-file "$OUT/metadata-$key-$a.json" \
    "$context"
  digest=$(jq -r '."containerimage.digest"' "$OUT/metadata-$key-$a.json")
  # The push is a rebuild from the builder's cache; make sure its layers are the tested ones.
  tested=$($DOCKER image inspect -f '{{json .RootFS.Layers}}' "$local_image" | jq -c .)
  pushed=$($DOCKER buildx imagetools inspect "$name@$digest" --format '{{json .Image.RootFS.DiffIDs}}' | jq -c .)
  if [ "$tested" != "$pushed" ]; then
    echo "pushed $name@$digest differs from the tested $local_image" >&2
    exit 1
  fi
  echo "$digest" > "$OUT/digest-$key-$a"
  echo "pushed $name@$digest (same layers as $local_image)"
}

push "$IMAGE" . t3codebox "$LOCAL_IMAGE" \
  --build-arg T3_VERSION="$version" ${PROVIDERS:+--build-arg PROVIDERS="$PROVIDERS"}
push "$BROWSER_IMAGE" browser browser "$LOCAL_BROWSER_IMAGE"
