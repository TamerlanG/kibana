/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { Compiler, Chunk } from '@rspack/core';
import { rspack } from '../rspack_runtime';
import { CHUNK_MANIFEST_FILENAME } from '../paths';

/**
 * Emits `chunk-manifest.json` with a single field:
 *
 * - `allChunks`: every chunk reachable from the `kibana` entrypoint's direct
 *   children, i.e. all plugin entry chunks (`plugin-<id>`) plus the eager
 *   shared chunks they depend on. Used by `bootstrap_renderer.ts` to populate
 *   the bootstrap `load()` array, enabling eager parallel download via
 *   `<script async=false>` before `kibana.bundle.js`. Rspack's JSONP mechanism
 *   queues module factories so that dynamic imports resolve without network
 *   requests once the runtime drains the queue.
 *
 *   Chunks only reachable from nested `import()` blocks (lazy app chunks and
 *   the `lazy-*` shared tier from split_chunks.ts) are deliberately excluded
 *   and fetched on demand.
 *
 * If CI or FTR shows ChunkLoadError / 404 on /bundles/chunks/, compare emitted assets to
 * chunk-manifest.json and validate script order vs Rspack chunk graph (alphabetical sort here
 * is for stability; change only with failing-log evidence).
 */
export class ChunkPreloadManifestPlugin {
  apply(compiler: Compiler) {
    compiler.hooks.compilation.tap('ChunkPreloadManifestPlugin', (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: 'ChunkPreloadManifestPlugin',
          stage: rspack.Compilation.PROCESS_ASSETS_STAGE_REPORT,
        },
        () => {
          const allChunkFiles: string[] = [];
          const seen = new Set<Chunk>();

          const entrypoint = compilation.entrypoints.get('kibana');
          if (entrypoint) {
            for (const childGroup of entrypoint.childrenIterable) {
              for (const chunk of childGroup.chunks) {
                if (seen.has(chunk)) continue;
                seen.add(chunk);
                for (const file of chunk.files) {
                  if (file.endsWith('.js')) {
                    allChunkFiles.push(file);
                  }
                }
              }
            }
          }

          allChunkFiles.sort();

          compilation.emitAsset(
            CHUNK_MANIFEST_FILENAME,
            new rspack.sources.RawSource(JSON.stringify({ allChunks: allChunkFiles }))
          );
        }
      );
    });
  }
}
