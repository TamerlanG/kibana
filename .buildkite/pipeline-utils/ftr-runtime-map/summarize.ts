/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import {
  findModuleForPath,
  findModuleForPluginId,
  UNCATEGORIZED_MODULE_ID,
} from '../affected-packages';
import { getKibanaDir } from '../utils';

/** Relevant subset of a `NODE_V8_COVERAGE` output file. */
interface V8CoverageRange {
  startOffset: number;
  count: number;
}
interface V8CoverageFunction {
  functionName: string;
  ranges?: V8CoverageRange[];
}
interface V8CoverageScript {
  url: string;
  functions?: V8CoverageFunction[];
}
interface V8CoverageFile {
  result?: V8CoverageScript[];
}

export interface CoverageProcessStats {
  /** Name of the `coverage-<pid>-<ts>-<n>.json` file (one per Node process). */
  coverageFile: string;
  /** Repo-owned scripts loaded by the process. */
  repoScriptCount: number;
  /** Executed repo-owned functions in the process (before cross-process de-duplication). */
  executedFunctionCount: number;
}

interface ExecutedFunctionRecord {
  moduleId: string;
  filePath: string;
}

export interface CollectedCoverage {
  /** `<filePath>::<functionName>::<startOffset>` → owning module + file (Node processes). */
  functions: Map<string, ExecutedFunctionRecord>;
  /** Same shape for browser-side scripts (http(s) bundle URLs from CDP dumps). */
  browserFunctions: Map<string, ExecutedFunctionRecord>;
  processes: CoverageProcessStats[];
}

export interface ModuleCoverageRow {
  moduleId: string;
  functionCount: number;
  fileCount: number;
}

export interface FtrCoverageSummary {
  /** Server modules with functions executed in the run (minus baseline), by functionCount desc. */
  rows: ModuleCoverageRow[];
  /** Sorted file lists per module, for the same set of functions as `rows`. */
  filesByModule: Map<string, string[]>;
  /** Browser-side modules (from CDP coverage of plugin bundles), same semantics as `rows`. */
  browserRows: ModuleCoverageRow[];
  browserFilesByModule: Map<string, string[]>;
  processes: CoverageProcessStats[];
  baselineProcesses?: CoverageProcessStats[];
  totalRunFunctions: number;
  totalBaselineFunctions?: number;
  /** Server functions executed in the run but not in the baseline. */
  newFunctionCount: number;
  totalRunBrowserFunctions: number;
  totalBaselineBrowserFunctions?: number;
  newBrowserFunctionCount: number;
}

/** Browser scripts under `/bundles/` that cannot be attributed to a module. */
export const BROWSER_UNATTRIBUTED_MODULE_ID = '[browser-unattributed]';

/** Non-plugin browser bundles with a fixed owning module. */
const STATIC_BUNDLE_MODULES = new Map<string, string>([
  ['core', '@kbn/core'],
  ['kbn-ui-shared-deps-npm', '@kbn/ui-shared-deps-npm'],
  ['kbn-ui-shared-deps-src', '@kbn/ui-shared-deps-src'],
  ['kbn-monaco', '@kbn/monaco'],
]);

/**
 * Matches Kibana packages installed under node_modules, which is where every
 * package/plugin lives in a built distribution (`kibana-build-*`).
 */
const KBN_NODE_MODULES_RE = /\/node_modules\/(@kbn\/[^/]+)\//;

/**
 * Read every `coverage-*.json` in a `NODE_V8_COVERAGE` output directory and
 * return the set of executed repo-owned functions, attributed to the `@kbn/`
 * module that owns the file. Functions are "executed" when any of their V8
 * ranges has `count > 0`. Unparseable coverage files are skipped with a
 * warning so one crashed process cannot invalidate a whole recording.
 */
export function collectExecutedFunctions(coverageDir: string): CollectedCoverage {
  const repoRoot = getKibanaDir();

  const coverageFiles = fs
    .readdirSync(coverageDir)
    .filter((f) => f.startsWith('coverage-') && f.endsWith('.json'))
    .sort();
  if (coverageFiles.length === 0) {
    throw new Error(`No coverage-*.json files found in ${coverageDir}`);
  }

  const classifyCache = new Map<string, ClassifiedScript | null>();
  const classify = (url: string): ClassifiedScript | null => {
    const cached = classifyCache.get(url);
    if (cached !== undefined) {
      return cached;
    }
    const classified = classifyUrl(url, repoRoot);
    classifyCache.set(url, classified);
    return classified;
  };

  const functions = new Map<string, ExecutedFunctionRecord>();
  const browserFunctions = new Map<string, ExecutedFunctionRecord>();
  const processes: CoverageProcessStats[] = [];

  for (const coverageFile of coverageFiles) {
    // A read failure (e.g. a dump above Node's ~512MB string limit) means a
    // healthy process produced data we cannot see — fail loud rather than
    // silently degrading the baseline subtraction. Only parse failures
    // (truncated dumps from crashed processes) are skippable.
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(coverageDir, coverageFile), 'utf8');
    } catch (error) {
      throw new Error(`Failed to read coverage file ${coverageFile}: ${error}`);
    }
    let data: V8CoverageFile;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      console.warn(`Skipping unparseable coverage file ${coverageFile}: ${error}`);
      continue;
    }

    let repoScriptCount = 0;
    let executedFunctionCount = 0;

    for (const script of data.result ?? []) {
      const classified = classify(script.url);
      if (!classified) {
        continue;
      }
      const { record, origin } = classified;
      const target = origin === 'browser' ? browserFunctions : functions;
      repoScriptCount++;

      for (const fn of script.functions ?? []) {
        const ranges = fn.ranges ?? [];
        if (!ranges.some((range) => range.count > 0)) {
          continue;
        }
        executedFunctionCount++;
        const key = `${record.filePath}::${fn.functionName}::${ranges[0]?.startOffset ?? 0}`;
        if (!target.has(key)) {
          target.set(key, record);
        }
      }
    }

    processes.push({ coverageFile, repoScriptCount, executedFunctionCount });
  }

  return { functions, browserFunctions, processes };
}

/**
 * Summarize which `@kbn/` modules an FTR run exercised, optionally subtracting
 * a boot-baseline recording (an FTR `--dry-run` of the same config) at
 * function granularity. Without the baseline the result is dominated by the
 * plugins Kibana initializes at boot regardless of the tests.
 */
export function summarizeFtrCoverage({
  runDir,
  baselineDir,
}: {
  runDir: string;
  baselineDir?: string;
}): FtrCoverageSummary {
  const run = collectExecutedFunctions(runDir);
  const baseline = baselineDir ? collectExecutedFunctions(baselineDir) : undefined;

  const server = aggregateNewFunctions(run.functions, baseline?.functions);
  const browser = aggregateNewFunctions(run.browserFunctions, baseline?.browserFunctions);

  return {
    rows: server.rows,
    filesByModule: server.filesByModule,
    browserRows: browser.rows,
    browserFilesByModule: browser.filesByModule,
    processes: run.processes,
    baselineProcesses: baseline?.processes,
    totalRunFunctions: run.functions.size,
    totalBaselineFunctions: baseline?.functions.size,
    newFunctionCount: server.newFunctionCount,
    totalRunBrowserFunctions: run.browserFunctions.size,
    totalBaselineBrowserFunctions: baseline?.browserFunctions.size,
    newBrowserFunctionCount: browser.newFunctionCount,
  };
}

function aggregateNewFunctions(
  runFunctions: Map<string, ExecutedFunctionRecord>,
  baselineFunctions: Map<string, ExecutedFunctionRecord> | undefined
): { rows: ModuleCoverageRow[]; filesByModule: Map<string, string[]>; newFunctionCount: number } {
  const functionCounts = new Map<string, number>();
  const fileSets = new Map<string, Set<string>>();
  let newFunctionCount = 0;

  for (const [key, record] of runFunctions) {
    if (baselineFunctions?.has(key)) {
      continue;
    }
    newFunctionCount++;
    functionCounts.set(record.moduleId, (functionCounts.get(record.moduleId) ?? 0) + 1);
    let files = fileSets.get(record.moduleId);
    if (!files) {
      files = new Set();
      fileSets.set(record.moduleId, files);
    }
    files.add(record.filePath);
  }

  const rows: ModuleCoverageRow[] = [...functionCounts.entries()]
    .map(([moduleId, functionCount]) => ({
      moduleId,
      functionCount,
      fileCount: fileSets.get(moduleId)?.size ?? 0,
    }))
    .sort((a, b) => b.functionCount - a.functionCount || a.moduleId.localeCompare(b.moduleId));

  const filesByModule = new Map<string, string[]>();
  for (const [moduleId, files] of fileSets) {
    filesByModule.set(moduleId, [...files].sort());
  }

  return { rows, filesByModule, newFunctionCount };
}

interface ClassifiedScript {
  record: ExecutedFunctionRecord;
  origin: 'server' | 'browser';
}

function classifyUrl(url: string, repoRoot: string): ClassifiedScript | null {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const record = classifyBrowserScriptUrl(url);
    return record ? { record, origin: 'browser' } : null;
  }
  const record = classifyScriptUrl(url, repoRoot);
  return record ? { record, origin: 'server' } : null;
}

/**
 * Attribute a browser script URL to a module. With the default (webpack)
 * optimizer every plugin is served as its own bundle, so the URL names the
 * plugin: `<basePath>/<buildSha>/bundles/plugin/<pluginId>/<version>/...`.
 * The basePath/buildSha prefix is stripped so function keys align between the
 * test run and the baseline. Non-bundle scripts (inline, bootstrap.js,
 * third-party origins) are ignored; unknown bundle shapes (e.g. the opt-in
 * rspack unified build) degrade to BROWSER_UNATTRIBUTED_MODULE_ID.
 */
function classifyBrowserScriptUrl(url: string): ExecutedFunctionRecord | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }

  const bundlesIndex = pathname.indexOf('/bundles/');
  if (bundlesIndex === -1) {
    return null;
  }
  const filePath = pathname.slice(bundlesIndex + 1);
  const [, kind, pluginId] = filePath.split('/');

  if (kind === 'plugin') {
    return {
      moduleId: (pluginId && findModuleForPluginId(pluginId)) || BROWSER_UNATTRIBUTED_MODULE_ID,
      filePath,
    };
  }
  return {
    moduleId: STATIC_BUNDLE_MODULES.get(kind) ?? BROWSER_UNATTRIBUTED_MODULE_ID,
    filePath,
  };
}

function classifyScriptUrl(url: string, repoRoot: string): ExecutedFunctionRecord | null {
  if (!url.startsWith('file://')) {
    return null;
  }

  let absPath: string;
  try {
    absPath = fileURLToPath(url);
  } catch {
    return null;
  }

  // Built-distribution layout: Kibana packages live under node_modules/@kbn/<id>.
  const kbnPackage = absPath.match(KBN_NODE_MODULES_RE);
  if (kbnPackage) {
    return {
      moduleId: kbnPackage[1],
      filePath: absPath.slice(absPath.indexOf('/node_modules/') + 1),
    };
  }

  // Any remaining node_modules path is a non-@kbn third-party dependency and is
  // not a Kibana package — drop it. This must check the whole path, not just a
  // repo-root prefix: running against a dist build (--kibana-install-dir) nests
  // deps under <installDir>/node_modules/... which can live inside the repo.
  if (absPath.includes('/node_modules/')) {
    return null;
  }

  if (!absPath.startsWith(repoRoot + path.sep)) {
    return null;
  }
  const relPath = path.relative(repoRoot, absPath).split(path.sep).join('/');

  return {
    moduleId: findModuleForPath(relPath) ?? UNCATEGORIZED_MODULE_ID,
    filePath: relPath,
  };
}
