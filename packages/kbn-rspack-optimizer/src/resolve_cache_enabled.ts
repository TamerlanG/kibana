/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/**
 * Decide whether the persistent filesystem cache is enabled for a CLI build.
 *
 * An explicit `--cache` / `--no-cache` always wins. Otherwise the cache is on
 * for dev and watch builds, where it pays off across rebuilds, and off for
 * one-shot dist builds, which would only pay the cost of writing it
 * (~25-30% of wall time and ~1.7 GB on disk) without ever reading it back.
 */
export function resolveCacheEnabled({
  argv,
  dist,
  watch,
}: {
  argv: readonly string[];
  dist: boolean;
  watch: boolean;
}): boolean {
  if (argv.includes('--no-cache')) {
    return false;
  }
  if (argv.includes('--cache')) {
    return true;
  }
  return !dist || watch;
}
