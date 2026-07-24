# FTR runtime coverage map

Records which `@kbn/` modules an FTR config actually exercises at runtime, by
running it under Node's built-in V8 coverage (`NODE_V8_COVERAGE`) and
subtracting a boot baseline. This is the "map producer" building block for
per-config FTR selective testing (see `../affected-packages/README.md` for the
selective-testing engine that Jest and Scout already use).

**Status: experimental, local-only. Nothing in CI consumes this yet.**

## Why runtime instead of static analysis

FTR tests drive Kibana over HTTP/browser, so their imports describe test
infrastructure (services, page objects) — not the product code they cover. A
dashboard FTR test never imports the dashboard plugin. Observing a real run is
the only reliable way to map an FTR config to the code it exercises
(the approach described in Stripe's selective-test-execution work).

## How it works

1. `node scripts/functional_tests --config <cfg>` is run with
   `NODE_V8_COVERAGE=<dir>`. Node writes one `coverage-*.json` per process on
   exit; the Kibana server is a child process and inherits the env var, so both
   the FTR runner and Kibana are recorded. No product code changes.
2. The same config is run again with `--dry-run`: identical boot, zero tests.
   This captures what executes on every Kibana boot regardless of the tests.
3. Functions executed in the test run but not in the baseline are attributed to
   the `@kbn/` module owning their file (nearest `kibana.jsonc`, same lookup as
   `affected-packages`; `node_modules/@kbn/<id>` paths from built
   distributions map directly to the package id).

Baseline subtraction is essential: Kibana initializes every plugin at boot, so
without it a run "touches" ~600 modules. With it, a small API-integration
config comes out at ~44 modules, topped by exactly the plugin under test.

## Usage

One-shot (two FTR runs + summary, ~10 min for a small config):

```
.buildkite/pipeline-utils/ftr-runtime-map/record_coverage \
  src/platform/test/api_integration/apis/unused_urls_task/config.ts
```

Manual, if you want to control the runs yourself:

```
NODE_V8_COVERAGE=/tmp/ftr-cov/test-run node scripts/functional_tests --config <cfg>
NODE_V8_COVERAGE=/tmp/ftr-cov/baseline node scripts/functional_tests --dry-run --config <cfg>
.buildkite/pipeline-utils/ftr-runtime-map/summarize_coverage /tmp/ftr-cov/test-run \
  --baseline /tmp/ftr-cov/baseline --json detail.json
```

Example output (unused_urls_task config, which tests the `share` plugin's
unused-URLs cleanup task):

```
=== modules with functions executed only in the test run: 44 ===
functions  files  module
       52     11  @kbn/core-http-server-internal
       51     15  @kbn/core-saved-objects-import-export-server-internal
      ...
        5      3  @kbn/share-plugin
```

To record against a built Kibana distribution instead of from source (what CI
does; also required locally for browser configs that need dist bundles), pass
`--kibana-install-dir <dir>` — it is forwarded to both FTR runs so the test run
and baseline stay comparable. Dist file paths (`node_modules/@kbn/<id>/...`)
are mapped to package ids automatically.

## Caveats

- Raw dumps are large (~200MB per run for a small config); `record_coverage`
  deletes them after summarizing unless `--keep-raw` is passed.
- Background jobs (task manager, telemetry) that happen to fire during the
  longer test run show up as a few stray functions in unrelated modules. For
  test selection this over-includes — the safe direction — and can be reduced
  with a time-matched idle baseline later.
- Function keys are `<file>::<name>::<startOffset>`, so run and baseline must
  come from the same build/source state.
- The repo must be bootstrapped (`yarn kbn bootstrap`) or Kibana won't boot.
