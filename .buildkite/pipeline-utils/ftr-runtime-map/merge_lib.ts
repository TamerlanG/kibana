/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/**
 * Pure logic for the daily runtime-map merge step: dedup per-config summaries,
 * statistical boot-noise subtraction per manifest stratum, and assembly of the
 * published `runtime_map.json`.
 *
 * ## Noise subtraction model
 *
 * CI collection records runs with NO baseline (a per-config `--dry-run` would
 * cost ~+60% agent-hours). Instead, a function key executed in ≥90%
 * (NOISE_FREQUENCY_THRESHOLD) of a stratum's successfully-collected configs is
 * classified as boot/ambient noise — every config in the stratum boots the same
 * plugins, loads the same browser entry bundles, and runs the same background
 * jobs — and is subtracted from every config. A module stays attributed to a
 * config iff at least one of its function keys survives subtraction.
 *
 * ## Accepted residual risk (CI_INTEGRATION_PLAN.md, "Top risks" #4)
 *
 * Subtraction is per-function, but consumers select configs per-package. A
 * package whose common (subtracted) functions were the ONLY thing a config
 * executed drops out of that config's map even though the package has surviving
 * functions in other configs — so it is NOT in `bootNoisePackages` and a change
 * to it would skip that config. Any "sound" fix collapses to run-all for every
 * boot-loaded plugin (their setup/registration functions run everywhere), which
 * would erase the selection signal entirely. This under-selection is accepted
 * for stage 1 and must be measured by the stage-2 shadow-mode escape rate
 * before enforcement; the on-merge pipeline stays full-suite as the backstop.
 */

import type { CiCoverageSummary } from './ci_summary';
import type { FtrConfigStratum, FtrFlavor } from './strata';

/** A function key is boot noise when ≥ this fraction of a stratum executes it. */
export const NOISE_FREQUENCY_THRESHOLD = 0.9;

/**
 * Strata with fewer successfully-collected configs than this skip subtraction:
 * with a handful of configs, every shared test-path function reaches the
 * frequency threshold and the per-config maps collapse to nothing. Skipping
 * over-attributes (configs keep boot noise → they are selected more often),
 * which is the safe direction.
 */
export const MIN_STRATUM_CONFIGS_FOR_SUBTRACTION = 5;

/** Drop `carried` entries older than this — stale attribution causes silent under-selection. */
export const CARRY_MAX_AGE_DAYS = 14;

/** Fraction of enabled configs that must be freshly collected for a `complete` map. */
export const OK_FRACTION_FLOOR = 0.8;

export const RUNTIME_MAP_VERSION = 1;

/** Everything the merge needs from a summary except the function keys. */
export interface SummaryHead {
  file: string;
  meta: CiCoverageSummary['meta'];
  /** Pre-subtraction module presence, per realm. */
  present: { server: string[]; browser: string[] };
}

export function toSummaryHead(file: string, summary: CiCoverageSummary): SummaryHead {
  return {
    file,
    meta: summary.meta,
    present: {
      server: Object.keys(summary.server).sort(),
      browser: Object.keys(summary.browser).sort(),
    },
  };
}

/**
 * One summary per config: prefer exit-0 runs (retries re-run failed configs, so
 * a later green attempt supersedes a red one), then the newest recording.
 */
export function pickWinners(heads: SummaryHead[]): Map<string, SummaryHead> {
  const winners = new Map<string, SummaryHead>();
  for (const head of heads) {
    const current = winners.get(head.meta.configPath);
    if (!current || isBetterSummary(head, current)) {
      winners.set(head.meta.configPath, head);
    }
  }
  return winners;
}

function isBetterSummary(a: SummaryHead, b: SummaryHead): boolean {
  const aOk = a.meta.exitCode === 0;
  const bOk = b.meta.exitCode === 0;
  if (aOk !== bOk) return aOk;
  if (a.meta.recordedAt !== b.meta.recordedAt) return a.meta.recordedAt > b.meta.recordedAt;
  return a.file > b.file;
}

/**
 * cyrb53 — fast 53-bit string hash (public domain, bryc). Distinct function
 * keys per stratum number in the low millions against a 2^53 space, so the
 * expected collision count per run is ~1e-3; a collision at worst flips one
 * function's noise classification, which the consumer's fail-open rules absorb.
 * Hashing keeps the per-stratum frequency tables at numbers instead of ~100-char
 * strings (~10^8 key instances across the build).
 */
export function hashFunctionKey(key: string, seed = 0): number {
  /* eslint-disable no-bitwise */
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  /* eslint-enable no-bitwise */
}

function* allFunctionKeys(summary: CiCoverageSummary): Generator<string> {
  for (const realm of [summary.server, summary.browser]) {
    for (const keys of Object.values(realm)) {
      yield* keys;
    }
  }
}

/**
 * Per-stratum function-key frequency counter (pass 1 of the merge). Feed it
 * every successfully-collected config once, then ask which hashed keys cross
 * the noise threshold. Server and browser keys share one table — their key
 * spaces are disjoint by construction (bundle paths vs file paths).
 */
export class StratumNoiseCounter {
  private readonly countsByStratum = new Map<string, Map<number, number>>();
  private readonly configsByStratum = new Map<string, number>();

  addConfig(stratum: string, summary: CiCoverageSummary): void {
    let counts = this.countsByStratum.get(stratum);
    if (!counts) {
      counts = new Map();
      this.countsByStratum.set(stratum, counts);
    }
    this.configsByStratum.set(stratum, (this.configsByStratum.get(stratum) ?? 0) + 1);
    for (const key of allFunctionKeys(summary)) {
      const hash = hashFunctionKey(key);
      counts.set(hash, (counts.get(hash) ?? 0) + 1);
    }
  }

  /** Hashed keys per stratum whose frequency crosses the noise threshold. */
  computeNoiseKeys({
    threshold = NOISE_FREQUENCY_THRESHOLD,
    minConfigs = MIN_STRATUM_CONFIGS_FOR_SUBTRACTION,
  } = {}): Map<string, Set<number>> {
    const noiseByStratum = new Map<string, Set<number>>();
    for (const [stratum, counts] of this.countsByStratum) {
      const configCount = this.configsByStratum.get(stratum) ?? 0;
      const noise = new Set<number>();
      if (configCount >= minConfigs) {
        const minCount = threshold * configCount;
        for (const [hash, count] of counts) {
          if (count >= minCount) {
            noise.add(hash);
          }
        }
      }
      noiseByStratum.set(stratum, noise);
    }
    return noiseByStratum;
  }
}

/** Modules with ≥1 function key surviving noise subtraction (pass 2). */
export function survivingModules(
  summary: CiCoverageSummary,
  noiseKeys: Set<number>
): { server: string[]; browser: string[] } {
  const survivors = (realm: Record<string, string[]>) =>
    Object.entries(realm)
      .filter(([, keys]) => keys.some((key) => !noiseKeys.has(hashFunctionKey(key))))
      .map(([moduleId]) => moduleId)
      .sort();
  return { server: survivors(summary.server), browser: survivors(summary.browser) };
}

export interface RuntimeMapConfigEntry {
  /** `carried` = kept from the previous map because this run produced no green summary. */
  status: 'ok' | 'carried' | 'failed';
  collectedAt: string;
  /** Indices into the top-level `packages` interning table. */
  server: number[];
  browser: number[];
  /** Repo-relative dirs whose file changes should always select this config. */
  testFileDirs: string[];
}

export interface RuntimeMap {
  /** Consumers must run everything when they see an unknown version. */
  mapVersion: typeof RUNTIME_MAP_VERSION;
  branch: string;
  commit: string;
  generatedAt: string;
  collectionBuild: { pipelineSlug: string; buildNumber: number };
  collection: {
    status: 'complete' | 'partial';
    enabled: number;
    ok: number;
    carried: number;
    failed: number;
  };
  /** Sorted interning table; doubles as the known-package universe for consumers. */
  packages: string[];
  /**
   * Packages with zero surviving functions in every freshly-collected config of
   * the flavor — pure boot noise, carrying no selection signal. Consumers MUST
   * run the full suite when a changed package appears here.
   */
  bootNoisePackages: { [flavor in FtrFlavor]: number[] };
  configs: Record<string, RuntimeMapConfigEntry>;
}

export interface OkConfigResult {
  head: SummaryHead;
  survivors: { server: string[]; browser: string[] };
}

export interface AssembleRuntimeMapInputs {
  /** Every enabled FTR config at this commit, with its stratum. */
  enabledConfigs: Map<string, FtrConfigStratum>;
  /** Freshly-collected exit-0 configs with their post-subtraction survivors. */
  okConfigs: Map<string, OkConfigResult>;
  /** Winning (but non-zero-exit) summaries, for `failed` entry timestamps. */
  failedHeads: Map<string, SummaryHead>;
  previousMap: RuntimeMap | undefined;
  branch: string;
  commit: string;
  generatedAt: string;
  collectionBuild: { pipelineSlug: string; buildNumber: number };
  carryMaxAgeDays?: number;
}

/**
 * Assemble the published map: intern packages, compute per-flavor boot-noise
 * packages from the fresh ok set, and fill non-collected configs from the
 * previous map (`carried`, age-capped) or as `failed` (consumers always run
 * failed/unmapped configs — "not in the map" must never mean "skip").
 */
export function assembleRuntimeMap(inputs: AssembleRuntimeMapInputs): RuntimeMap {
  const {
    enabledConfigs,
    okConfigs,
    failedHeads,
    previousMap,
    branch,
    commit,
    generatedAt,
    collectionBuild,
    carryMaxAgeDays = CARRY_MAX_AGE_DAYS,
  } = inputs;

  const carrySource = isUsableForCarry(previousMap, branch) ? previousMap : undefined;
  const carryFloor = new Date(generatedAt).getTime() - carryMaxAgeDays * 24 * 60 * 60 * 1000;

  interface NamedEntry {
    status: RuntimeMapConfigEntry['status'];
    collectedAt: string;
    server: string[];
    browser: string[];
    testFileDirs: string[];
  }
  const namedEntries = new Map<string, NamedEntry>();
  const counts = { ok: 0, carried: 0, failed: 0 };

  for (const configPath of [...enabledConfigs.keys()].sort()) {
    const ok = okConfigs.get(configPath);
    if (ok) {
      counts.ok++;
      namedEntries.set(configPath, {
        status: 'ok',
        collectedAt: ok.head.meta.recordedAt,
        server: ok.survivors.server,
        browser: ok.survivors.browser,
        testFileDirs: [configDir(configPath)],
      });
      continue;
    }

    const carried = carrySource && resolveCarriedEntry(carrySource, configPath, carryFloor);
    if (carried) {
      counts.carried++;
      namedEntries.set(configPath, carried);
      continue;
    }

    counts.failed++;
    namedEntries.set(configPath, {
      status: 'failed',
      collectedAt: failedHeads.get(configPath)?.meta.recordedAt ?? generatedAt,
      server: [],
      browser: [],
      testFileDirs: [configDir(configPath)],
    });
  }

  const bootNoiseNames = computeBootNoisePackages(enabledConfigs, okConfigs);

  const packageSet = new Set<string>();
  for (const entry of namedEntries.values()) {
    for (const name of entry.server) packageSet.add(name);
    for (const name of entry.browser) packageSet.add(name);
  }
  for (const names of Object.values(bootNoiseNames)) {
    for (const name of names) packageSet.add(name);
  }
  const packages = [...packageSet].sort();
  const packageIndex = new Map(packages.map((name, i) => [name, i]));
  const intern = (names: string[]) => names.map((name) => packageIndex.get(name)!);

  const configs: Record<string, RuntimeMapConfigEntry> = {};
  for (const [configPath, entry] of namedEntries) {
    configs[configPath] = {
      status: entry.status,
      collectedAt: entry.collectedAt,
      server: intern(entry.server),
      browser: intern(entry.browser),
      testFileDirs: entry.testFileDirs,
    };
  }

  const enabled = enabledConfigs.size;
  return {
    mapVersion: RUNTIME_MAP_VERSION,
    branch,
    commit,
    generatedAt,
    collectionBuild,
    collection: {
      status: enabled > 0 && counts.ok / enabled >= OK_FRACTION_FLOOR ? 'complete' : 'partial',
      enabled,
      ...counts,
    },
    packages,
    bootNoisePackages: {
      stateful: intern(bootNoiseNames.stateful),
      serverless: intern(bootNoiseNames.serverless),
    },
    configs,
  };
}

function configDir(configPath: string): string {
  const idx = configPath.lastIndexOf('/');
  return idx === -1 ? '.' : configPath.slice(0, idx);
}

function isUsableForCarry(map: RuntimeMap | undefined, branch: string): map is RuntimeMap {
  return (
    map !== undefined &&
    map.mapVersion === RUNTIME_MAP_VERSION &&
    map.branch === branch &&
    Array.isArray(map.packages)
  );
}

function resolveCarriedEntry(
  previousMap: RuntimeMap,
  configPath: string,
  carryFloorMs: number
):
  | {
      status: 'carried';
      collectedAt: string;
      server: string[];
      browser: string[];
      testFileDirs: string[];
    }
  | undefined {
  const prev = previousMap.configs?.[configPath];
  if (!prev || prev.status === 'failed') return undefined;
  const collectedMs = new Date(prev.collectedAt).getTime();
  if (!Number.isFinite(collectedMs) || collectedMs < carryFloorMs) return undefined;

  const unintern = (indices: number[]) => {
    const names: string[] = [];
    for (const idx of indices) {
      const name = previousMap.packages[idx];
      if (typeof name !== 'string') return undefined;
      names.push(name);
    }
    return names;
  };
  const server = unintern(prev.server ?? []);
  const browser = unintern(prev.browser ?? []);
  if (!server || !browser) return undefined;

  return {
    status: 'carried',
    collectedAt: prev.collectedAt,
    server,
    browser,
    testFileDirs: prev.testFileDirs ?? [configDir(configPath)],
  };
}

/**
 * Per flavor: packages that executed in ≥1 fresh config but survived
 * subtraction in none of them. These have zero selection signal in the map, so
 * consumers must treat a change to them as "run everything".
 */
function computeBootNoisePackages(
  enabledConfigs: Map<string, FtrConfigStratum>,
  okConfigs: Map<string, OkConfigResult>
): { [flavor in FtrFlavor]: string[] } {
  const present: { [flavor in FtrFlavor]: Set<string> } = {
    stateful: new Set(),
    serverless: new Set(),
  };
  const surviving: { [flavor in FtrFlavor]: Set<string> } = {
    stateful: new Set(),
    serverless: new Set(),
  };

  for (const [configPath, { head, survivors }] of okConfigs) {
    const flavor = enabledConfigs.get(configPath)?.flavor;
    if (!flavor) continue;
    for (const name of [...head.present.server, ...head.present.browser]) {
      present[flavor].add(name);
    }
    for (const name of [...survivors.server, ...survivors.browser]) {
      surviving[flavor].add(name);
    }
  }

  const noise = (flavor: FtrFlavor) =>
    [...present[flavor]].filter((name) => !surviving[flavor].has(name)).sort();
  return { stateful: noise('stateful'), serverless: noise('serverless') };
}

/**
 * Serialize the map with one line per package / per config entry so two
 * history copies from the bucket diff cleanly and day-over-day churn is
 * measurable in changed lines. Output is plain JSON.
 */
export function formatRuntimeMap(map: RuntimeMap): string {
  const lines: string[] = ['{'];
  const scalarKeys = [
    'mapVersion',
    'branch',
    'commit',
    'generatedAt',
    'collectionBuild',
    'collection',
  ] as const;
  for (const key of scalarKeys) {
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(map[key])},`);
  }

  lines.push('  "packages": [');
  map.packages.forEach((name, i) => {
    lines.push(`    ${JSON.stringify(name)}${i < map.packages.length - 1 ? ',' : ''}`);
  });
  lines.push('  ],');

  lines.push('  "bootNoisePackages": {');
  lines.push(`    "stateful": ${JSON.stringify(map.bootNoisePackages.stateful)},`);
  lines.push(`    "serverless": ${JSON.stringify(map.bootNoisePackages.serverless)}`);
  lines.push('  },');

  const configPaths = Object.keys(map.configs);
  lines.push('  "configs": {');
  configPaths.forEach((configPath, i) => {
    const entry = JSON.stringify(map.configs[configPath]);
    lines.push(
      `    ${JSON.stringify(configPath)}: ${entry}${i < configPaths.length - 1 ? ',' : ''}`
    );
  });
  lines.push('  }');
  lines.push('}');
  return lines.join('\n') + '\n';
}
