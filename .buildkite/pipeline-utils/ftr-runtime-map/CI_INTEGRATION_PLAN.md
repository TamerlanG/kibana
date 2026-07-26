# FTR Runtime Map — CI Integration Plan

> Status: **stage 1 (collection + publish) implemented on this branch** — see the
> "Daily CI collection" section of `README.md` for the file map. Stages 2-3
> (shadow consumption, enforce) are not implemented. Implementation deviations
> from this plan:
> - The merge step runs after a `wait: continue_on_failure: true` instead of
>   `depends_on: ftr-configs` + `allow_dependency_failure` — same semantics,
>   but robust when the dynamically-uploaded FTR group is empty or renamed.
> - Risk 4 below is resolved as **accept + measure**: any "sound" package-level
>   fix collapses to run-all for every boot-loaded plugin (their
>   setup/registration functions execute in ~every config of a stratum), which
>   erases the selection signal. The residual under-selection must be bounded
>   empirically by the stage-2 shadow-mode escape rate before enforcement; the
>   full-suite on-merge pipeline remains the permanent backstop. Rationale in
>   `merge_lib.ts`'s module docblock.
>
> The local tooling this builds on (summarize/record_coverage + the browser CDP
> collector in `kbn-ftr-common-functional-ui-services`) landed in commits
> `17886cb1c87b` (server side) and `7cbc4418cba3` (browser side) on branch
> `selective-ftr-runtime-map` — see `README.md` here.
>
> ⚠️ Touches shared CI infra (`ftr_configs.sh`, a new scheduled pipeline, a bot PR,
> `pull_requests.json`) — get kibana-operations buy-in before landing. Open questions
> for them are at the bottom.

## Goal

A daily CI pipeline runs all enabled FTR configs (currently **721**: 507 stateful +
214 serverless per `.buildkite/ftr-manifests/`) with runtime coverage on, producing a
committed map `config → covered @kbn/ packages`. The PR pipeline's
`pick_test_group_run_order` then selects only FTR configs whose covered packages
intersect the PR's affected packages (same engine Jest/Scout selective testing already
uses: `.buildkite/pipeline-utils/affected-packages/`).

## Decisions (with rationale — all facts verified against the repo 2026-07-25)

### D1. Collection runs in a dedicated daily scheduled pipeline
- New `kibana-ftr-runtime-map`, cron `0 2 * * *` on `main` only. Clone the
  `chrome_forward_testing.yml` skeleton: build dist → `pick_test_group_run_order.sh`
  with `LIMIT_CONFIG_TYPE: 'functional'` → normal FTR fan-out → merge step.
- **Rejected: piggyback on-merge** — on-merge durations are the fallback ci-stats
  duration source for ALL pipelines (`ci_stats_sources.ts:60-64`); coverage-inflated
  durations would pollute PR binning, and it adds risk to the release path.
- **Rejected: piggyback es_snapshots verify** — cadence coupled to ES snapshot health;
  runs against candidate ES builds, not promoted main state.
- Daily freshness is enough: consumers fail open (unmapped config → always run).
- Own pipeline slug ⇒ its inflated durations become its own ci-stats source
  (self-consistent binning from run 2).

### D2. Per-config collection inside `ftr_configs.sh` (env-guarded, non-invasive)
Two guarded blocks in the per-config `while read -r config` loop, gated on
`FTR_RUNTIME_MAP_ENABLED` (precedent: the `USE_CHROME_BETA` block at lines ~84-100):
1. **Arm** (before the run): fresh dump dir `target/ftr-runtime-map/dumps/<slug>`,
   `export NODE_V8_COVERAGE=… FTR_BROWSER_COVERAGE_DIR=…` (absolute paths).
2. **Summarize + delete + upload** (after the run, after `set -e`):
   `unset` both env vars first (else the summarizer's own node process dumps too),
   run the CI collection step (`ci_collect_functions <dir> --out <out>.json.gz
   --config-path <config> --exit-code $lastCode`), `rm -rf` the raw dumps,
   `buildkite-agent artifact upload`. Every command `|| echo …` — collection can
   never change the step outcome.
- **New CI collection step (`ci_collect_functions`)**: a CI-only entry point that
  calls the shared `collectExecutedFunctions()` lib with NO baseline and writes
  gzipped `{meta: {configPath, exitCode, jobId, recordedAt},
  server: {module: functionKeys[]}, browser: {…}}`. Function keys are cross-config
  comparable because every job runs the identical dist at the identical path
  (`KIBANA_BUILD_LOCATION`).
- Disk: FTR agents have 130 GiB; one dump set (0.2–2 GB) live at a time
  (summarize-then-delete per iteration is load-bearing — never accumulate).
- Timeouts: hard 50-min step cap; set `FUNCTIONAL_MAX_MINUTES: '20'` on this pipeline
  so coverage overhead (+10–30%) + summarize (0.5–2 min/config) fits.
- Retries: keep default retry=1 — passed configs skip on retry (`${config}_executed`
  meta-data) and their summaries are already uploaded; merge dedups by slug preferring
  exit-0, then newest.

### D3. Baseline: NO --dry-run. Statistical subtraction at merge time
For each of the 10 manifest strata, a function key executed in **≥90% of that
stratum's successfully-collected configs is boot noise** — subtract it from every
config. A module survives in a config iff ≥1 of its function keys survives.
- Rejected per-config `--dry-run`: +50–85 agent-hours/day (~+60%).
- Rejected per-flavor dry-run: needs representative-config registry + cross-step
  baseline plumbing, AND a dry-run never opens a browser (empty browser baseline) nor
  captures test-time ambient noise.
- Statistical wins: zero extra runs; subtracts browser entry-bundle registration noise
  (present in every UI config — this fixes the 210-module browser noise observed
  locally) and ambient noise (task-manager polling, telemetry).
- Must be **function-level** (module-level would mark ~every plugin universal) and
  **stratified per manifest** (stateful boot functions are only ~70% globally but
  ~100% within their stratum).
- What it removes that dry-run wouldn't: genuinely-common product code (e.g. SO
  internals hit by ≥90% of configs). Acceptable: a package hit by every config carries
  zero selection signal. **Consumer contract makes this safe**: merge emits
  `bootNoisePackages` (modules with zero surviving functions anywhere) and consumers
  must run-ALL when a changed package is in it.
- Threshold 0.90 is a compression knob, not a safety knob (85%-frequent function keeps
  85% of configs ≈ run-all anyway). Tune with data.

### D4. Merge step (final step of the daily pipeline)
`merge_runtime_map.ts` (model: `aggregate_ftr_timing.ts`, the existing
download-all-sibling-artifacts template; `download_artifact --include-retried-jobs`):
1. Download all `<slug>.<jobId>.json.gz`, dedup per config.
2. Cross-check against `getEnabledFtrConfigs()` at the same commit → per-config
   `status: ok | failed | missing`. If ok-fraction < 80% → `status: partial` + Slack.
3. Per-stratum frequency subtraction (hash keys to 64-bit before counting; largest
   stratum 359 configs × ~100–300k keys → hundreds of MB on an n2-standard-8).
4. Emit the map + provenance manifest; hand off to the publisher (D5).
Step config: `depends_on` the FTR group key with `allow_dependency_failure: true`
(map still produced on red days), `timeout_in_minutes: 120`.

### D5. Storage: single committed JSON via daily auto-merge bot PR
`.buildkite/ftr-runtime-map/runtime_map.json` (NOTE: **not** under
`pipeline-utils/ci-stats/...` or `ftr-manifests/` — those are FTR_CRITICAL_PATHS and
would force full runs on every map refresh).
- Publisher: clone `.buildkite/scripts/steps/scout_update_metadata.sh` — kibanamachine
  identity, no-op early exit on empty diff, force-push to an existing open PR, labels
  `release_note:skip backport:skip`, `gh pr merge --auto --squash`, base
  `$BUILDKITE_BRANCH`.
- Add `^\.buildkite/ftr-runtime-map/` to `skip_ci_on_only_changed` in
  `.buildkite/pull_requests.json` so the bot PR is ~free.
- Size: ~0.4 MB with an interned package table (~2 MB plain). Precedent: Scout commits
  ~4 MB daily; `package-map.json` is a 140 KB committed generated file.
- Diff churn from runtime nondeterminism: sorted arrays; optionally union-of-last-N-days
  smoothing later.
- **Rejected as source of truth**: ci-stats service (NO read endpoint exists — client
  has only `_pick_test_group_run_order`; extending it = external ops-owned service);
  ES cluster (puts a live cluster in the scheduling decision path; outage = silent
  full-suite runs); Buildkite artifact fetch at PR time (3 network hops + latest-build
  races + no committed audit trail).
- **ES as optional analytics sidecar (stage 2+)**: fire-and-forget bulk-index of
  per-config summaries for dashboards/history. Precedents for CI→ES writes incl. from
  PR builds: failed-test reporter (`setup_job_env.sh:189-210` provisions creds on every
  build), code-coverage ingest, scout reporter. Never read at PR time.

Map schema (v1):
```jsonc
{
  "mapVersion": 1,          // consumer runs-all on unknown version
  "branch": "main",         // consumer runs-all if !== getTrackedBranch()
  "commit": "…", "generatedAt": "…",
  "collectionBuild": { "pipelineSlug": "kibana-ftr-runtime-map", "buildNumber": 42 },
  "packages": ["@kbn/…", …],          // sorted union = interning table = known universe
  "bootNoisePackages": { "stateful": [idx…], "serverless": [idx…] },
  "configs": {
    "<manifest-relative config path>": {
      "status": "ok" | "carried" | "failed",   // carried = kept from previous map
      "collectedAt": "…",
      "server": [idx…], "browser": [idx…],
      "testFileDirs": ["…"]
    }
  }
}
```

### D6. Consumption (PR pipeline), shadow first
Insertion point: `pick_test_group_run_order.ts` inside the existing
`if (selectiveTestingMergeBase && selectiveChangedFiles)` block, after the
`shouldSkipFtrTests` coarse gate — inherits `useSelectiveTesting` (PR-only) and the
`ci:prevent-selective-testing` label for free.
- Match rule: keep config iff `affected ∩ (server ∪ browser) ≠ ∅` OR changed file
  under its `testFileDirs` OR config unmapped/failed/carried-stale. Affected =
  `getAffectedPackages(mergeBase, {strategy:'git', includeDownstream:true})` —
  downstream expansion is REQUIRED for browser correctness (shared-package browser
  code compiles into consuming plugin bundles).
- Fail-open rules (each → run everything): map missing/unparseable/wrong
  version/wrong branch/older than 7 days; any affected package ∉ `packages` universe;
  changed file with no module and not FTR_IRRELEVANT; FTR_CRITICAL_PATHS touched;
  affected ∩ bootNoisePackages; blast radius `affected.size > 50`.
- New files: `runtime_map.ts` (loader+validation), `selective_ftr_map.ts` (pure rules
  + tests), env `FTR_RUNTIME_MAP_MODE: off|shadow|enforce` in `env_config.ts`.
- Shadow: never touch `ftrConfigsByQueue`; write `ftr_selection_shadow.json` artifact +
  Buildkite annotation "would run N/721"; post-build join against actual FTR failures;
  ship `would-skip-count` / `shadow-miss-count` as ci-stats numeric metrics (works
  today via CiStatsReporter).

## Stages

1. **Collection + publish, consumed by nothing (~1 week)**
   Files: `.buildkite/pipelines/ftr_runtime_map/daily.yml`;
   `.buildkite/pipeline-resource-definitions/kibana-ftr-runtime-map-daily.yml`
   (+ `locations.yml` via `scripts/fix-location-collection.ts`, validate with
   `scripts/validate-pipeline-definition.sh`); `ftr_configs.sh` guarded blocks;
   `ci_collect_functions` collection step; `merge_runtime_map.ts`;
   `commit_map.sh` publisher; `pull_requests.json` skip-CI entry.
   Exit: bot PR merges daily; measure size + day-over-day churn.
2. **Shadow (~4 weeks)** — consumption wiring in shadow mode; measure escape rate
   (config genuinely failed AND would have been skipped, flakes excluded) and skip rate.
   Exit gates: miss-rate ≈ 0; median PR skips > 40% of configs.
3. **Enforce** — flip `FTR_RUNTIME_MAP_MODE=enforce` for kibana-pull-request only.
   Keep shadow artifacts for monitoring. on-merge stays full-suite forever (backstop).

## Cost estimate
~110–170 agent-hours/day (~$10–30/day spot) ≈ one extra on-merge build per day.
Artifacts: ~0.5–2 GB gz function summaries per build + ~5 MB map.

## Top risks
1. **Merge-step scale** — ~10⁸ function-key instances; mitigate with 64-bit hashing,
   per-stratum processing. Largest new engineering piece.
2. **Silent map shrinkage** — timeouts/flakes shrink coverage; unmapped configs just
   "always run" so decay is invisible. Mitigate: ok-fraction floor (<80% → partial +
   Slack), per-config stats trend.
3. **Consumer fail-open contract** — ALL safety lives in the consumer rules
   (`bootNoisePackages` → run-all; unknown → run-all). Treat manifest fields as a
   versioned contract; "not in map" must NEVER mean "skip".
4. **Statistical-subtraction under-selection (D3)** — a package with one ≥90%-frequent
   function (subtracted as noise) AND one rare function (retained) is NOT placed in
   `bootNoisePackages` (it has a surviving function *somewhere*), yet in the configs
   where only its common function executed it has zero survivors and drops out of
   those configs' maps. A change to that package would then wrongly skip those
   configs, and the `bootNoisePackages` fail-open net does not catch it. The
   safety argument in D3 assumes noise is subtracted at package granularity, but
   subtraction is per-function — so "package survives somewhere" ≠ "package attributed
   everywhere it ran". Resolve before implementing D3 (e.g. per-config survivor check,
   or conservatively treat any package with a subtracted function as run-all).

## Open questions for kibana-operations
1. OK to add the guarded blocks to shared `ftr_configs.sh`? (Alternative: fork the
   script for this pipeline — drift risk.)
2. Can a skip-CI'd bot PR auto-merge under branch protection? (Docs-only PRs do today.)
3. Agent budget approval for the daily pipeline (~$10–30/day spot).
4. Who owns the pipeline + Slack alert channel (#kibana-operations-alerts suggested).
5. Long-term: interest in ci-stats growing a map/KV endpoint (would replace the bot PR)?

## Full design records
The two detailed design documents (storage comparison table incl. ES/ci-stats
analysis, and the collection-pipeline design with line-level references) were produced
in the planning session of 2026-07-25; their content is summarized above. Local
validation evidence: `README.md` in this directory (spike results: 611→44 modules
server-side; browser attribution proven on
`src/platform/test/functional/apps/dashboard_elements/image_embeddable/config.ts`).
