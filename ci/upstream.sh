#!/bin/bash
# Is a release build due? Prints GitHub-output style lines:
#   t3_version=<latest stable T3 Code>  tag=<t3_version>-<next build number>  build=true|false
# A build is due when the registry has no image for that T3 Code version, or when FORCE=1.
. "$(dirname "$0")/lib.sh"

version=$(latest_t3_version)
build=false
if [ "${FORCE:-0}" = 1 ] || ! tag_exists "$IMAGE:$version"; then
  build=true
fi
echo "t3_version=$version"
echo "tag=$version-$(next_build_number "$version")"
echo "build=$build"
