/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { Chunk, Module, OptimizationSplitChunksOptions } from '@rspack/core';

type CacheGroups = NonNullable<OptimizationSplitChunksOptions['cacheGroups']>;

/** Prefix applied to shared chunks consumed only by lazy (non-entry) chunks. */
export const LAZY_SHARED_CHUNK_PREFIX = 'lazy-';

/** Eager shared chunk name per cache group key; each also has a `lazy-` tier. */
const SHARED_CHUNK_BASE_NAMES = {
  vendorsHeavy: 'vendors-heavy',
  vendors: 'vendors',
  sharedPlugins: 'shared-plugins',
  corePackages: 'shared-core',
  sharedPackages: 'shared-packages',
  solutionPackages: 'shared-solution-packages',
  rootPackages: 'shared-root-packages',
  default: 'shared-misc',
} as const;

/** Plugin entry chunks are named `plugin-<id>` by the generated unified entry. */
const isPluginEntryChunk = (chunk: Chunk): boolean => chunk.name?.startsWith('plugin-') ?? false;

/**
 * Split a shared chunk into two tiers based on who consumes the module:
 *
 * - Modules used by at least one plugin entry chunk are needed at page load
 *   anyway, so they go into the eager `<name>` chunk (preloaded by bootstrap).
 * - Modules shared only between lazy `import()` chunks go into
 *   `lazy-<name>`, which is fetched on demand the first time any of those
 *   lazy chunks loads, instead of being preloaded on every page.
 *
 * Without this tiering, `minChunks: 3` promotes any module shared by 3 lazy
 * app chunks into the eager shared chunk, inflating every page load.
 */
const tieredName =
  (name: string) =>
  (_module: Module, chunks: Chunk[]): string =>
    chunks.some(isPluginEntryChunk) ? name : `${LAZY_SHARED_CHUNK_PREFIX}${name}`;

/**
 * Return the splitChunks cache groups used by the unified single-compilation
 * build.  Extracted here so that both the build config and the limits
 * validation code can derive the set of named shared chunk names from the
 * same source of truth.
 *
 * CACHE GROUP PRIORITY ORDER (highest wins):
 *   45: vendorsHeavy     - specific heavy node_modules
 *   40: vendors          - /node_modules/ (minChunks: 3)
 *   35: sharedPlugins    - /plugins/  (all cross-plugin shared code)
 *   32: corePackages     - /src/core/packages/
 *   31: sharedPackages   - /packages/(shared|private)/  (platform packages)
 *   30: solutionPackages - /solutions/* /packages/
 *   29: rootPackages     - /packages/kbn-/  (repo root + x-pack/packages)
 *  -20: default          - catch-all (minChunks: 3, name: 'shared-misc')
 *
 * All groups use category-level static names.  No maxSize — benchmarked
 * at 500K/1M/6M/10M/20M (global and per-group); all caused regressions.
 */
export const getSplitChunksCacheGroups = (): CacheGroups => ({
  // Disable rspack's built-in defaultVendors group (test: /node_modules/i,
  // priority: -10). Without this, node_modules shared by fewer than 3
  // chunks bypass our custom `vendors` group (minChunks: 3) and create
  // unnecessary small vendor chunks via the hidden default.
  defaultVendors: false,

  // --- Vendor cache groups (highest priority) ---
  // Vendors are evaluated first so that any module inside node_modules/
  // is always routed to a vendor chunk, even if its path happens to
  // contain segments like /plugins/ or /packages/ that match internal groups.
  vendorsHeavy: {
    test: /[\\/]node_modules[\\/](maplibre-gl|@xyflow|ace-builds|vega|pdf-lib|d3-|dagre|graphlib|ajv|handlebars)/,
    name: tieredName(SHARED_CHUNK_BASE_NAMES.vendorsHeavy),
    chunks: 'async' as const,
    priority: 45,
    minChunks: 3,
    minSize: 0,
    reuseExistingChunk: true,
  },

  // Shared vendors -- all node_modules shared by 3+ chunks,
  // consolidated into a single 'vendors' chunk.
  vendors: {
    test: /[\\/]node_modules[\\/]/,
    name: tieredName(SHARED_CHUNK_BASE_NAMES.vendors),
    priority: 40,
    minChunks: 3,
    reuseExistingChunk: true,
  },

  // --- Plugin cache group ---
  // All cross-plugin shared modules merged into a single 'shared-plugins'
  // chunk.  Covers all plugin directories:
  //   - src/platform/plugins/(shared|private)/<name>/
  //   - x-pack/platform/plugins/(shared|private)/<name>/
  //   - x-pack/solutions/<solution>/plugins/<name>/
  sharedPlugins: {
    test: /[\\/]plugins[\\/]/,
    name: tieredName(SHARED_CHUNK_BASE_NAMES.sharedPlugins),
    chunks: 'async' as const,
    priority: 35,
    minChunks: 3,
    minSize: 0,
    reuseExistingChunk: true,
  },

  // --- Core packages cache group ---
  // src/core/packages/ (~122 browser-relevant packages).
  // All core modules merge into a single 'shared-core' chunk to minimise
  // HTTP requests under HTTP/1.1.  Kibana deploys as a whole, so
  // per-subdomain cache isolation adds no value.
  corePackages: {
    test: /[\\/]src[\\/]core[\\/]packages[\\/]/,
    name: tieredName(SHARED_CHUNK_BASE_NAMES.corePackages),
    chunks: 'async' as const,
    priority: 32,
    minChunks: 3,
    minSize: 0,
    reuseExistingChunk: true,
  },

  // --- Platform packages cache group ---
  // packages/(shared|private)/ — the most impactful shared packages
  // (kbn-palettes, shared-ux, kbn-field-types, etc.).
  // Merged into a single 'shared-packages' chunk.
  sharedPackages: {
    test: /[\\/]packages[\\/](?:shared|private)[\\/]/,
    name: tieredName(SHARED_CHUNK_BASE_NAMES.sharedPackages),
    chunks: 'async' as const,
    priority: 31,
    minChunks: 3,
    minSize: 0,
    reuseExistingChunk: true,
  },

  // --- Solution packages cache group ---
  // x-pack/solutions/<solution>/packages/ (~47 browser-relevant).
  // Merged into a single 'shared-solution-packages' chunk.
  solutionPackages: {
    test: /[\\/]solutions[\\/][^\\/]+[\\/]packages[\\/]/,
    name: tieredName(SHARED_CHUNK_BASE_NAMES.solutionPackages),
    chunks: 'async' as const,
    priority: 30,
    minChunks: 3,
    minSize: 0,
    reuseExistingChunk: true,
  },

  // --- Root packages cache group ---
  // packages/kbn-*/ at repo root + x-pack/packages/kbn-*/.
  // Currently all ~60 are tooling/server-only so this produces no
  // chunks, but kept as a safety net for future browser-side packages.
  rootPackages: {
    test: /[\\/]packages[\\/]kbn-/,
    name: tieredName(SHARED_CHUNK_BASE_NAMES.rootPackages),
    chunks: 'async' as const,
    priority: 29,
    minChunks: 3,
    minSize: 0,
    reuseExistingChunk: true,
  },

  // Catch-all for shared async code not matched by named groups above.
  // Static name merges all remaining modules into a single chunk.
  default: {
    minChunks: 3,
    priority: -20,
    reuseExistingChunk: true,
    name: tieredName(SHARED_CHUNK_BASE_NAMES.default),
  },
});

/**
 * The set of named shared chunk names (eager and lazy tiers) produced by the
 * cache groups. Used by BundleMetricsPlugin (to identify shared chunks vs the
 * `kibana` entry chunk) and by validateLimitsForAllBundles (to tolerate shared
 * chunk entries in limits.yml).
 */
export const getSharedChunkNames = (): Set<string> => {
  const names = new Set<string>();
  for (const name of Object.values(SHARED_CHUNK_BASE_NAMES)) {
    names.add(name);
    names.add(`${LAZY_SHARED_CHUNK_PREFIX}${name}`);
  }
  return names;
};
