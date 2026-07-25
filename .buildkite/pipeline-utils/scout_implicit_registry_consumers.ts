/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/**
 * TEMPORARY overlay for Scout selective testing.
 *
 * The static @kbn/ dependency graph (kibana.jsonc + tsconfig kbn_references)
 * cannot model runtime registry coupling — e.g. ML registers actions into the
 * uiActions registry that Dashboard renders at run time, with no static import
 * edge between them. ML-only changes therefore do not mark Dashboard's Scout
 * tests as affected and registration races slip through.
 *
 * The overlay augments the affected-modules set with a small allowlist of
 * (patterns -> consumer @kbn/ IDs) entries when the corresponding publisher
 * files change. It is the single source of truth for both the CI step that
 * applies it (`scout_implicit_consumers.ts`) and the ftr-runtime-map harness
 * that measures whether runtime coverage confirms each rule (`compare_scout.ts`).
 */
export interface ImplicitConsumerRule {
  reason: string;
  patterns: readonly string[];
  consumers: readonly string[];
}

export const IMPLICIT_REGISTRY_CONSUMERS: readonly ImplicitConsumerRule[] = [
  {
    reason: 'Runtime registry coupling not captured by static @kbn/ references.',
    patterns: [
      '**/plugins/**/public/embeddables/**/*.{ts,tsx}',
      '**/plugins/**/public/embeddable/**/*.{ts,tsx}',
      '**/plugins/**/public/react_embeddable/**/*.{ts,tsx}',
      '**/plugins/**/public/apps/embeddables/**/*.{ts,tsx}',
      '**/plugins/**/public/ui_actions/**/*.{ts,tsx}',
      '**/plugins/**/public/trigger_actions/**/*.{ts,tsx}',
      '**/plugins/**/public/**/actions/register*.{ts,tsx}',
    ],
    consumers: [
      '@kbn/dashboard-plugin',
      '@kbn/embeddable-plugin',
      '@kbn/canvas-plugin',
      '@kbn/lens-plugin',
    ],
  },
];
