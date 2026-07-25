/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/**
 * On-disk contract for the V8 coverage dumps this tool reads. Node writes one
 * `coverage-<pid>-<ts>-<n>.json` per process (NODE_V8_COVERAGE); the browser
 * collectors write `coverage-browser-<seq>.json` in the same `{ result: [...] }`
 * layout. `summarize.ts` discovers dumps by `PREFIX` + `SUFFIX`; `record_coverage`
 * detects UI runs by the narrower `BROWSER_PREFIX`.
 *
 * The producers live in other packages (`kbn-ftr-common-functional-ui-services`,
 * `kbn-scout`) that cannot import from `.buildkite`, so they carry a pointer
 * comment back to this file instead of sharing the constant — keep them in sync.
 */
export const COVERAGE_DUMP_PREFIX = 'coverage-';
export const COVERAGE_DUMP_SUFFIX = '.json';
export const BROWSER_COVERAGE_DUMP_PREFIX = 'coverage-browser-';

/** Browser scripts under `/bundles/` that cannot be attributed to a module. */
export const BROWSER_UNATTRIBUTED_MODULE_ID = '[browser-unattributed]';
