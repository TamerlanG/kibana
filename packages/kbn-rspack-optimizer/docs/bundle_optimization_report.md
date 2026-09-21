# Kibana rspack bundling optimization — research report

Worktree: `bundle-optimization`, baseline commit `f88670da5a94`. rspack 2.1.8, Node 24.21, Apple M4 Pro.
All numbers are from the same machine, same session, production (`--dist`) bundles served by `node scripts/kibana --dev --no-optimizer` (`KBN_USE_RSPACK=true`) against a local ES snapshot; shared-deps DLLs built with `NODE_ENV=production` (deterministic ids; the DLL webpack config never minifies — the distributable minifies it in a separate build task — so ~30 MB of un-minified DLL JS is loaded on every page and is constant across rows).

**Caveats (load-bearing for the ranking).** Page-load runs are loopback with **no network or CPU throttling**: request count is free at 0 ms RTT, so variants that add requests (A2: +295 on home; A3: +134 on the home → Discover navigation) look better here than they would at 40 ms RTT over HTTP/1.1 connection limits. Re-run `node scripts/perf_page_load.js run --dist --throttle devtools` per branch before treating the A2-vs-A3 ordering as final. Decoded-JS-bytes figures from an earlier draft were dropped: they came from `performance.getEntriesByType('resource')`, whose 250-entry buffer truncates at 300+ requests (every row reported identical decoded bytes for two pages with different request counts). Only the CDP-derived gzip transfer, timing, heap and on-disk byte sums are reported.

## Metrics

| Metric | How measured |
|---|---|
| (a) dist bytes | `node scripts/build_rspack_bundles --dist`, sum of `target/public/bundles/**/*.js` (raw + gzip-6). "Preloaded" = `kibana.bundle.js` + every file in `chunk-manifest.json#allChunks` (what bootstrap `load()`s on every page). |
| (b) cold build | `rm -rf node_modules/.cache/.rspack-cache target/public/bundles` then wall-clock of the build command, 2 runs where listed. |
| (c) page load | Playwright + CDP, fresh browser context per run, browser cache disabled, server warm, loopback, no throttling; median of 3 runs. `first_app_nav` = Kibana's own `kbnLoad` mark (app mounted); `js` = gzip bytes transferred for JS (CDP `encodedDataLength`) until network idle; pages: `/app/home`, `/app/discover`. |

## Baseline (what we start from)

- 1641 JS files, **64.25 MB raw / 16.87 MB gz**. Preloaded on every page: **242 files, 25.72 MB raw / 6.81 MB gz** — 93 % of that is 7 shared chunks (`shared-plugins` 12.2 MB, `shared-packages` 4.7 MB, `vendors` 4.3 MB, `vendors-heavy` 1.9 MB). The 234 `plugin-*` entry chunks total only 1.8 MB.
- Cold dist build: 16.6 / 16.9 / 17.0 / 19.1 s (4 runs).
- Home: first_app_nav **1423 ms**, load 1058 ms, **12.65 MB gz JS**, 304 requests, 125 MB JS heap. Discover (direct): 1436 ms, 13.25 MB, 347 requests.
- SPA navigation home → Discover: 347 JS requests, 1.11 MB gz, ~2.0 s.

Root cause found while profiling: `splitChunks` uses `chunks: 'async'` + `minChunks: 3`, so any module shared by 3 *lazy* (`import()`) app chunks is promoted into the statically named shared chunks, which the bootstrap preloads. ~18.7 MB raw of the 25.7 MB preload was code no plugin needs at page load.

## Results

| Row | Branch | Files | Total MB (gz) | Preloaded MB (gz) | Cold build s | Home first_app_nav ms | Home JS gz MB / req | Discover direct ms / gz MB | Home→Discover SPA nav |
|---|---|---|---|---|---|---|---|---|---|
| Baseline | `f88670da` | 1641 | 64.25 (16.87) | 25.72 (6.81) | 16.6–19.1 | 1423 | 12.65 / 304 | 1436 / 13.25 | 347 req, 1.11 MB |
| A1 tiered, single lazy chunk | (commit `3b5793d0`) | 1647 | 64.49 (16.95) | 7.03 (1.96) | 18.9 | 1237 | 12.70 / 310 | 1230 / 13.30 | – |
| A2 tiered, per-consumer-combination lazy chunks | (experiment) | 2831 | 65.68 (17.59) | 7.18 (1.99) | 15.4 | 1270 | 9.45 / 599 | 1312 / 10.38 | – |
| **A3 tiered, lazy tier grouped by source origin** | `bundle-opt/a-tiered-split-chunks` | 1970 | 67.40 (18.10) | 7.09 (1.97) | 17.2 | 1204 | 10.03 / 394 | 1397 / 10.79 | – |
| A4 = A3 + plugin sub-area origins | (experiment, reverted) | 2240 | 67.46 (18.18) | 5.64 (1.61)* | 13.1* | 1188 | 8.41 / 303 | 1119 / 8.41 | 535 req, 3.68 MB |
| B1 minifier: passes 3, module, pure_getters, unsafe_arrows/methods, no comments | (not kept) | 1641 | 64.02 (16.85) | 25.59 (6.80) | 16.1 / 16.3 | – | – | – | – |
| B2 minifier: drop keep_classnames | (not kept) | 1641 | 64.09 (16.85) | 25.62 (6.79) | 16.9 | – | – | – | – |
| E1 `mangleExports: 'size'` + `experiments.pureFunctions` | (not kept) | 1641 | 64.13 (16.75) | 25.65 (6.74) | 16.4 | – | – | – | – |
| **F lazy-load `@kbn/connector-specs` in workflowsManagement** (measured on top of A3) | `bundle-opt/f-lazy-connector-specs` | 1985 | 67.77 (18.22) | 5.59 (1.60) | 16.7 | 1244 | 8.75 / 300 | 1180 / 8.72 | – |
| **C alias `@elastic/eui/{lib,es}` → `optimize/es`** (on top of A3+F) | `bundle-opt/c-eui-lib-alias` | 1984 | 67.36 (18.09) | 5.59 (1.60) | 15.2 | – | – | – | – |
| **D no persistent cache for one-shot `--dist`** | `bundle-opt/d-dist-no-cache` | = baseline | = baseline | = baseline | **11.8 / 12.9** (`--no-cache` on baseline) | – | – | – | – |
| **All (A3 + F + C + D)** | `bundle-opt/all` | 1984 | 67.36 (18.09) | **5.59 (1.60)** | **12.4 / 12.8** | **1126** | **8.73 / 302** | **1111 / 8.68** | 481 req, 3.61 MB |

\* A4 rows measured on top of F+C+D, so preload/build reflect those too.

Warm-cache dist rebuild (cache already populated): 5.1 / 5.4 s — the cache is worth keeping for dev/watch, which D preserves.

### Combined vs baseline

- Preloaded payload: 25.72 → 5.59 MB raw (**−78 %**), 6.81 → 1.60 MB gz.
- Home page: JS transferred 12.65 → 8.73 MB gz (**−31 %**), first_app_nav 1423 → 1126 ms (**−21 %**), `load` 1058 → 891 ms, JS heap 125 → 98 MB. Discover direct: 13.25 → 8.68 MB (−35 %), 1436 → 1111 ms (−23 %).
- Cold dist build: ~17 → ~12.6 s (**−26 %**), and no 1.7 GB cache directory written per one-shot build.
- Cost: total emitted bytes +4.8 % (67.36 vs 64.25 MB; +343 chunk files from per-origin lazy chunks), and the *first* lazy navigation that touches formerly-preloaded code now fetches it: home → Discover goes from 1.11 MB / 347 req to 3.61 MB / 481 req (+~250 ms). Home-then-Discover total is still 12.34 vs 13.76 MB (−10 %); direct Discover load is −35 %.

## What each approach is

**A. Tiered splitChunks (`packages/kbn-rspack-optimizer/src/config/split_chunks.ts`, `chunk_preload_manifest_plugin.ts`).** Every cache group's `name` became a function: if any consuming chunk is a `plugin-*` entry chunk the module goes to the existing eager chunk (`shared-plugins`, `vendors`, …); if only lazy chunks consume it, it goes to `lazy-<group>~<origin>` (origin = plugin / package / npm package). Eager chunks are unchanged in role, so bootstrap still preloads them via `chunk-manifest.json`; the manifest plugin now simply lists everything reachable from the entrypoint's direct children (the previous "static-name cache group" heuristic became meaningless and was removed). `getSharedChunkNames()` returns only eager names (lazy tier is tracked in aggregate by `BundleMetricsPlugin`). Also added `split_chunks.ts` to `CACHE_CONFIG_FILES` — it was missing, so edits to it did not invalidate the persistent cache.
Variants: A1 (single `lazy-*` chunk per group) gives no byte win on home because a start-time `import()` drags the whole 10 MB `lazy-shared-plugins` in anyway; A2 (rspack's per-combination naming) minimises bytes but doubles request count (599 on home); A3 (per source origin) is the balance and is what is kept. A4 (sub-area origins for plugins) did not reduce the Discover-navigation payload and added 250 chunks — reverted.

**B. Minifier.** SWC minifier is saturated: stronger `compress` (incl. `unsafe_*`) −0.4 %, dropping `keep_classnames` −0.25 %. Not worth the risk; not kept.

**E. Tree-shaking flags.** `mangleExports: 'size'` + `experiments.pureFunctions`: −0.2 % raw / −0.7 % gz. Not kept.

**F. Plugin-level lazy loading (`workflows_management/public/plugin.ts`).** Module-graph tracing (throwaway script using `compilation.moduleGraph.getIncomingConnections`) showed `@kbn/connector-specs` (2.1 MB source once scope-hoisted, plus `@modelcontextprotocol/sdk` and `xml2js` in `vendors`) reached the eager tier via `common/triggers/connector_event_triggers.ts`, imported synchronously in `setup()`. Now imported with `import()` and only when `actions.isInboundEventsEnabled`. The registry has no setup lock, mirroring the existing lazy connector-type registration; the plugin test was updated to await the import. `shared-packages` 1.98 → 0.84 MB, `vendors` 0.57 → 0.32 MB.

**C. EUI deep-import alias (`shared_config.ts`).** 147 `@elastic/eui/lib/*` + 30 `/es/*` modules (566 KB) were bundled a second time because the DLL only contains `optimize/es/`. `lib/`, `es/` and `optimize/es/` ship identical 1722-file layouts, so aliasing them to `optimize/es` resolves those imports into the DLL (53 KB of EUI remains — svgs/modules not in the DLL). Also a correctness fix: the two existing per-file aliases existed precisely because duplicated EUI internals break context sharing.

**D. Cache default (`cli.ts`, new `resolve_cache_enabled.ts` + test).** A one-shot `--dist` build spends ~4.5 s (25–30 %) writing a 1.7 GB persistent cache it never reads. The CLI now defaults cache off for one-shot dist builds, on for dev/watch; explicit `--cache`/`--no-cache` always wins (detected from argv — getopts fills absent booleans with `false`, so a flag-value check would have silently disabled the dev cache). The distributable build task already passed `cache: false`; CI's `verify_rspack_build.sh` and FTR's pre-build (`run_tests.ts`) use the CLI and gain the −26 %.

## Recommendation (impact / risk)

1. **D — ship first.** Build −26 % for every CI `--dist` invocation; zero runtime effect; unit-tested. Risk: none beyond someone relying on the dist cache locally (`--cache` restores it).
2. **F — ship.** Two-line plugin change with a clear owner; removes 1.5 MB raw (0.4 MB gz) from every page load. Risk: trigger definitions register a tick later (same pattern as the connector type). Medium-term: there are more of these — see follow-ups.
3. **C — ship.** Small, mechanical, removes duplicate EUI instances. Risk: an EUI module that exists in `lib/` but is *not* in the DLL just gets bundled from `optimize/es` instead (same size), so the failure mode is benign.
4. **A3 — ship, but decide the trade-off explicitly.** Largest win (−31 % page-load bytes, −21 % first_app_nav, −78 % preload) but it moves bytes to first lazy navigation and adds ~340 chunk files (+4.8 % total). Needs: `--update-limits` (shared-chunk limits shrink; lazy tier is aggregate), a Scout run of `discover_cdp_perf.spec.ts` (its SPA-navigation `bundleCount < 70` / `totalSize < 3 MB` assertions were written for the preload-everything model and will need re-baselining), and an FTR/Scout smoke pass. Manual smoke of home, Discover, Dashboard (eCommerce), Lens, Advanced Settings, Console, Maps, Security, Observability, Connectors, Workflows showed no chunk errors.

## Follow-ups surfaced (not done; each is plugin-owned code)

- `entity_store` declares `common` as an extra public dir; `common/domain/definitions/entity_schema.ts` imports the runtime `conditionSchema` from `@kbn/streamlang`, dragging 0.43 MB into the eager `shared-packages` chunk despite the plugin's own `euid_browser` lazy-load effort.
- `index_lifecycle_management/public/plugin.tsx` eagerly imports `extend_index_management` (React modals/summary + `@kbn/data-lifecycle-phases`, 0.2 MB) at setup.
- `logs_shared/public/index.ts` pulls `xstate` (150 KB) into eager `vendors`; `observability/public/components/annotations` pulls `react-hook-form` (88 KB).
- Discover's navigation reaches ~2.5 MB gz of `security_solution` lazy-shared code (management, timelines, flyout, detection_engine areas) — whichever Discover extension imports from `security_solution/public` is the lever; also 347 chunk requests on a plain home → Discover navigation even at baseline.
- A nested `stylis` copy (10 KB) is duplicated into ~22 lazy chunks because it is below the global `minSize` of the `vendors` group.
- `kbn-ui-shared-deps-npm` webpack config has `minimize: false`; the DLL is 19.6 MB un-minified in dev/FTR runs (production build minifies separately in `GeneratePackagesOptimizedAssets`). Out of scope here but it is the largest constant in every page load measured.

## Branches

- `bundle-opt/a-tiered-split-chunks` (A1 + A3 commits), `bundle-opt/f-lazy-connector-specs`, `bundle-opt/c-eui-lib-alias`, `bundle-opt/d-dist-no-cache` — each independently off `f88670da`.
- `bundle-opt/all` — A3 + F + C + D combined (5 commits). `node scripts/jest packages/kbn-rspack-optimizer`: 25 suites / 391 tests pass on `all`; `workflows_management/public/plugin.test.ts` passes on F.

## Reproduce

Throwaway scripts live in `.scout/bundle-opt/` (gitignored): `cold_build.sh <label> <runs>`, `sum_bundles.js <label>`, `measure_page_load.js <label> [runs]` (expects Kibana on :5601, `elastic/changeme`, default space solution set to `classic`), `dump_chunk_modules.js <label>` (chunk → module/origin composition; `TRACE=<regex>` prints importers with their chunk membership). Raw results per row are in `.scout/bundle-opt/results/`.
