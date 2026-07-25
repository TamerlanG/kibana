/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import * as Fs from 'fs';
import * as Path from 'path';

import type { ToolingLog } from '@kbn/tooling-log';

import { Browsers } from './browsers';

/**
 * The subset of the chromium WebDriver CDP surface the collector needs.
 * Duck-typed (instead of `instanceof ChromiumWebDriver`) so tests can pass a fake.
 */
export interface CdpDriver {
  sendDevToolsCommand(cmd: string, params?: object): Promise<unknown>;
  sendAndGetDevToolsCommand(cmd: string, params?: object): Promise<unknown>;
}

interface V8ScriptCoverage {
  url: string;
  functions?: unknown[];
}

/**
 * Records which browser-side functions execute during an FTR run via CDP
 * precise coverage (`Profiler.takePreciseCoverage` — the same V8 engine and
 * data shape as `NODE_V8_COVERAGE`). Dumps are written as
 * `coverage-browser-<seq>.json` files with the `{ result: [...] }` layout so
 * the ftr-runtime-map summarizer can parse them alongside Node dumps.
 *
 * Enabled only when the `FTR_BROWSER_COVERAGE_DIR` env var is set and the
 * browser is Chrome. Collection must never fail or slow down a run in any
 * user-visible way: every CDP/filesystem error is caught and logged.
 *
 * Precise coverage is armed per renderer process, so it is silently lost on
 * cross-process navigations — callers flush() before and start() after every
 * navigation (see BrowserService) and flush once more before the session quits.
 */
export class BrowserCoverageCollector {
  private seq = 0;

  static create({
    driver,
    browserType,
    log,
  }: {
    driver: unknown;
    browserType: Browsers;
    log: ToolingLog;
  }): BrowserCoverageCollector | undefined {
    const coverageDir = process.env.FTR_BROWSER_COVERAGE_DIR;
    if (!coverageDir) {
      return undefined;
    }

    const cdpDriver = driver as Partial<CdpDriver>;
    if (
      browserType !== Browsers.Chrome ||
      typeof cdpDriver.sendDevToolsCommand !== 'function' ||
      typeof cdpDriver.sendAndGetDevToolsCommand !== 'function'
    ) {
      log.warning(
        `FTR_BROWSER_COVERAGE_DIR is set but browser coverage requires Chrome (got ${browserType}) — skipping collection`
      );
      return undefined;
    }

    Fs.mkdirSync(coverageDir, { recursive: true });
    log.info(`browser coverage collection enabled, writing to ${coverageDir}`);
    return new BrowserCoverageCollector(cdpDriver as CdpDriver, coverageDir, log);
  }

  private constructor(
    private readonly driver: CdpDriver,
    private readonly coverageDir: string,
    private readonly log: ToolingLog
  ) {}

  /**
   * Arm (or re-arm) precise coverage on the current page target. Safe to call
   * repeatedly: re-issuing `startPreciseCoverage` only resets counters.
   */
  async start(): Promise<void> {
    try {
      await this.driver.sendDevToolsCommand('Profiler.enable');
      await this.driver.sendDevToolsCommand('Profiler.startPreciseCoverage', {
        callCount: false,
        detailed: false,
      });
    } catch (error) {
      this.log.debug(`browser coverage: failed to start precise coverage: ${error}`);
    }
  }

  /**
   * Collect the coverage recorded since the last flush and append it as one
   * dump file. On failure (e.g. an un-armed target after a process swap) it
   * re-arms so subsequent flushes on this target work.
   */
  async flush(): Promise<void> {
    try {
      const response = (await this.driver.sendAndGetDevToolsCommand(
        'Profiler.takePreciseCoverage'
      )) as { result?: V8ScriptCoverage[] } | undefined;

      const scripts = response?.result ?? [];
      if (scripts.length === 0) {
        return;
      }

      const fileName = `coverage-browser-${String(this.seq++).padStart(4, '0')}.json`;
      Fs.writeFileSync(Path.join(this.coverageDir, fileName), JSON.stringify({ result: scripts }));
    } catch (error) {
      this.log.debug(`browser coverage: flush failed, re-arming: ${error}`);
      await this.start();
    }
  }
}
