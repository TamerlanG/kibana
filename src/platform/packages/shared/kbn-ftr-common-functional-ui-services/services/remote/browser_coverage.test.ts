/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import * as Fs from 'fs';
import * as Os from 'os';
import * as Path from 'path';

import { ToolingLog } from '@kbn/tooling-log';

import { BrowserCoverageCollector } from './browser_coverage';
import { Browsers } from './browsers';

describe('BrowserCoverageCollector', () => {
  const log = new ToolingLog();
  let coverageDir: string;
  let originalEnv: string | undefined;

  const createFakeDriver = () => ({
    sendDevToolsCommand: jest.fn().mockResolvedValue(undefined),
    sendAndGetDevToolsCommand: jest.fn().mockResolvedValue({ result: [] }),
  });

  beforeEach(() => {
    originalEnv = process.env.FTR_BROWSER_COVERAGE_DIR;
    coverageDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'browser-coverage-test-'));
    process.env.FTR_BROWSER_COVERAGE_DIR = coverageDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.FTR_BROWSER_COVERAGE_DIR;
    } else {
      process.env.FTR_BROWSER_COVERAGE_DIR = originalEnv;
    }
    Fs.rmSync(coverageDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('returns undefined when FTR_BROWSER_COVERAGE_DIR is not set', () => {
      delete process.env.FTR_BROWSER_COVERAGE_DIR;

      const collector = BrowserCoverageCollector.create({
        driver: createFakeDriver(),
        browserType: Browsers.Chrome,
        log,
      });

      expect(collector).toBeUndefined();
    });

    it('returns undefined for non-Chrome browsers', () => {
      const collector = BrowserCoverageCollector.create({
        driver: createFakeDriver(),
        browserType: Browsers.Firefox,
        log,
      });

      expect(collector).toBeUndefined();
    });

    it('returns undefined when the driver has no CDP methods', () => {
      const collector = BrowserCoverageCollector.create({
        driver: {},
        browserType: Browsers.Chrome,
        log,
      });

      expect(collector).toBeUndefined();
    });

    it('returns a collector for Chrome with a CDP-capable driver', () => {
      const collector = BrowserCoverageCollector.create({
        driver: createFakeDriver(),
        browserType: Browsers.Chrome,
        log,
      });

      expect(collector).toBeInstanceOf(BrowserCoverageCollector);
    });
  });

  describe('start', () => {
    it('enables the profiler and starts precise coverage', async () => {
      const driver = createFakeDriver();
      const collector = BrowserCoverageCollector.create({
        driver,
        browserType: Browsers.Chrome,
        log,
      })!;

      await collector.start();

      expect(driver.sendDevToolsCommand).toHaveBeenCalledWith('Profiler.enable');
      expect(driver.sendDevToolsCommand).toHaveBeenCalledWith('Profiler.startPreciseCoverage', {
        callCount: false,
        detailed: false,
      });
    });

    it('swallows CDP errors', async () => {
      const driver = createFakeDriver();
      driver.sendDevToolsCommand.mockRejectedValue(new Error('boom'));
      const collector = BrowserCoverageCollector.create({
        driver,
        browserType: Browsers.Chrome,
        log,
      })!;

      await expect(collector.start()).resolves.toBeUndefined();
    });
  });

  describe('flush', () => {
    it('writes sequential dump files with the NODE_V8_COVERAGE layout', async () => {
      const driver = createFakeDriver();
      const scripts = [{ url: 'http://localhost:5620/abc/bundles/core/core.entry.js' }];
      driver.sendAndGetDevToolsCommand.mockResolvedValue({ result: scripts });
      const collector = BrowserCoverageCollector.create({
        driver,
        browserType: Browsers.Chrome,
        log,
      })!;

      await collector.flush();
      await collector.flush();

      const files = Fs.readdirSync(coverageDir).sort();
      expect(files).toEqual(['coverage-browser-0000.json', 'coverage-browser-0001.json']);
      expect(JSON.parse(Fs.readFileSync(Path.join(coverageDir, files[0]), 'utf8'))).toEqual({
        result: scripts,
      });
    });

    it('writes nothing when the coverage result is empty', async () => {
      const driver = createFakeDriver();
      const collector = BrowserCoverageCollector.create({
        driver,
        browserType: Browsers.Chrome,
        log,
      })!;

      await collector.flush();

      expect(Fs.readdirSync(coverageDir)).toEqual([]);
    });

    it('swallows CDP errors and re-arms coverage', async () => {
      const driver = createFakeDriver();
      driver.sendAndGetDevToolsCommand.mockRejectedValue(new Error('not started'));
      const collector = BrowserCoverageCollector.create({
        driver,
        browserType: Browsers.Chrome,
        log,
      })!;

      await expect(collector.flush()).resolves.toBeUndefined();

      expect(driver.sendDevToolsCommand).toHaveBeenCalledWith('Profiler.enable');
      expect(driver.sendDevToolsCommand).toHaveBeenCalledWith(
        'Profiler.startPreciseCoverage',
        expect.anything()
      );
    });

    it('recovers load-time execution via best-effort coverage on an un-armed target', async () => {
      const driver = createFakeDriver();
      const scripts = [{ url: 'http://localhost:5620/abc/bundles/core/core.entry.js' }];
      // precise coverage was never started in the swapped-in renderer, but V8
      // still retains invocation data for the functions that ran during load
      driver.sendAndGetDevToolsCommand.mockImplementation(async (cmd: string) => {
        if (cmd === 'Profiler.takePreciseCoverage') {
          throw new Error('Precise coverage has not been started');
        }
        if (cmd === 'Profiler.getBestEffortCoverage') {
          return { result: scripts };
        }
        throw new Error(`unexpected command ${cmd}`);
      });
      const collector = BrowserCoverageCollector.create({
        driver,
        browserType: Browsers.Chrome,
        log,
      })!;

      await collector.flush();

      const files = Fs.readdirSync(coverageDir);
      expect(files).toEqual(['coverage-browser-0000.json']);
      expect(JSON.parse(Fs.readFileSync(Path.join(coverageDir, files[0]), 'utf8'))).toEqual({
        result: scripts,
      });
      // and the target is re-armed for subsequent precise flushes
      expect(driver.sendDevToolsCommand).toHaveBeenCalledWith(
        'Profiler.startPreciseCoverage',
        expect.anything()
      );
    });
  });
});
