/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import path from 'path';
import type { FtrConfigProviderContext } from '@kbn/test';

/**
 * Browser-coverage baseline wrapper for FTR UI configs. Extends the config
 * named by the FTR_BASELINE_TARGET_CONFIG env var — booting the exact same
 * servers — but swaps its tests for a single "log in + load a Kibana page +
 * idle" spec. On first page load Kibana's browser core runs every enabled
 * plugin's public setup()/start(), so this captures the plugin-registration
 * coverage every UI test triggers regardless of what it exercises. The
 * ftr-runtime-map recorder subtracts it from the real run to isolate what the
 * config actually tests.
 *
 * Not part of any test suite; run only by
 * `.buildkite/pipeline-utils/ftr-runtime-map/record_coverage`.
 */
export default async function ({ readConfigFile }: FtrConfigProviderContext) {
  const targetPath = process.env.FTR_BASELINE_TARGET_CONFIG;
  if (!targetPath) {
    throw new Error(
      'FTR_BASELINE_TARGET_CONFIG must point at the FTR config to record a baseline for'
    );
  }

  const target = await readConfigFile(path.resolve(targetPath));

  const settings = {
    ...target.getAll(),
    testFiles: [require.resolve('./tests/baseline')],
  };
  // a custom testRunner would take precedence over testFiles — the baseline
  // must run its own spec through the default runner
  delete settings.testRunner;

  return settings;
}
