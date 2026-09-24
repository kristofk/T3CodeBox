#!/bin/bash
# Is a release build due? Prints GitHub-output style lines:
#   t3_version=<latest stable T3 Code>  tag=<t3_version>-<next build number>  build=true|false
#   edge_version=<t3_version>-edge.<commit>  (the version string of an edge build of this checkout)
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
echo "edge_version=$version-edge.$(git rev-parse --short=7 HEAD 2>/dev/null || echo unknown)"
