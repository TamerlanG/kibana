/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeDetailJson } from './report';
import type { FtrCoverageSummary, ModuleCoverageRow } from './summarize';

function row(moduleId: string, functionCount: number, fileCount: number): ModuleCoverageRow {
  return { moduleId, functionCount, fileCount };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ftr-runtime-map-report-'));
}

describe('ftr-runtime-map report.writeDetailJson', () => {
  let outDir: string;

  beforeEach(() => {
    outDir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('persists server-only module file lists at top level plus a meta block', () => {
    const summary: FtrCoverageSummary = {
      rows: [row('@kbn/pkg-a', 3, 2), row('@kbn/pkg-b', 1, 1)],
      filesByModule: new Map([
        ['@kbn/pkg-a', ['src/pkg_a/a.ts', 'src/pkg_a/b.ts']],
        ['@kbn/pkg-b', ['x-pack/pkg_b/c.ts']],
      ]),
      functionsByModule: new Map(),
      browserRows: [],
      browserFilesByModule: new Map(),
      browserFunctionsByModule: new Map(),
      processes: [
        { coverageFile: 'coverage-1-0-0.json', repoScriptCount: 2, executedFunctionCount: 4 },
      ],
      baselineProcesses: [
        { coverageFile: 'coverage-2-0-0.json', repoScriptCount: 1, executedFunctionCount: 2 },
      ],
      totalRunFunctions: 4,
      totalBaselineFunctions: 2,
      newFunctionCount: 2,
      totalRunBrowserFunctions: 0,
      newBrowserFunctionCount: 0,
    };

    const out = path.join(outDir, 'packages.json');
    writeDetailJson(summary, out);

    const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));

    // Existing shape: module file lists stay top-level.
    expect(parsed['@kbn/pkg-a']).toEqual(['src/pkg_a/a.ts', 'src/pkg_a/b.ts']);
    expect(parsed['@kbn/pkg-b']).toEqual(['x-pack/pkg_b/c.ts']);

    // New meta block carries the totals needed to diagnose a run post-hoc.
    expect(parsed.meta.run.totalFunctions).toBe(4);
    expect(parsed.meta.baseline.totalFunctions).toBe(2);
    expect(parsed.meta.newFunctionCount).toBe(2);
    expect(parsed.meta.serverCounts).toEqual({
      '@kbn/pkg-a': { functions: 3, files: 2 },
      '@kbn/pkg-b': { functions: 1, files: 1 },
    });
    // No browser data recorded.
    expect(parsed.meta.run.totalBrowserFunctions).toBe(0);
    expect(parsed.meta.browserCounts).toEqual({});
  });

  it('persists a { server, browser, meta } split when browser coverage was recorded', () => {
    const summary: FtrCoverageSummary = {
      rows: [row('@kbn/pkg-a', 2, 1)],
      filesByModule: new Map([['@kbn/pkg-a', ['src/pkg_a/server.ts']]]),
      functionsByModule: new Map(),
      browserRows: [row('@kbn/my-plugin-plugin', 5, 1)],
      browserFilesByModule: new Map([
        ['@kbn/my-plugin-plugin', ['bundles/chunks/plugin-myPlugin.abc123.js']],
      ]),
      browserFunctionsByModule: new Map(),
      processes: [
        { coverageFile: 'coverage-1-0-0.json', repoScriptCount: 1, executedFunctionCount: 2 },
      ],
      baselineProcesses: [
        { coverageFile: 'coverage-2-0-0.json', repoScriptCount: 1, executedFunctionCount: 1 },
      ],
      totalRunFunctions: 2,
      totalBaselineFunctions: 1,
      newFunctionCount: 1,
      totalRunBrowserFunctions: 6,
      totalBaselineBrowserFunctions: 1,
      newBrowserFunctionCount: 5,
    };

    const out = path.join(outDir, 'packages.json');
    writeDetailJson(summary, out);

    const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));

    // Split shape.
    expect(Object.keys(parsed).sort()).toEqual(['browser', 'meta', 'server']);
    expect(parsed.server['@kbn/pkg-a']).toEqual(['src/pkg_a/server.ts']);
    expect(parsed.browser['@kbn/my-plugin-plugin']).toEqual([
      'bundles/chunks/plugin-myPlugin.abc123.js',
    ]);

    // meta carries both sides' totals + per-module counts.
    expect(parsed.meta.run.totalFunctions).toBe(2);
    expect(parsed.meta.run.totalBrowserFunctions).toBe(6);
    expect(parsed.meta.baseline.totalFunctions).toBe(1);
    expect(parsed.meta.baseline.totalBrowserFunctions).toBe(1);
    expect(parsed.meta.newFunctionCount).toBe(1);
    expect(parsed.meta.newBrowserFunctionCount).toBe(5);
    expect(parsed.meta.serverCounts).toEqual({
      '@kbn/pkg-a': { functions: 2, files: 1 },
    });
    expect(parsed.meta.browserCounts).toEqual({
      '@kbn/my-plugin-plugin': { functions: 5, files: 1 },
    });
  });

  it('writes meta.baseline as null when no baseline was recorded', () => {
    const summary: FtrCoverageSummary = {
      rows: [row('@kbn/pkg-a', 1, 1)],
      filesByModule: new Map([['@kbn/pkg-a', ['src/pkg_a/a.ts']]]),
      functionsByModule: new Map(),
      browserRows: [],
      browserFilesByModule: new Map(),
      browserFunctionsByModule: new Map(),
      processes: [
        { coverageFile: 'coverage-1-0-0.json', repoScriptCount: 1, executedFunctionCount: 1 },
      ],
      // baselineProcesses undefined => no baseline
      totalRunFunctions: 1,
      newFunctionCount: 1,
      totalRunBrowserFunctions: 0,
      newBrowserFunctionCount: 0,
    };

    const out = path.join(outDir, 'packages.json');
    writeDetailJson(summary, out);

    const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));

    expect(parsed.meta.baseline).toBeNull();
    expect(parsed.meta.run.totalFunctions).toBe(1);
  });
});
