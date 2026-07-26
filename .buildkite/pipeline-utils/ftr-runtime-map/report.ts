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

import type { FtrCoverageSummary, ModuleCoverageRow, ModuleFunctionDetail } from './summarize';

/** Print process stats to stderr and the module tables to stdout. */
export function printSummary(summary: FtrCoverageSummary, { verbose = false } = {}): void {
  for (const proc of summary.processes) {
    console.error(
      `  run process ${proc.coverageFile}: repoScripts=${proc.repoScriptCount} executedFns=${proc.executedFunctionCount}`
    );
  }
  for (const proc of summary.baselineProcesses ?? []) {
    console.error(
      `  baseline process ${proc.coverageFile}: repoScripts=${proc.repoScriptCount} executedFns=${proc.executedFunctionCount}`
    );
  }
  const hasBaseline = summary.baselineProcesses !== undefined;
  console.error(
    `  executed server functions: run=${summary.totalRunFunctions}` +
      (hasBaseline
        ? ` baseline=${summary.totalBaselineFunctions} new=${summary.newFunctionCount}`
        : '')
  );
  if (summary.totalRunBrowserFunctions > 0) {
    console.error(
      `  executed browser functions: run=${summary.totalRunBrowserFunctions}` +
        (hasBaseline
          ? ` baseline=${summary.totalBaselineBrowserFunctions} new=${summary.newBrowserFunctionCount}`
          : '')
    );
  }

  printUnifiedTable(
    hasBaseline
      ? 'modules with functions executed only in the test run'
      : 'modules touched (no baseline subtracted)',
    summary.rows,
    summary.browserRows
  );

  if (verbose) {
    printFunctionDetail(
      'server functions executed per module',
      summary.rows,
      summary.functionsByModule
    );
    if (summary.totalRunBrowserFunctions > 0) {
      printFunctionDetail(
        'browser functions executed per module',
        summary.browserRows,
        summary.browserFunctionsByModule
      );
    }
  }
}

/**
 * Per-module breakdown of the exact functions that executed, grouped by file.
 * An empty function name at offset 0 is the file's top-level wrapper, shown as
 * `<module-init>` — a module whose only entries are `<module-init>` was merely
 * loaded/initialized, not actually exercised by a test. Empty names at other
 * offsets are anonymous functions (inline callbacks, IIFEs), i.e. real code.
 */
function printFunctionDetail(
  label: string,
  rows: ModuleCoverageRow[],
  functionsByModule: Map<string, ModuleFunctionDetail[]>
): void {
  console.log(`\n=== ${label} ===`);
  for (const row of rows) {
    const fns = functionsByModule.get(row.moduleId) ?? [];
    console.log(`\n${row.moduleId} (${fns.length} functions, ${row.fileCount} files)`);
    let currentFile: string | undefined;
    for (const fn of fns) {
      if (fn.filePath !== currentFile) {
        currentFile = fn.filePath;
        console.log(`  ${fn.filePath}`);
      }
      console.log(
        `    ${fn.functionName || (fn.startOffset === 0 ? '<module-init>' : '<anonymous>')}`
      );
    }
  }
}

interface UnifiedModuleRow {
  moduleId: string;
  serverFunctions: number;
  browserFunctions: number;
  fileCount: number;
}

/**
 * Merge the server and browser module rows into a single deduped table keyed by
 * moduleId, with the per-origin function counts side by side (a `-` count means
 * the module was not exercised on that side). Sorted by total functions desc,
 * then moduleId.
 */
function mergeRows(
  serverRows: ModuleCoverageRow[],
  browserRows: ModuleCoverageRow[]
): UnifiedModuleRow[] {
  const byModule = new Map<string, UnifiedModuleRow>();

  const upsert = (row: ModuleCoverageRow, origin: 'server' | 'browser') => {
    let unified = byModule.get(row.moduleId);
    if (!unified) {
      unified = { moduleId: row.moduleId, serverFunctions: 0, browserFunctions: 0, fileCount: 0 };
      byModule.set(row.moduleId, unified);
    }
    if (origin === 'server') {
      unified.serverFunctions = row.functionCount;
    } else {
      unified.browserFunctions = row.functionCount;
    }
    // Server and browser file paths are disjoint (source paths vs bundle URLs),
    // so the counts add up to distinct files touched.
    unified.fileCount += row.fileCount;
  };

  for (const row of serverRows) {
    upsert(row, 'server');
  }
  for (const row of browserRows) {
    upsert(row, 'browser');
  }

  return [...byModule.values()].sort(
    (a, b) =>
      b.serverFunctions + b.browserFunctions - (a.serverFunctions + a.browserFunctions) ||
      a.moduleId.localeCompare(b.moduleId)
  );
}

function printUnifiedTable(
  label: string,
  serverRows: ModuleCoverageRow[],
  browserRows: ModuleCoverageRow[]
): void {
  const rows = mergeRows(serverRows, browserRows);
  console.log(`\n=== ${label}: ${rows.length} ===`);
  console.log(' server  browser  files  module');
  const fmt = (n: number) => (n === 0 ? '-' : String(n));
  for (const row of rows) {
    console.log(
      `${fmt(row.serverFunctions).padStart(7)}  ${fmt(row.browserFunctions).padStart(7)}  ${String(
        row.fileCount
      ).padStart(5)}  ${row.moduleId}`
    );
  }
}

/**
 * Write per-module file lists for the post-subtraction functions. Flat
 * `{ [moduleId]: filePaths[] }` when only server data exists; split into
 * `{ server, browser }` sections when browser coverage was recorded.
 */
export function writeDetailJson(summary: FtrCoverageSummary, outFile: string): void {
  const toSortedObject = (filesByModule: Map<string, string[]>) =>
    Object.fromEntries([...filesByModule.entries()].sort(([a], [b]) => a.localeCompare(b)));

  const detail =
    summary.totalRunBrowserFunctions > 0
      ? {
          server: toSortedObject(summary.filesByModule),
          browser: toSortedObject(summary.browserFilesByModule),
        }
      : toSortedObject(summary.filesByModule);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(detail, null, 2));
  console.error(`wrote ${outFile}`);
}
