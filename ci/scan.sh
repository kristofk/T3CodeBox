#!/bin/bash
# Scan the published images with Trivy (findings with a fix only).
# In CI (CI=true): CRITICAL starts a rebuild, HIGH opens an issue.
. "$(dirname "$0")/lib.sh"

tag=${SCAN_TAG:-latest}
trivy() {
  if type -P trivy >/dev/null; then
    command trivy "$@"
  else
    # The registry login (for private images) comes along read-only.
    $DOCKER run --rm -v "$ROOT/$OUT:/out" -v "$HOME/.docker:/root/.docker:ro" aquasec/trivy:latest "$@"
  fi
}

report="$OUT/scan-report.md"
: > "$report"
critical=0
high=0
for image in "$IMAGE:$tag" "$BROWSER_IMAGE:$tag"; do
  name=$(basename "${image%:*}")
  out_dir=$OUT
  type -P trivy >/dev/null || out_dir=/out
  trivy image --quiet --ignore-unfixed --severity CRITICAL,HIGH --format json -o "$out_dir/scan-$name.json" "$image"
  c=$(jq '[.Results[]?.Vulnerabilities[]? | select(.Severity == "CRITICAL")] | length' "$OUT/scan-$name.json")
  h=$(jq '[.Results[]?.Vulnerabilities[]? | select(.Severity == "HIGH")] | length' "$OUT/scan-$name.json")
  critical=$((critical + c))
  high=$((high + h))
  {
    echo "### \`$image\`: $c critical, $h high (fix available)"
    echo
    jq -r '.Results[]? | .Target as $t | .Vulnerabilities[]? |
      "- \(.Severity) \(.VulnerabilityID) in \(.PkgName) \(.InstalledVersion) → \(.FixedVersion) (\($t))"' \
      "$OUT/scan-$name.json" | sort -u
    echo
  } >> "$report"
done
cat "$report"
echo "critical=$critical high=$high"

if [ "${CI:-}" = true ]; then
  if [ "$critical" -gt 0 ]; then
    "$ROOT/ci/forge.sh" rebuild "security rebuild: $critical critical findings with a fix"
  elif [ "$high" -gt 0 ]; then
    "$ROOT/ci/forge.sh" issue "High-severity vulnerabilities with a fix in the published images" "$report"
  fi
fi
