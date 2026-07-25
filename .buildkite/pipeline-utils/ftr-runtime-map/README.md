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

## Browser coverage (UI configs)

`NODE_V8_COVERAGE` only sees Node processes; client code executing in Chrome is
invisible to it. When the `FTR_BROWSER_COVERAGE_DIR` env var is set (which
`record_coverage` does automatically), the FTR webdriver layer records the
browser side too, using the same V8 coverage engine via the Chrome DevTools
Protocol (`Profiler.takePreciseCoverage`):

- Coverage is armed when the selenium session starts, flushed + re-armed around
  every navigation (precise coverage is lost on cross-process navigations), and
  flushed a final time before the browser quits.
- Dumps are written as `coverage-browser-<seq>.json` files in the same
  directory and layout as the Node dumps, so the summarizer parses them with
  the same code path.
- Attribution: with the default (webpack) optimizer every plugin is its own
  bundle, so the script URL names the plugin —
  `…/bundles/plugin/<pluginId>/<version>/…` maps to the owning `@kbn/` module
  via each `kibana.jsonc`'s `plugin.id`. `core`/`kbn-ui-shared-deps-*`/
  `kbn-monaco` bundles map statically. Anything else under `bundles/` (e.g. the
  opt-in `KBN_USE_RSPACK` unified build) degrades to `[browser-unattributed]`.
- Results are reported as a separate "browser modules" table and a `browser`
  section in the detail JSON.

Browser-coverage caveats:

- Chrome only; other browsers and remote selenium grids silently skip
  collection (the run itself is unaffected).
- Shared-package browser code compiles into each consuming plugin's bundle, so
  browser rows name the consuming plugin, not the source package. Combined with
  downstream expansion on the changed-files side this is the right granularity
  for test selection.
- Coverage in extra tabs/windows opened by tests is not recorded, and
  process-swap windows between flush and re-arm lose data — both under-collect,
  never mis-attribute.
- Each navigation pays one CDP flush round-trip (payloads can be MBs), only in
  recording runs.

## Scout configs

`record_coverage` auto-detects a Scout config (`.../test/scout*/**/playwright.config.ts`)
and switches runners: the test run is `scout run-tests`, the boot baseline is
`scout start-server --exitAfterReady` (a flag added to kbn-scout that boots the
servers and then gracefully stops them so Kibana flushes its coverage dump —
signalling the CLI does not work because Scout's proc-runner SIGKILLs children on
exit). Server/runner recording uses `NODE_V8_COVERAGE` exactly as FTR does; the
browser side uses a Playwright-native coverage fixture in kbn-scout
(`page.coverage`, gated by `SCOUT_BROWSER_COVERAGE_DIR`) which writes the same
`coverage-browser-*.json` dumps — so `summarize.ts` is unchanged.

```
record_coverage x-pack/platform/plugins/shared/embeddable_alerts_table/test/scout/ui/playwright.config.ts \
  --arch stateful --domain classic
```

`--arch` (default `stateful`) and `--domain` (default `classic`) are Scout-only.

For Scout **UI** configs the baseline is a blank-page run (log in + load a
Kibana page + idle, via `test/scout/ui/baseline.playwright.config.ts`) so it
captures the plugin-registration coverage every page load triggers — otherwise
every UI plugin's `public` bundle looks test-exercised. Scout **API** configs
use a server-only `start-server --exitAfterReady` baseline. The blank-page
baseline uses the `default` server config set, so it is accurate for
default-config-set UI configs (the common case).

### Runtime-vs-static comparison (Scout only, automatic)

For Scout configs, `record_coverage` also prints how the runtime-observed
coverage compares to Scout's existing STATIC selective testing (the upstream
dependency closure of the config's owning module + the implicit-consumer
overlay). It reports, per package: agree / under-selected (runtime ran it,
static would skip — a correctness-risk candidate for a new overlay rule) /
over-selected (static selects it, never ran) / harness, plus recall/precision.

To re-run just the comparison on an already-recorded `packages.json` (no
re-recording), use `compare_scout_selection --config <cfg> --runtime-json <file>`.

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
