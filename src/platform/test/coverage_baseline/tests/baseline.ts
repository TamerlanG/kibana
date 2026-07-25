/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { FtrProviderContext } from '../../functional/ftr_provider_context';

/**
 * Browser-coverage baseline spec (see ./config.ts): log in, load the home app,
 * and wait for it to render — by which point the browser core has started
 * every enabled plugin's public setup()/start(). Mirrors the Scout equivalent
 * in `kbn-scout/test/scout/ui/baseline_tests`.
 */
export default function ({ getPageObjects }: FtrProviderContext) {
  const pageObjects = getPageObjects(['common', 'header']);

  describe('browser coverage baseline', function () {
    it('loads a Kibana page and idles', async () => {
      // navigateToApp handles login and waits for the app container to appear
      await pageObjects.common.navigateToApp('home');
      await pageObjects.header.waitUntilLoadingHasFinished();
    });
  });
}
