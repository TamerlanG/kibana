/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { resolveCacheEnabled } from './resolve_cache_enabled';

describe('resolveCacheEnabled', () => {
  it('disables the cache for one-shot dist builds by default', () => {
    expect(resolveCacheEnabled({ argv: ['--dist'], dist: true, watch: false })).toBe(false);
  });

  it('keeps the cache for dev and watch builds by default', () => {
    expect(resolveCacheEnabled({ argv: [], dist: false, watch: false })).toBe(true);
    expect(resolveCacheEnabled({ argv: ['--watch'], dist: false, watch: true })).toBe(true);
    expect(resolveCacheEnabled({ argv: ['--dist', '--watch'], dist: true, watch: true })).toBe(
      true
    );
  });

  it('honours an explicit --cache / --no-cache regardless of mode', () => {
    expect(resolveCacheEnabled({ argv: ['--dist', '--cache'], dist: true, watch: false })).toBe(
      true
    );
    expect(resolveCacheEnabled({ argv: ['--no-cache'], dist: false, watch: true })).toBe(false);
  });
});
