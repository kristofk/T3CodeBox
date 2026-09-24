#!/bin/bash
# Render the PNGs (default colors, transparent) and the social preview from the SVGs with headless Chrome.
# CHROME: path to Chrome or Chromium, default the macOS app.
set -euo pipefail
cd "$(dirname "$0")"
chrome=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

shot() { # size, output, page
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --default-background-color=00000000 --window-size="$1" --screenshot="$2" "file://$3" >/dev/null 2>&1
}

for size in 256 512 1024; do
  printf '<body style="margin:0"><img src="file://%s" style="display:block;width:%spx;height:%spx">' \
    "$PWD/final/default/t3codebox-48.svg" "$size" "$size" > "$tmp/icon.html"
  shot "$size,$size" "$PWD/final/png/t3codebox-$size.png" "$tmp/icon.html"
done
shot 1280,640 "$PWD/social-preview.png" "$PWD/social-preview.html"
