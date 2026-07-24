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
import { pathToFileURL } from 'url';

let mockKibanaDir: string;

jest.mock('../utils', () => ({
  getKibanaDir: () => mockKibanaDir,
}));

import { UNCATEGORIZED_MODULE_ID } from '../affected-packages';
import { resetModuleLookupCache } from '../affected-packages/module_lookup';
import { collectExecutedFunctions, summarizeFtrCoverage } from './summarize';

function createModule(relDir: string, id: string): void {
  const dir = path.join(mockKibanaDir, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'kibana.jsonc'),
    JSON.stringify({ type: 'shared-common', id, owner: '@elastic/test' })
  );
}

interface FnSpec {
  name: string;
  executed: boolean;
  startOffset?: number;
}

function coverageScript(absPath: string, fns: FnSpec[], url?: string) {
  return {
    url: url ?? pathToFileURL(absPath).href,
    functions: fns.map(({ name, executed, startOffset = 0 }) => ({
      functionName: name,
      ranges: [{ startOffset, endOffset: startOffset + 10, count: executed ? 1 : 0 }],
    })),
  };
}

function writeCoverageFile(dir: string, name: string, scripts: unknown[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ result: scripts }));
}

function repoPath(relPath: string): string {
  return path.join(mockKibanaDir, relPath);
}

describe('ftr-runtime-map summarize', () => {
  let coverageRoot: string;

  beforeEach(() => {
    mockKibanaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftr-runtime-map-repo-'));
    coverageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ftr-runtime-map-cov-'));
    resetModuleLookupCache();

    createModule('src/pkg_a', '@kbn/pkg-a');
    createModule('src/pkg_a/nested', '@kbn/pkg-a-nested');
    createModule('x-pack/pkg_b', '@kbn/pkg-b');
  });

  afterEach(() => {
    fs.rmSync(mockKibanaDir, { recursive: true, force: true });
    fs.rmSync(coverageRoot, { recursive: true, force: true });
    resetModuleLookupCache();
  });

  describe('collectExecutedFunctions', () => {
    it('collects executed functions from repo files and skips the rest', () => {
      const runDir = path.join(coverageRoot, 'run');
      writeCoverageFile(runDir, 'coverage-1-1-0.json', [
        coverageScript(repoPath('src/pkg_a/server.ts'), [
          { name: 'handler', executed: true },
          { name: 'neverCalled', executed: false, startOffset: 50 },
        ]),
        // non-file URL and files outside the repo are ignored
        coverageScript('', [{ name: 'x', executed: true }], 'node:internal/bootstrap'),
        coverageScript(path.join(os.tmpdir(), 'outside.js'), [{ name: 'x', executed: true }]),
        // non-@kbn node_modules code is ignored
        coverageScript(repoPath('node_modules/lodash/index.js'), [{ name: 'x', executed: true }]),
      ]);

      const { functions, processes } = collectExecutedFunctions(runDir);

      expect([...functions.keys()]).toEqual(['src/pkg_a/server.ts::handler::0']);
      expect(functions.get('src/pkg_a/server.ts::handler::0')).toEqual({
        moduleId: '@kbn/pkg-a',
        filePath: 'src/pkg_a/server.ts',
      });
      expect(processes).toEqual([
        { coverageFile: 'coverage-1-1-0.json', repoScriptCount: 1, executedFunctionCount: 1 },
      ]);
    });

    it('maps node_modules/@kbn paths to the package id (dist layout)', () => {
      const runDir = path.join(coverageRoot, 'run');
      const distPath = '/opt/kibana-build/node_modules/@kbn/dist-pkg/target/server.js';
      writeCoverageFile(runDir, 'coverage-1-1-0.json', [
        coverageScript(distPath, [{ name: 'boot', executed: true }]),
      ]);

      const { functions } = collectExecutedFunctions(runDir);

      expect(functions.get('node_modules/@kbn/dist-pkg/target/server.js::boot::0')).toEqual({
        moduleId: '@kbn/dist-pkg',
        filePath: 'node_modules/@kbn/dist-pkg/target/server.js',
      });
    });

    it('attributes files to the nearest kibana.jsonc and falls back to uncategorized', () => {
      const runDir = path.join(coverageRoot, 'run');
      writeCoverageFile(runDir, 'coverage-1-1-0.json', [
        coverageScript(repoPath('src/pkg_a/nested/deep/file.ts'), [
          { name: 'nestedFn', executed: true },
        ]),
        coverageScript(repoPath('scripts/loose_file.js'), [{ name: 'looseFn', executed: true }]),
      ]);

      const { functions } = collectExecutedFunctions(runDir);

      expect(functions.get('src/pkg_a/nested/deep/file.ts::nestedFn::0')?.moduleId).toBe(
        '@kbn/pkg-a-nested'
      );
      expect(functions.get('scripts/loose_file.js::looseFn::0')?.moduleId).toBe(
        UNCATEGORIZED_MODULE_ID
      );
    });

    it('skips unparseable coverage files but keeps the valid ones', () => {
      const runDir = path.join(coverageRoot, 'run');
      writeCoverageFile(runDir, 'coverage-1-1-0.json', [
        coverageScript(repoPath('src/pkg_a/server.ts'), [{ name: 'handler', executed: true }]),
      ]);
      fs.writeFileSync(path.join(runDir, 'coverage-2-2-0.json'), 'not valid json{');

      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { functions, processes } = collectExecutedFunctions(runDir);
        expect(functions.size).toBe(1);
        expect(processes).toHaveLength(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('coverage-2-2-0.json'));
      } finally {
        warn.mockRestore();
      }
    });

    it('throws when the directory contains no coverage files', () => {
      const emptyDir = path.join(coverageRoot, 'empty');
      fs.mkdirSync(emptyDir, { recursive: true });

      expect(() => collectExecutedFunctions(emptyDir)).toThrow(/No coverage-\*\.json files/);
    });

    it('fails loud when a coverage file cannot be read (not silently skipped)', () => {
      const runDir = path.join(coverageRoot, 'run');
      writeCoverageFile(runDir, 'coverage-1-1-0.json', [
        coverageScript(repoPath('src/pkg_a/server.ts'), [{ name: 'handler', executed: true }]),
      ]);
      // a directory matching the coverage-file pattern makes readFileSync throw
      fs.mkdirSync(path.join(runDir, 'coverage-2-2-0.json'));

      expect(() => collectExecutedFunctions(runDir)).toThrow(
        /Failed to read coverage file coverage-2-2-0\.json/
      );
    });
  });

  describe('summarizeFtrCoverage', () => {
    it('subtracts the baseline at function granularity', () => {
      const runDir = path.join(coverageRoot, 'run');
      const baselineDir = path.join(coverageRoot, 'baseline');

      writeCoverageFile(runDir, 'coverage-1-1-0.json', [
        coverageScript(repoPath('src/pkg_a/boot.ts'), [
          { name: 'bootFn', executed: true },
          // same file as the baseline, but a different function
          { name: 'testOnlyFn', executed: true, startOffset: 100 },
        ]),
        coverageScript(repoPath('x-pack/pkg_b/feature.ts'), [
          { name: 'featureFn', executed: true },
        ]),
      ]);
      writeCoverageFile(baselineDir, 'coverage-9-9-0.json', [
        coverageScript(repoPath('src/pkg_a/boot.ts'), [{ name: 'bootFn', executed: true }]),
      ]);

      const summary = summarizeFtrCoverage({ runDir, baselineDir });

      expect(summary.totalRunFunctions).toBe(3);
      expect(summary.totalBaselineFunctions).toBe(1);
      expect(summary.newFunctionCount).toBe(2);
      expect(summary.rows).toEqual([
        { moduleId: '@kbn/pkg-a', functionCount: 1, fileCount: 1 },
        { moduleId: '@kbn/pkg-b', functionCount: 1, fileCount: 1 },
      ]);
      expect(summary.filesByModule.get('@kbn/pkg-a')).toEqual(['src/pkg_a/boot.ts']);
      expect(summary.filesByModule.get('@kbn/pkg-b')).toEqual(['x-pack/pkg_b/feature.ts']);
    });

    it('aggregates everything when no baseline is given', () => {
      const runDir = path.join(coverageRoot, 'run');
      writeCoverageFile(runDir, 'coverage-1-1-0.json', [
        coverageScript(repoPath('src/pkg_a/a.ts'), [
          { name: 'one', executed: true },
          { name: 'two', executed: true, startOffset: 30 },
        ]),
        coverageScript(repoPath('src/pkg_a/b.ts'), [{ name: 'three', executed: true }]),
      ]);

      const summary = summarizeFtrCoverage({ runDir });

      expect(summary.totalBaselineFunctions).toBeUndefined();
      expect(summary.newFunctionCount).toBe(3);
      expect(summary.rows).toEqual([{ moduleId: '@kbn/pkg-a', functionCount: 3, fileCount: 2 }]);
    });

    it('de-duplicates functions reported by multiple processes', () => {
      const runDir = path.join(coverageRoot, 'run');
      const script = coverageScript(repoPath('src/pkg_a/a.ts'), [{ name: 'fn', executed: true }]);
      writeCoverageFile(runDir, 'coverage-1-1-0.json', [script]);
      writeCoverageFile(runDir, 'coverage-2-2-0.json', [script]);

      const summary = summarizeFtrCoverage({ runDir });

      expect(summary.processes).toHaveLength(2);
      expect(summary.newFunctionCount).toBe(1);
      expect(summary.rows).toEqual([{ moduleId: '@kbn/pkg-a', functionCount: 1, fileCount: 1 }]);
    });
  });
});
