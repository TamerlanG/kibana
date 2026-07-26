#!/usr/bin/env bash

set -euo pipefail

# Upload the merged FTR runtime map (written by merge_runtime_map.ts) to GCS,
# mirroring the es-snapshots manifest pattern: an immutable dated history copy
# first, then the no-cache `latest.json` pointer consumers read. Loud on
# failure — a silent publish failure would leave consumers on a stale map with
# no signal (this step failing turns the build red → Slack).

MAP_PATH='target/ftr-runtime-map/runtime_map.json'
BUCKET="${FTR_RUNTIME_MAP_GCS_BUCKET:-kibana-ci-ftr-runtime-map}"
BRANCH="${BUILDKITE_BRANCH:-main}"

if [[ ! -f "$MAP_PATH" ]]; then
  echo "No map at $MAP_PATH — nothing to publish."
  exit 1
fi

.buildkite/scripts/common/activate_service_account.sh "$BUCKET"

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)_build-${BUILDKITE_BUILD_NUMBER:-0}"
gsutil cp "$MAP_PATH" "gs://$BUCKET/$BRANCH/history/$STAMP.json"
gsutil -h 'Cache-Control:no-cache, max-age=0, no-transform' cp \
  "$MAP_PATH" "gs://$BUCKET/$BRANCH/latest.json"

echo "Published gs://$BUCKET/$BRANCH/latest.json (history/$STAMP.json)"
buildkite-agent annotate --style info --context ftr-runtime-map-publish \
  "Published runtime map to gs://$BUCKET/$BRANCH/latest.json" \
  || echo 'runtime-map: annotation failed (non-fatal)'
