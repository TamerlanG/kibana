/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { test, tags, expect } from '../../../../src/playwright';

/**
 * Browser-coverage baseline: log in and load a Kibana page without exercising any
 * specific feature. On first load Kibana's browser core runs every enabled
 * plugin's public setup()/start() (nav links, uiActions, embeddable registries,
 * …), so this captures the registration coverage common to ALL UI tests. The
 * ftr-runtime-map recorder subtracts it from a real config's browser run to
 * isolate what that config actually exercises.
 */
test.describe('browser coverage baseline', { tag: tags.deploymentAgnostic }, () => {
  test('loads a Kibana page and idles', async ({ browserAuth, pageObjects }) => {
    await browserAuth.loginAsAdmin();
    // Navigate to home and WAIT for the app to actually render — `gotoApp`/`page.goto`
    // return on the `load` event, before the async plugin bundles finish executing.
    // pageObjects.home.goto() waits for the home app to be visible, by which point
    // core has started every plugin's public setup()/start() (the registration
    // coverage this baseline exists to capture).
    await pageObjects.home.goto();
    // Assert the app rendered, so the baseline only counts a genuine full page load.
    await expect(pageObjects.home.homeApp).toBeVisible();
  });
});
