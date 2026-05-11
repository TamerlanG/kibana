#!/usr/bin/env bash

set -euo pipefail

source .buildkite/scripts/steps/functional/common.sh

BUILDKITE_PARALLEL_JOB=${BUILDKITE_PARALLEL_JOB:-}
FTR_CONFIG_GROUP_KEY=${FTR_CONFIG_GROUP_KEY:-}
if [ "$FTR_CONFIG_GROUP_KEY" == "" ] && [ "$BUILDKITE_PARALLEL_JOB" == "" ]; then
  echo "Missing FTR_CONFIG_GROUP_KEY env var"
  exit 1
fi

EXTRA_ARGS=${FTR_EXTRA_ARGS:-}
test -z "$EXTRA_ARGS" || buildkite-agent meta-data set "ftr-extra-args" "$EXTRA_ARGS"

export JOB="$FTR_CONFIG_GROUP_KEY"

FAILED_CONFIGS_KEY="${BUILDKITE_STEP_ID}${FTR_CONFIG_GROUP_KEY}"

# a FTR failure will result in the script returning an exit code of 10
exitCode=0

configs="${FTR_CONFIG:-}"

# The first retry should only run the configs that failed in the previous attempt
# Any subsequent retries, which would generally only happen by someone clicking the button in the UI, will run everything
if [[ ! "$configs" && "${BUILDKITE_RETRY_COUNT:-0}" == "1" ]]; then
  configs=$(buildkite-agent meta-data get "$FAILED_CONFIGS_KEY" --default '')
  if [[ "$configs" ]]; then
    echo "--- Retrying only failed configs"
    echo "$configs"
  fi
fi

if [ "$configs" == "" ] && [ "$FTR_CONFIG_GROUP_KEY" != "" ]; then
  echo "--- downloading ftr test run order"
  download_artifact ftr_run_order.json .
  configs=$(jq -r '.[env.FTR_CONFIG_GROUP_KEY].names[]' ftr_run_order.json)
fi

if [ "$configs" == "" ]; then
  echo "unable to determine configs to run"
  exit 1
fi

failedConfigs=""
results=()

while read -r config; do
  if [[ ! "$config" ]]; then
    continue;
  fi

  FULL_COMMAND="node scripts/functional_tests --bail --config $config $EXTRA_ARGS"

  # see if this config has already been executed successfully
  CONFIG_EXECUTION_KEY="${config}_executed"
  IS_CONFIG_EXECUTION=$(buildkite-agent meta-data get "$CONFIG_EXECUTION_KEY" --default "false" --log-level error)
  # we don't want this optimization for flaky test runs
  IS_FLAKY_TEST_RUN=$(test -z "${KIBANA_FLAKY_TEST_RUNNER_CONFIG:-}" && echo "false" || echo "true")

  if [[ "$IS_CONFIG_EXECUTION" == "true" && "$IS_FLAKY_TEST_RUN" == "false" ]]; then
    echo "--- [ already-tested ] $FULL_COMMAND"
    continue
  else
    echo "--- $ $FULL_COMMAND"
  fi

  start=$(date +%s)
  # Epoch-ms snapshot used to identify junit XMLs produced by this config run.
  preStartMs=$(node -e 'process.stdout.write(String(Date.now()))')

  if [[ "${USE_CHROME_BETA:-}" =~ ^(1|true)$ ]]; then
    echo "USE_CHROME_BETA was set - using google-chrome-beta"
    export TEST_BROWSER_BINARY_PATH="$(which google-chrome-beta)"

    # download the beta version of chromedriver
    export CHROMEDRIVER_VERSION=$(curl https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json -s | jq -r '.channels.Beta.version')
    export DETECT_CHROMEDRIVER_VERSION=false
    node node_modules/chromedriver/install.js --chromedriver-force-download

    # set annotation on the build
    buildkite-agent annotate --style info --context chrome-beta """
  ⚠️This build uses Google Chrome Beta
  Path: ${TEST_BROWSER_BINARY_PATH}
  Version: $($TEST_BROWSER_BINARY_PATH --version)
  Chromedriver version: ${CHROMEDRIVER_VERSION} / $(node node_modules/chromedriver/bin/chromedriver --version)
  """
  fi

  # prevent non-zero exit code from breaking the loop
  set +e;
  node ./scripts/functional_tests \
    --bail \
    --kibana-install-dir "$KIBANA_BUILD_LOCATION" \
    --config="$config" \
    "$EXTRA_ARGS"
  lastCode=$?
  set -e;

  # Scout reporter
  if [[ "${SCOUT_REPORTER_ENABLED:-}" =~ ^(1|true)$ ]]; then
    # Upload events after running each config
    echo "Upload Scout reporter events to AppEx QA's team cluster for config $config"
    node scripts/scout upload-events --dontFailOnError
    echo "Upload successful, removing local events at .scout/reports"
    rm -rf .scout/reports
  else
    echo "SCOUT_REPORTER_ENABLED=$SCOUT_REPORTER_ENABLED, skipping event upload."
  fi

  timeSec=$(($(date +%s)-start))
  if [[ $timeSec -gt 60 ]]; then
    min=$((timeSec/60))
    sec=$((timeSec-(min*60)))
    duration="${min}m ${sec}s"
  else
    duration="${timeSec}s"
  fi

  # "Ignore previously-passing flakes on retry" logic.
  #
  # We still run the full config on retry (stateful setup requires it), but we
  # only block on the tests that actually failed in the previous attempt.
  # - First attempt: if any test cases failed, snapshot their IDs in
  #   buildkite-agent meta-data, keyed by config path.
  # - Retry (BUILDKITE_RETRY_COUNT >= 1): if none of the previously-failing
  #   tests are still failing, treat the config as green and surface the
  #   new failures as flake noise. Otherwise, narrow the stored set to the
  #   still-failing tests for any further retries.
  #
  # Opt-out via FTR_IGNORE_FIXED_RETRY=false. Always disabled for flaky
  # test runs (which intentionally surface every failure).
  IGNORE_FIXED_RETRY=${FTR_IGNORE_FIXED_RETRY:-true}
  if [[ "$IS_FLAKY_TEST_RUN" == "true" ]]; then
    IGNORE_FIXED_RETRY="false"
  fi

  if [[ "$IGNORE_FIXED_RETRY" == "true" ]]; then
    configKeySafe=$(printf '%s' "$config" | tr -c 'A-Za-z0-9._-' '_')
    PREV_FAILURES_KEY="ftr_prev_failed_tests::${configKeySafe}"

    currentFailedTests=$(node .buildkite/scripts/steps/test/list_failed_tests.js "$preStartMs" target/junit 2>/dev/null || true)

    if [[ "${BUILDKITE_RETRY_COUNT:-0}" -ge 1 && $lastCode -ne 0 ]]; then
      prevFailedTests=$(buildkite-agent meta-data get "$PREV_FAILURES_KEY" --default "" --log-level error || true)
      if [[ -n "$prevFailedTests" ]]; then
        stillFailing=$(comm -12 \
          <(printf '%s\n' "$prevFailedTests" | sort -u) \
          <(printf '%s\n' "$currentFailedTests" | sort -u))
        if [[ -z "$stillFailing" ]]; then
          echo "--- ✅ Retry: previously-failing tests now pass for $config; ignoring new flaky failures"
          echo "Previously failing tests:"
          printf '%s\n' "$prevFailedTests"
          echo ""
          echo "New failures in this retry (treated as flakes, not blocking):"
          printf '%s\n' "$currentFailedTests"
          lastCode=0
          # Clear stored failures so subsequent retries don't keep applying the override.
          buildkite-agent meta-data set "$PREV_FAILURES_KEY" ""
        else
          echo "--- ❌ Retry: previously-failing tests still failing for $config"
          printf '%s\n' "$stillFailing"
          buildkite-agent meta-data set "$PREV_FAILURES_KEY" "$stillFailing"
        fi
      fi
    elif [[ "${BUILDKITE_RETRY_COUNT:-0}" == "0" && $lastCode -ne 0 && -n "$currentFailedTests" ]]; then
      buildkite-agent meta-data set "$PREV_FAILURES_KEY" "$currentFailedTests"
    fi
  fi

  results+=("- $config
    duration: ${duration}
    result: ${lastCode}")

  if [ $lastCode -eq 0 ]; then
    # Test was successful, so mark it as executed
    buildkite-agent meta-data set "$CONFIG_EXECUTION_KEY" "true"
  else
    exitCode=10
    echo "FTR exited with code $lastCode"
    echo "^^^ +++"

    if [[ "$failedConfigs" ]]; then
      failedConfigs="${failedConfigs}"$'\n'"$config"
    else
      failedConfigs="$config"
    fi
  fi
done <<< "$configs"

if [[ "$failedConfigs" ]]; then
  buildkite-agent meta-data set "$FAILED_CONFIGS_KEY" "$failedConfigs"
fi

echo "--- FTR configs complete"
printf "%s\n" "${results[@]}"
echo ""

exit $exitCode
