/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { Chunk, Module, OptimizationSplitChunksNameFunction } from '@rspack/core';
import {
  getSplitChunksCacheGroups,
  getSharedChunkNames,
  LAZY_SHARED_CHUNK_PREFIX,
} from './split_chunks';

const chunk = (name?: string) => ({ name } as unknown as Chunk);
const moduleAt = (resource: string) => ({ nameForCondition: () => resource } as unknown as Module);

const nameOf = (key: string, module: Module, chunks: Chunk[]) => {
  const group = getSplitChunksCacheGroups()[key] as { name: OptimizationSplitChunksNameFunction };
  return group.name(module, chunks, key);
};

describe('getSplitChunksCacheGroups', () => {
  it('returns an object with all expected cache group keys', () => {
    const groups = getSplitChunksCacheGroups();
    expect(Object.keys(groups)).toEqual(
      expect.arrayContaining([
        'defaultVendors',
        'sharedPlugins',
        'corePackages',
        'sharedPackages',
        'solutionPackages',
        'rootPackages',
        'vendorsHeavy',
        'vendors',
        'default',
      ])
    );
  });

  it('disables defaultVendors', () => {
    const groups = getSplitChunksCacheGroups();
    expect(groups.defaultVendors).toBe(false);
  });

  it('names chunks eagerly when any consumer is a plugin entry chunk', () => {
    const module = moduleAt('/repo/src/platform/plugins/shared/data/public/foo.ts');
    expect(nameOf('sharedPlugins', module, [chunk('plugin-a'), chunk(), chunk()])).toBe(
      'shared-plugins'
    );
    expect(nameOf('vendorsHeavy', module, [chunk('plugin-core')])).toBe('vendors-heavy');
  });

  it('names lazy-only shared chunks by tier and module origin', () => {
    const lazyChunks = [chunk(), chunk(), chunk()];
    expect(
      nameOf(
        'sharedPlugins',
        moduleAt('/repo/x-pack/solutions/security/plugins/security_solution/public/a.ts'),
        lazyChunks
      )
    ).toBe(`${LAZY_SHARED_CHUNK_PREFIX}shared-plugins~security_solution`);
    expect(
      nameOf('vendors', moduleAt('/repo/node_modules/@elastic/ecs/index.js'), lazyChunks)
    ).toBe(`${LAZY_SHARED_CHUNK_PREFIX}vendors~@elastic_ecs`);
    expect(
      nameOf(
        'sharedPackages',
        moduleAt('/repo/src/platform/packages/shared/kbn-utils/index.ts'),
        lazyChunks
      )
    ).toBe(`${LAZY_SHARED_CHUNK_PREFIX}shared-packages~kbn-utils`);
    expect(nameOf('default', moduleAt('/repo/target/generated/x.js'), lazyChunks)).toBe(
      `${LAZY_SHARED_CHUNK_PREFIX}shared-misc~misc`
    );
  });
});

describe('getSharedChunkNames', () => {
  it('returns the eager tier name for every cache group and no lazy tier names', () => {
    const names = getSharedChunkNames();
    expect([...names].sort()).toEqual([
      'shared-core',
      'shared-misc',
      'shared-packages',
      'shared-plugins',
      'shared-root-packages',
      'shared-solution-packages',
      'vendors',
      'vendors-heavy',
    ]);
    for (const name of names) {
      expect(name.startsWith(LAZY_SHARED_CHUNK_PREFIX)).toBe(false);
    }
  });

  it('does not include "false" entries (defaultVendors)', () => {
    const names = getSharedChunkNames();
    expect(names).not.toContain(false);
    expect(names).not.toContain('false');
  });

  it('does not include "kibana" (the entry chunk name)', () => {
    const names = getSharedChunkNames();
    expect(names).not.toContain('kibana');
  });

  it('returns the same set on repeated calls', () => {
    const a = getSharedChunkNames();
    const b = getSharedChunkNames();
    expect([...a].sort()).toEqual([...b].sort());
  });
});
