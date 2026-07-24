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

import type { FtrCoverageSummary } from './summarize';

/** Print process stats to stderr and the module table to stdout. */
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
  console.error(
    `  executed functions: run=${summary.totalRunFunctions}` +
      (summary.totalBaselineFunctions !== undefined
        ? ` baseline=${summary.totalBaselineFunctions} new=${summary.newFunctionCount}`
        : '')
  );

  const label = summary.baselineProcesses
    ? 'modules with functions executed only in the test run'
    : 'modules touched (no baseline subtracted)';
  console.log(`\n=== ${label}: ${summary.rows.length} ===`);
  console.log('functions  files  module');
  for (const row of summary.rows) {
    console.log(
      `${String(row.functionCount).padStart(9)}  ${String(row.fileCount).padStart(5)}  ${
        row.moduleId
      }`
    );
  }
}

/** Write `{ [moduleId]: filePaths[] }` for the post-subtraction functions. */
export function writeDetailJson(summary: FtrCoverageSummary, outFile: string): void {
  const detail = Object.fromEntries(
    [...summary.filesByModule.entries()].sort(([a], [b]) => a.localeCompare(b))
  );
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(detail, null, 2));
  console.error(`wrote ${outFile}`);
}
