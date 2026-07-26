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
import * as zlib from 'zlib';

import type { CollectedCoverage } from './summarize';

/**
 * On-disk contract for the per-config coverage summary a CI job uploads as a
 * Buildkite artifact (`<config-slug>.<job-id>.json.gz`), produced by
 * `ci_collect_functions` and consumed by the daily merge step. Unlike the local
 * `record_coverage` flow there is NO baseline subtraction here — noise removal
 * happens statistically at merge time across all configs of a manifest stratum.
 *
 * Function keys (`<filePath>::<functionName>::<startOffset>`) are comparable
 * across configs/jobs because every job in the collection build runs the same
 * Kibana distribution at the same absolute path (`KIBANA_BUILD_LOCATION`).
 */
export interface CiCoverageSummary {
  meta: {
    /** Manifest-relative FTR config path, the cross-job join key. */
    configPath: string;
    /** Exit code of the FTR run the dumps came from (0 = tests passed). */
    exitCode: number;
    jobId: string;
    buildId: string;
    recordedAt: string;
  };
  /** moduleId → sorted executed function keys, from Node processes. */
  server: Record<string, string[]>;
  /** moduleId → sorted executed function keys, from browser (CDP) dumps. */
  browser: Record<string, string[]>;
}

/** Group a collected function map by owning module, with sorted key lists. */
function groupByModule(functions: Map<string, { moduleId: string }>): Record<string, string[]> {
  const byModule = new Map<string, string[]>();
  for (const [key, { moduleId }] of functions) {
    let keys = byModule.get(moduleId);
    if (!keys) {
      keys = [];
      byModule.set(moduleId, keys);
    }
    keys.push(key);
  }
  return Object.fromEntries(
    [...byModule.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([moduleId, keys]) => [moduleId, keys.sort()])
  );
}

export function buildCiSummary(
  collected: CollectedCoverage,
  meta: CiCoverageSummary['meta']
): CiCoverageSummary {
  return {
    meta,
    server: groupByModule(collected.functions),
    browser: groupByModule(collected.browserFunctions),
  };
}

export function writeCiSummary(summary: CiCoverageSummary, outFile: string): void {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, zlib.gzipSync(JSON.stringify(summary)));
}

/** Read a summary written by {@link writeCiSummary}; throws on malformed files. */
export function readCiSummary(file: string): CiCoverageSummary {
  const parsed = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  const { meta, server, browser } = parsed ?? {};
  if (
    typeof meta?.configPath !== 'string' ||
    typeof meta?.exitCode !== 'number' ||
    typeof meta?.recordedAt !== 'string' ||
    typeof server !== 'object' ||
    server === null ||
    typeof browser !== 'object' ||
    browser === null
  ) {
    throw new Error(`not a CiCoverageSummary: ${file}`);
  }
  return parsed as CiCoverageSummary;
}
