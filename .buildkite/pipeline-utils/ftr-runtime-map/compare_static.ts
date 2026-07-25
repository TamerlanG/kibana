/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/**
 * Compare a config's RUNTIME-observed package coverage against what Scout's
 * STATIC selective testing would select on.
 *
 * Static selection runs a config owned by module M whenever a changed package P
 * is in the downstream closure of the change — equivalently, when P is in the
 * UPSTREAM dependency closure of M (`getUpstreamClosure`). So the static-implied
 * coverage set S(C) = upstreamClosure(M). The runtime set R(C) = packages whose
 * code actually executed. Comparing the two per package quantifies:
 *   - under-selection (runtime-only): static would WRONGLY SKIP C when P changes,
 *     yet C executes P's code — a correctness risk. These are exactly what the
 *     hand-maintained scout_implicit_consumers overlay patches.
 *   - over-selection (static-only): static selects C but the run never touched P.
 *
 * This module is pure (no fs/git); the CLI gathers the repo-derived sets.
 */

// Import the leaf const modules (not the fs-touching barrels) to keep this pure.
import { UNCATEGORIZED_MODULE_ID } from '../affected-packages/const';
import { BROWSER_UNATTRIBUTED_MODULE_ID } from './const';

/** Packages that force a full run when changed (harness/test infra); never a real signal. */
export const HARNESS_PACKAGE_RE = /^@kbn\/(scout|test|dev-|ftr-|jest-)/;

/** Synthetic module ids that are never real packages and must be dropped from every set. */
export const RUNTIME_SENTINELS: ReadonlySet<string> = new Set([
  UNCATEGORIZED_MODULE_ID,
  BROWSER_UNATTRIBUTED_MODULE_ID,
]);

export type Classification =
  | 'agree'
  | 'runtime-only'
  | 'runtime-only-overlay'
  | 'harness'
  | 'static-only';

export interface MatrixRow {
  packageId: string;
  runtimeServer: boolean;
  runtimeBrowser: boolean;
  staticGraph: boolean;
  overlayCovered: boolean;
  classification: Classification;
}

export interface ComparisonMetrics {
  runtimeSize: number;
  staticClosureSize: number;
  agree: number;
  /** runtime-only, not overlay/harness — true static under-selection candidates. */
  underSelected: number;
  /** runtime-only but rediscovered by an implicit-consumer overlay rule. */
  overlayRediscovered: number;
  /** static-only — over-selection (upper bound on wasted CI). */
  overSelected: number;
  /** |R∩S| / |R| over the graph only. */
  graphRecall: number;
  /** |R∩S_effective| / |R| where S_effective = closure ∪ overlay (excl. harness). */
  effectiveRecall: number;
  /** |R∩S| / |S| — fraction of statically-selected packages actually exercised. */
  staticPrecision: number;
}

export interface ComparisonInput {
  owningModule: string;
  runtimeServer: ReadonlySet<string>;
  runtimeBrowser: ReadonlySet<string>;
  /** upstreamClosure(owningModule), including the module itself. */
  staticClosure: ReadonlySet<string>;
  /** packages that overlay rules would add when the config is owned by owningModule. */
  overlayPublishers: ReadonlySet<string>;
}

export interface ComparisonReport {
  owningModule: string;
  runtime: { server: string[]; browser: string[]; combined: string[] };
  staticClosure: string[];
  overlayPublishers: string[];
  matrix: MatrixRow[];
  metrics: ComparisonMetrics;
  /**
   * Browser coverage WAS recorded but none of it could be attributed to a module
   * (every browser script fell through to BROWSER_UNATTRIBUTED_MODULE_ID, which
   * `clean()` drops — e.g. an rspack unified build). The metrics then reflect
   * SERVER coverage only, so recall can read 100% while the browser side
   * contributed no usable mapping. Callers should surface this rather than treat
   * the run as fully attributed.
   */
  browserUnattributed: boolean;
  /** actionable list: runtime-only packages that are neither overlay- nor harness-covered. */
  underSelectedPackages: string[];
  /** overlay rules confirmed by runtime (runtime-only ∩ overlayPublishers). */
  overlayRediscoveredPackages: string[];
}

const clean = (set: ReadonlySet<string>): Set<string> =>
  new Set([...set].filter((id) => id && !RUNTIME_SENTINELS.has(id)));

export function compareScoutSelection(input: ComparisonInput): ComparisonReport {
  const server = clean(input.runtimeServer);
  const browser = clean(input.runtimeBrowser);
  // Browser scripts were recorded but every one degraded to the unattributed
  // sentinel (dropped by clean()), so the browser side maps to nothing usable.
  const browserUnattributed =
    input.runtimeBrowser.has(BROWSER_UNATTRIBUTED_MODULE_ID) && browser.size === 0;
  const runtime = new Set([...server, ...browser]);
  const closure = clean(input.staticClosure);
  const overlay = clean(input.overlayPublishers);

  const universe = [...new Set([...runtime, ...closure])].sort();

  const matrix: MatrixRow[] = universe.map((packageId) => {
    const inRuntime = runtime.has(packageId);
    const inStatic = closure.has(packageId);
    const overlayCovered = overlay.has(packageId);
    const harness = HARNESS_PACKAGE_RE.test(packageId);

    let classification: Classification;
    if (inRuntime && inStatic) {
      classification = 'agree';
    } else if (inRuntime) {
      classification = harness
        ? 'harness'
        : overlayCovered
        ? 'runtime-only-overlay'
        : 'runtime-only';
    } else {
      classification = 'static-only';
    }

    return {
      packageId,
      runtimeServer: server.has(packageId),
      runtimeBrowser: browser.has(packageId),
      staticGraph: inStatic,
      overlayCovered,
      classification,
    };
  });

  const by = (c: Classification) => matrix.filter((r) => r.classification === c);
  const underSelectedPackages = by('runtime-only').map((r) => r.packageId);
  const overlayRediscoveredPackages = by('runtime-only-overlay').map((r) => r.packageId);
  const agree = by('agree').length;

  // effective static set = graph closure ∪ overlay, excluding harness noise from runtime
  const runtimeReal = new Set([...runtime].filter((id) => !HARNESS_PACKAGE_RE.test(id)));
  const effectiveHits = [...runtimeReal].filter((id) => closure.has(id) || overlay.has(id)).length;

  const metrics: ComparisonMetrics = {
    runtimeSize: runtime.size,
    staticClosureSize: closure.size,
    agree,
    underSelected: underSelectedPackages.length,
    overlayRediscovered: overlayRediscoveredPackages.length,
    overSelected: by('static-only').length,
    graphRecall: runtime.size ? agree / runtime.size : 1,
    effectiveRecall: runtimeReal.size ? effectiveHits / runtimeReal.size : 1,
    staticPrecision: closure.size ? agree / closure.size : 1,
  };

  return {
    owningModule: input.owningModule,
    runtime: {
      server: [...server].sort(),
      browser: [...browser].sort(),
      combined: [...runtime].sort(),
    },
    staticClosure: [...closure].sort(),
    overlayPublishers: [...overlay].sort(),
    matrix,
    metrics,
    browserUnattributed,
    underSelectedPackages,
    overlayRediscoveredPackages,
  };
}
