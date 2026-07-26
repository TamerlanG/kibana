/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import * as fs from 'fs';
import * as path from 'path';

import { parse as loadYaml } from 'yaml';

import { serverless, stateful } from '../../ftr-manifests/ftr_configs_manifests.json';
import { getKibanaDir } from '../utils';

export type FtrFlavor = 'stateful' | 'serverless';

export interface FtrConfigStratum {
  /** Manifest file basename without extension, e.g. `ftr_platform_stateful_configs`. */
  stratum: string;
  flavor: FtrFlavor;
}

/**
 * Map every enabled FTR config to its manifest stratum. The stratum is the
 * unit of statistical boot-noise subtraction at merge time: configs within one
 * manifest boot near-identical server flavors, so a function executed by ~all
 * of them is boot/ambient noise rather than test signal.
 *
 * Unlike `ci-stats/.../ftr_manifests.ts` (which flattens all manifests into
 * queue groups) this keeps the config → manifest association.
 */
export function loadFtrStrata(): Map<string, FtrConfigStratum> {
  const strata = new Map<string, FtrConfigStratum>();
  const kibanaDir = getKibanaDir();

  const flavors: Array<[FtrFlavor, string[]]> = [
    ['stateful', stateful],
    ['serverless', serverless],
  ];
  for (const [flavor, manifestRelPaths] of flavors) {
    for (const manifestRelPath of manifestRelPaths) {
      const stratum = path.basename(manifestRelPath, '.yml');
      const ymlData = loadYaml(fs.readFileSync(path.join(kibanaDir, manifestRelPath), 'utf8'));
      const enabled: Array<string | Record<string, unknown>> = ymlData?.enabled ?? [];
      for (const entry of enabled) {
        const configPath = typeof entry === 'string' ? entry : Object.keys(entry)[0];
        strata.set(configPath, { stratum, flavor });
      }
    }
  }
  return strata;
}
