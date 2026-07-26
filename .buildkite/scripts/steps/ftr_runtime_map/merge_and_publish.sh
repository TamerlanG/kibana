#!/usr/bin/env bash

set -euo pipefail

# ts-node and the .buildkite dependencies come from the pre-command hook
# (setup_buildkite_deps.sh); nothing here needs the full kbn bootstrap.

echo '--- Merge FTR runtime map'
# The largest stratum's function-frequency table can reach a few GiB.
NODE_OPTIONS="--max-old-space-size=8192" \
  ts-node .buildkite/scripts/steps/ftr_runtime_map/merge_runtime_map.ts

echo '--- Publish FTR runtime map'
.buildkite/scripts/steps/ftr_runtime_map/commit_map.sh
