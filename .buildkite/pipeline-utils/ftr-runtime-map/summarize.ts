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

import { findModuleForPath, UNCATEGORIZED_MODULE_ID } from '../affected-packages';
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
  /** `<filePath>::<functionName>::<startOffset>` → owning module + file. */
  functions: Map<string, ExecutedFunctionRecord>;
  processes: CoverageProcessStats[];
}

export interface ModuleCoverageRow {
  moduleId: string;
  functionCount: number;
  fileCount: number;
}

export interface FtrCoverageSummary {
  /** Modules with functions executed in the run (minus baseline), by functionCount desc. */
  rows: ModuleCoverageRow[];
  /** Sorted file lists per module, for the same set of functions as `rows`. */
  filesByModule: Map<string, string[]>;
  processes: CoverageProcessStats[];
  baselineProcesses?: CoverageProcessStats[];
  totalRunFunctions: number;
  totalBaselineFunctions?: number;
  /** Functions executed in the run but not in the baseline. */
  newFunctionCount: number;
}

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

  const classifyCache = new Map<string, ExecutedFunctionRecord | null>();
  const classify = (url: string): ExecutedFunctionRecord | null => {
    const cached = classifyCache.get(url);
    if (cached !== undefined) {
      return cached;
    }
    const record = classifyScriptUrl(url, repoRoot);
    classifyCache.set(url, record);
    return record;
  };

  const functions = new Map<string, ExecutedFunctionRecord>();
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
      const record = classify(script.url);
      if (!record) {
        continue;
      }
      repoScriptCount++;

      for (const fn of script.functions ?? []) {
        const ranges = fn.ranges ?? [];
        if (!ranges.some((range) => range.count > 0)) {
          continue;
        }
        executedFunctionCount++;
        const key = `${record.filePath}::${fn.functionName}::${ranges[0]?.startOffset ?? 0}`;
        if (!functions.has(key)) {
          functions.set(key, record);
        }
      }
    }

    processes.push({ coverageFile, repoScriptCount, executedFunctionCount });
  }

  return { functions, processes };
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

  const functionCounts = new Map<string, number>();
  const fileSets = new Map<string, Set<string>>();
  let newFunctionCount = 0;

  for (const [key, record] of run.functions) {
    if (baseline?.functions.has(key)) {
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

  return {
    rows,
    filesByModule,
    processes: run.processes,
    baselineProcesses: baseline?.processes,
    totalRunFunctions: run.functions.size,
    totalBaselineFunctions: baseline?.functions.size,
    newFunctionCount,
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

  // Built-distribution layout: packages live under node_modules/@kbn/<id>.
  const kbnPackage = absPath.match(KBN_NODE_MODULES_RE);
  if (kbnPackage) {
    return {
      moduleId: kbnPackage[1],
      filePath: absPath.slice(absPath.indexOf('/node_modules/') + 1),
    };
  }

  if (!absPath.startsWith(repoRoot + path.sep)) {
    return null;
  }
  const relPath = path.relative(repoRoot, absPath).split(path.sep).join('/');
  if (relPath.startsWith('node_modules/')) {
    return null;
  }

  return {
    moduleId: findModuleForPath(relPath) ?? UNCATEGORIZED_MODULE_ID,
    filePath: relPath,
  };
}
