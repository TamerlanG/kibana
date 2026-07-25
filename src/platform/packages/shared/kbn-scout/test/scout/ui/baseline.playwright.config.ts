/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { createPlaywrightConfig } from '../../..';

/**
 * Browser-coverage baseline config. Runs a single "log in + load a Kibana page +
 * idle" spec so the ftr-runtime-map recorder can capture the plugin-registration
 * coverage that fires on any page load — the noise a real config's browser run
 * would otherwise be credited with. Not part of kbn-scout's own test suite; run
 * only by `record_coverage` as a Scout UI baseline.
 */
export default createPlaywrightConfig({
  testDir: './baseline_tests',
});
