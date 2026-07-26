#!/usr/bin/env bash

set -euo pipefail

# ts-node and the .buildkite dependencies come from the pre-command hook
# (setup_buildkite_deps.sh); nothing here needs the full kbn bootstrap.

# GCS bucket the map lives in (ops-provisioned; same access model as the
# kibana-ci-es-snapshots-* buckets). Layout: <branch>/latest.json is the live
# pointer consumers read, <branch>/history/<stamp>.json are immutable copies.
export FTR_RUNTIME_MAP_GCS_BUCKET="${FTR_RUNTIME_MAP_GCS_BUCKET:-kibana-ci-ftr-runtime-map}"
BRANCH="${BUILDKITE_BRANCH:-main}"
PREVIOUS_MAP='target/ftr-runtime-map/previous_map.json'

echo '--- Download previous FTR runtime map (for carry-forward)'
mkdir -p "$(dirname "$PREVIOUS_MAP")"
# Tolerant: on the first run (or a fresh bucket) there is no previous map and
# the merge simply carries nothing.
if .buildkite/scripts/common/activate_service_account.sh "$FTR_RUNTIME_MAP_GCS_BUCKET"; then
  gsutil cp "gs://$FTR_RUNTIME_MAP_GCS_BUCKET/$BRANCH/latest.json" "$PREVIOUS_MAP" \
    || echo 'runtime-map: no previous map in the bucket — carry-forward disabled'
else
  echo 'runtime-map: could not activate bucket service account — carry-forward disabled'
fi

echo '--- Merge FTR runtime map'
# The largest stratum's function-frequency table can reach a few GiB.
NODE_OPTIONS="--max-old-space-size=8192" \
  ts-node .buildkite/scripts/steps/ftr_runtime_map/merge_runtime_map.ts

echo '--- Publish FTR runtime map'
.buildkite/scripts/steps/ftr_runtime_map/publish_map.sh
