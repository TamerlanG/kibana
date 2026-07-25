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
import {
  BROWSER_UNATTRIBUTED_MODULE_ID,
  collectExecutedFunctions,
  summarizeFtrCoverage,
} from './summarize';

function createModule(relDir: string, id: string): void {
  const dir = path.join(mockKibanaDir, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'kibana.jsonc'),
    JSON.stringify({ type: 'shared-common', id, owner: '@elastic/test' })
  );
}

function createPlugin(relDir: string, id: string, pluginId: string): void {
  const dir = path.join(mockKibanaDir, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'kibana.jsonc'),
    JSON.stringify({ type: 'plugin', id, owner: '@elastic/test', plugin: { id: pluginId } })
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
    createPlugin('src/plugins/my_plugin', '@kbn/my-plugin-plugin', 'myPlugin');
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

    it('drops third-party deps in a dist build nested inside the repo', () => {
      const runDir = path.join(coverageRoot, 'run');
      writeCoverageFile(runDir, 'coverage-1-1-0.json', [
        // real @kbn code in the same dist build is still attributed
        coverageScript(repoPath('webpack-build/kibana-9.6.0/node_modules/@kbn/pkg-a/target/x.js'), [
          { name: 'kbnFn', executed: true },
        ]),
        // third-party deps under the (in-repo) install dir must be dropped, not
        // bucketed as [uncategorized] — the node_modules is not at the repo root
        coverageScript(
          repoPath('webpack-build/kibana-9.6.0/node_modules/@elastic/elasticsearch/lib/api.js'),
          [{ name: 'esFn', executed: true }]
        ),
        coverageScript(
          repoPath('webpack-build/kibana-9.6.0/node_modules/@hapi/boom/lib/index.js'),
          [{ name: 'boomFn', executed: true }]
        ),
      ]);

      const { functions } = collectExecutedFunctions(runDir);

      expect([...functions.values()].map((r) => r.moduleId)).toEqual(['@kbn/pkg-a']);
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

  describe('browser coverage classification', () => {
    const bundleUrl = (suffix: string) => `http://localhost:5620/abc123/bundles/${suffix}`;

    it('attributes plugin bundle URLs (entry and chunks) via kibana.jsonc plugin.id', () => {
      const runDir = path.join(coverageRoot, 'run');
      writeCoverageFile(runDir, 'coverage-browser-0000.json', [
        coverageScript(
          '',
          [{ name: 'setup' }].map((f) => ({ ...f, executed: true })),
          bundleUrl('plugin/myPlugin/9.6.0/myPlugin.plugin.js')
        ),
        coverageScript(
          '',
          [{ name: 'lazyFn', executed: true }],
          bundleUrl('plugin/myPlugin/9.6.0/myPlugin.chunk.1.js')
        ),
      ]);

      const { functions, browserFunctions } = collectExecutedFunctions(runDir);

      expect(functions.size).toBe(0);
      expect(
        browserFunctions.get('bundles/plugin/myPlugin/9.6.0/myPlugin.plugin.js::setup::0')
      ).toEqual({
        moduleId: '@kbn/my-plugin-plugin',
        filePath: 'bundles/plugin/myPlugin/9.6.0/myPlugin.plugin.js',
      });
      expect(
        browserFunctions.get('bundles/plugin/myPlugin/9.6.0/myPlugin.chunk.1.js::lazyFn::0')
          ?.moduleId
      ).toBe('@kbn/my-plugin-plugin');
    });

    it('maps non-plugin bundles via the static map and unknown shapes to unattributed', () => {
      const runDir = path.join(coverageRoot, 'run');
      writeCoverageFile(runDir, 'coverage-browser-0000.json', [
        coverageScript('', [{ name: 'coreFn', executed: true }], bundleUrl('core/core.entry.js')),
        coverageScript(
          '',
          [{ name: 'dllFn', executed: true }],
          bundleUrl('kbn-ui-shared-deps-npm/shared.dll.js')
        ),
        coverageScript(
          '',
          [{ name: 'unknownPluginFn', executed: true }],
          bundleUrl('plugin/notARealPlugin/1.0.0/x.js')
        ),
        coverageScript(
          '',
          [{ name: 'rspackFn', executed: true }],
          bundleUrl('chunks/vendors.abc123.js')
        ),
        // non-bundle http scripts are ignored entirely
        coverageScript(
          '',
          [{ name: 'bootstrapFn', executed: true }],
          'http://localhost:5620/abc123/bootstrap.js'
        ),
        coverageScript('', [{ name: 'cdnFn', executed: true }], 'not a url'),
      ]);

      const { browserFunctions } = collectExecutedFunctions(runDir);

      const moduleIds = new Map(
        [...browserFunctions.values()].map((r) => [r.filePath, r.moduleId])
      );
      expect(moduleIds.get('bundles/core/core.entry.js')).toBe('@kbn/core');
      expect(moduleIds.get('bundles/kbn-ui-shared-deps-npm/shared.dll.js')).toBe(
        '@kbn/ui-shared-deps-npm'
      );
      expect(moduleIds.get('bundles/plugin/notARealPlugin/1.0.0/x.js')).toBe(
        BROWSER_UNATTRIBUTED_MODULE_ID
      );
      expect(moduleIds.get('bundles/chunks/vendors.abc123.js')).toBe(
        BROWSER_UNATTRIBUTED_MODULE_ID
      );
      expect(browserFunctions.size).toBe(4);
    });

    it('splits mixed server and browser scripts from one dump into separate buckets', () => {
      const runDir = path.join(coverageRoot, 'run');
      writeCoverageFile(runDir, 'coverage-1-1-0.json', [
        coverageScript(repoPath('src/pkg_a/server.ts'), [{ name: 'serverFn', executed: true }]),
        coverageScript(
          '',
          [{ name: 'browserFn', executed: true }],
          bundleUrl('plugin/myPlugin/9.6.0/myPlugin.plugin.js')
        ),
      ]);

      const { functions, browserFunctions, processes } = collectExecutedFunctions(runDir);

      expect([...functions.values()].map((r) => r.moduleId)).toEqual(['@kbn/pkg-a']);
      expect([...browserFunctions.values()].map((r) => r.moduleId)).toEqual([
        '@kbn/my-plugin-plugin',
      ]);
      expect(processes).toEqual([
        { coverageFile: 'coverage-1-1-0.json', repoScriptCount: 2, executedFunctionCount: 2 },
      ]);
    });

    it('subtracts the browser baseline independently of the server baseline', () => {
      const runDir = path.join(coverageRoot, 'run');
      const baselineDir = path.join(coverageRoot, 'baseline');
      const entryUrl = bundleUrl('plugin/myPlugin/9.6.0/myPlugin.plugin.js');

      writeCoverageFile(runDir, 'coverage-browser-0000.json', [
        coverageScript(
          '',
          [
            { name: 'bootRegistration', executed: true },
            { name: 'appOnlyFn', executed: true, startOffset: 100 },
          ],
          entryUrl
        ),
      ]);
      writeCoverageFile(runDir, 'coverage-1-1-0.json', [
        coverageScript(repoPath('src/pkg_a/server.ts'), [{ name: 'serverFn', executed: true }]),
      ]);
      writeCoverageFile(baselineDir, 'coverage-browser-0000.json', [
        coverageScript('', [{ name: 'bootRegistration', executed: true }], entryUrl),
      ]);

      const summary = summarizeFtrCoverage({ runDir, baselineDir });

      expect(summary.totalRunBrowserFunctions).toBe(2);
      expect(summary.totalBaselineBrowserFunctions).toBe(1);
      expect(summary.newBrowserFunctionCount).toBe(1);
      expect(summary.browserRows).toEqual([
        { moduleId: '@kbn/my-plugin-plugin', functionCount: 1, fileCount: 1 },
      ]);
      // server side is unaffected by browser data
      expect(summary.newFunctionCount).toBe(1);
      expect(summary.rows).toEqual([{ moduleId: '@kbn/pkg-a', functionCount: 1, fileCount: 1 }]);
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
