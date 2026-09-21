/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { ChunkPreloadManifestPlugin } from './chunk_preload_manifest_plugin';

interface MockChunk {
  files: Set<string>;
}

interface MockChunkGroup {
  chunks: MockChunk[];
}

const createMockChunk = (files: string[]): MockChunk => ({ files: new Set(files) });

const createMockCompiler = (opts: { chunks: MockChunk[]; entryChildren?: MockChunkGroup[] }) => {
  let processAssetsFn: () => void;
  const emittedAssets: Array<{ name: string; source: string }> = [];

  const compilation = {
    hooks: {
      processAssets: {
        tap: (_opts: any, fn: () => void) => {
          processAssetsFn = fn;
        },
      },
    },
    chunks: new Set(opts.chunks),
    entrypoints: opts.entryChildren
      ? new Map([['kibana', { childrenIterable: opts.entryChildren }]])
      : new Map(),
    emitAsset: (name: string, source: { source: () => string }) => {
      emittedAssets.push({ name, source: source.source() });
    },
  };

  const compiler = {
    hooks: {
      compilation: {
        tap: (_name: string, fn: (comp: typeof compilation) => void) => {
          fn(compilation);
        },
      },
    },
  };

  return {
    compiler,
    runProcessAssets: () => processAssetsFn(),
    getEmittedAssets: () => emittedAssets,
  };
};

const emitManifest = (opts: Parameters<typeof createMockCompiler>[0]) => {
  const { compiler, runProcessAssets, getEmittedAssets } = createMockCompiler(opts);
  new ChunkPreloadManifestPlugin().apply(compiler as any);
  runProcessAssets();
  return getEmittedAssets();
};

describe('ChunkPreloadManifestPlugin', () => {
  it('includes plugin entry chunks and the shared chunks in their groups', () => {
    const sharedChunk = createMockChunk(['chunks/shared-plugins.js']);
    const pluginA = createMockChunk(['chunks/plugin-a.js']);
    const pluginB = createMockChunk(['chunks/plugin-b.js']);

    const [{ source }] = emitManifest({
      chunks: [sharedChunk, pluginA, pluginB],
      entryChildren: [{ chunks: [pluginA, sharedChunk] }, { chunks: [pluginB, sharedChunk] }],
    });

    expect(JSON.parse(source).allChunks).toEqual([
      'chunks/plugin-a.js',
      'chunks/plugin-b.js',
      'chunks/shared-plugins.js',
    ]);
  });

  it('excludes chunks that are not reachable from the entrypoint children', () => {
    const pluginChunk = createMockChunk(['chunks/plugin-a.js']);
    const lazyShared = createMockChunk(['chunks/lazy-shared-plugins~a.js']);
    const lazyApp = createMockChunk(['chunks/123.js']);

    const [{ source }] = emitManifest({
      chunks: [pluginChunk, lazyShared, lazyApp],
      entryChildren: [{ chunks: [pluginChunk] }],
    });

    expect(JSON.parse(source).allChunks).toEqual(['chunks/plugin-a.js']);
  });

  it('only collects .js files (excludes .css, .map)', () => {
    const chunk = createMockChunk(['bundle.js', 'bundle.css', 'bundle.js.map']);

    const [{ source }] = emitManifest({ chunks: [chunk], entryChildren: [{ chunks: [chunk] }] });

    expect(JSON.parse(source).allChunks).toEqual(['bundle.js']);
  });

  it('emits an empty manifest when there is no kibana entrypoint', () => {
    const [emitted] = emitManifest({ chunks: [createMockChunk(['shared.js'])] });

    expect(emitted.name).toBe('chunk-manifest.json');
    expect(JSON.parse(emitted.source)).toEqual({ allChunks: [] });
  });
});
