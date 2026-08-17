/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor agreements. Licensed under the "Elastic License 2.0",
 * the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the Elastic License 2.0, the GNU Affero General Public
 * License v3.0 only", or the Server Side Public License, v 1".
 */

import { spaceTest, tags } from '@kbn/scout';
import { expect } from '@kbn/scout/ui';
import { DASHBOARD_DEFAULT_INDEX_TITLE, DASHBOARD_SAVED_SEARCH_ARCHIVE } from '../constants';

/**
 * Proves the "imported but not executed" hypothesis: the rspack unified entry
 * loads ALL ~220 plugin chunks via import() on every page load, but plugins
 * the page doesn't actually use have only their module wrapper executed (~1
 * function), while the owning plugin's chunk runs many.
 *
 * This is the root cause of the runtime-vs-static discrepancy: the static graph
 * (kbn_references) says these plugins are related to dashboard, and the unified
 * build ships their code to the browser, but runtime coverage proves most barely
 * execute — making them over-selection in the static graph.
 *
 * Uses Playwright's native page.coverage API (the same V8 profiler the Scout
 * browser-coverage fixture uses). Skipped under record_coverage
 * (SCOUT_BROWSER_COVERAGE_DIR set) to avoid double-arming the page, and when
 * the rspack chunk layout is absent (legacy webpack optimizer).
 */
spaceTest.describe(
  'plugin chunk execution: imported but not run',
  { tag: tags.deploymentAgnostic },
  () => {
    spaceTest.beforeAll(async ({ scoutSpace }) => {
      await scoutSpace.savedObjects.cleanStandardList();
      await scoutSpace.savedObjects.load(DASHBOARD_SAVED_SEARCH_ARCHIVE);
      await scoutSpace.uiSettings.setDefaultIndex(DASHBOARD_DEFAULT_INDEX_TITLE);
    });

    spaceTest.beforeEach(async ({ browserAuth }) => {
      await browserAuth.loginAsPrivilegedUser();
    });

    spaceTest.afterAll(async ({ scoutSpace }) => {
      await scoutSpace.uiSettings.unset('defaultIndex');
      await scoutSpace.savedObjects.cleanStandardList();
    });

    /** Count functions with at least one executed range (count > 0). */
    const executedFnCount = (entry: { functions: { ranges: { count: number }[] }[] }) =>
      entry.functions.filter((f) => f.ranges.some((r) => r.count > 0)).length;

    /** Extract the chunk name from a coverage entry URL (e.g. "plugin-dashboard" from ".../plugin-dashboard.abc123.js"). */
    const chunkName = (url: string) => {
      try {
        return new URL(url).pathname
          .split('/')
          .pop()
          ?.replace(/\.js$/, '')
          .replace(/\.[a-f0-9]+$/, '');
      } catch {
        return undefined;
      }
    };

    spaceTest(
      'screenshot-mode chunk is loaded but barely executed; dashboard chunk runs many functions',
      async ({ page, pageObjects }) => {
        // Skip under record_coverage — the auto browser-coverage fixture already
        // arms page.coverage, so a second startJSCoverage would collide.
        spaceTest.skip(
          !!process.env.SCOUT_BROWSER_COVERAGE_DIR,
          'not compatible with SCOUT_BROWSER_COVERAGE_DIR (auto fixture already arms coverage)'
        );

        await page.coverage.startJSCoverage({ resetOnNavigation: false });

        // Open a new dashboard editor — this actively exercises the dashboard
        // plugin (grid layout, panel rendering, add-panel flows).
        await pageObjects.dashboard.openNewDashboard();

        const coverage = await page.coverage.stopJSCoverage();

        // Diagnostic: list all plugin-* chunks and their executed function counts,
        // so we can see which chunks carry the dashboard plugin's actual code.
        const pluginChunks = coverage
          .map((e) => ({ name: chunkName(e.url), fns: executedFnCount(e), url: e.url }))
          .filter((e) => e.name?.startsWith('plugin-'))
          .sort((a, b) => b.fns - a.fns);
        // eslint-disable-next-line no-console
        console.log(
          'plugin chunk execution counts:\n' +
            pluginChunks.map((c) => `  ${c.fns}  ${c.name}`).join('\n')
        );

        // Find chunks by name. Under the legacy webpack optimizer (KBN_USE_RSPACK=false)
        // there are no bundles/chunks/plugin-*.js chunks, so skip gracefully.
        const dashboardChunk = coverage.find((e) => chunkName(e.url) === 'plugin-dashboard');
        const screenshotChunk = coverage.find((e) => chunkName(e.url) === 'plugin-screenshotMode');

        spaceTest.skip(
          !dashboardChunk || !screenshotChunk,
          'rspack unified chunk layout not present'
        );

        const dashboardFns = executedFnCount(dashboardChunk!);
        const screenshotFns = executedFnCount(screenshotChunk!);

        // Control: dashboard owns this page — many functions execute.
        expect(dashboardFns).toBeGreaterThan(10);
        // Hypothesis: screenshot-mode is imported and shipped but barely runs — just the module wrapper.
        expect(screenshotFns).toBeLessThanOrEqual(2);
      }
    );
  }
);
