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

import type { FtrCoverageSummary, ModuleCoverageRow } from './summarize';

/** Print process stats to stderr and the module tables to stdout. */
export function printSummary(summary: FtrCoverageSummary): void {
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

  printTable(
    hasBaseline
      ? 'server modules with functions executed only in the test run'
      : 'server modules touched (no baseline subtracted)',
    summary.rows
  );

  if (summary.totalRunBrowserFunctions > 0) {
    printTable(
      hasBaseline
        ? 'browser modules with functions executed only in the test run'
        : 'browser modules touched (no baseline subtracted)',
      summary.browserRows
    );
  }
}

function printTable(label: string, rows: ModuleCoverageRow[]): void {
  console.log(`\n=== ${label}: ${rows.length} ===`);
  console.log('functions  files  module');
  for (const row of rows) {
    console.log(
      `${String(row.functionCount).padStart(9)}  ${String(row.fileCount).padStart(5)}  ${
        row.moduleId
      }`
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
