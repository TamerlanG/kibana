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

import { coreWorkerFixtures } from '../../worker';
import type { ScoutPage } from '../scout_page';

let seq = 0;

/**
 * Records browser-side V8 code coverage for each UI test, so the
 * ftr-runtime-map tooling can map a Scout config to the browser-side plugins it
 * exercises. Enabled only when `SCOUT_BROWSER_COVERAGE_DIR` is set; otherwise
 * completely inert (no arming, no output, no slowdown).
 *
 * Uses Playwright's native `page.coverage` (Chromium-only, the same V8
 * `Profiler.takePreciseCoverage` surface). `resetOnNavigation: false` keeps
 * counters across in-test navigations, so — unlike the selenium FTR collector —
 * no per-navigation flush is needed. Dumps are written in the NODE_V8_COVERAGE
 * layout (`{ result: ScriptCoverage[] }`) as `coverage-browser-*.json` so
 * `summarize.ts` parses them unchanged. The heavy `source` field is stripped.
 *
 * Auto fixture: activates for every UI test without per-test opt-in. All
 * failures are swallowed — coverage collection must never fail a test.
 */
export const browserCoverageFixture = coreWorkerFixtures.extend<{
  _browserCoverage: void;
  page: ScoutPage;
}>({
  _browserCoverage: [
    async ({ page, log }, use) => {
      const coverageDir = process.env.SCOUT_BROWSER_COVERAGE_DIR;
      const coverage = coverageDir ? page.coverage : undefined;

      if (coverage) {
        try {
          await coverage.startJSCoverage({ resetOnNavigation: false });
        } catch (error) {
          log.debug(`browser coverage: failed to start: ${error}`);
        }
      }

      await use();

      if (coverage && coverageDir) {
        try {
          const entries = await coverage.stopJSCoverage();
          const result = entries.map(({ source, ...rest }) => rest);
          if (result.length > 0) {
            Fs.mkdirSync(coverageDir, { recursive: true });
            // Filename prefix + `{ result }` envelope are the on-disk contract read
            // by `.buildkite/pipeline-utils/ftr-runtime-map/const.ts` — keep in sync.
            const fileName = `coverage-browser-${process.pid}-${String(seq++).padStart(
              4,
              '0'
            )}.json`;
            Fs.writeFileSync(Path.join(coverageDir, fileName), JSON.stringify({ result }));
          }
        } catch (error) {
          log.debug(`browser coverage: failed to collect: ${error}`);
        }
      }
    },
    { scope: 'test', auto: true },
  ],
});
