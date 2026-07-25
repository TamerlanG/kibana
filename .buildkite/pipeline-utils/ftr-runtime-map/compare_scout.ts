/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/**
 * Repo-derived glue around the pure `compareScoutSelection`: gathers a config's
 * static upstream closure and implicit-consumer overlay from the working tree,
 * runs the comparison, and prints it. Shared by `record_coverage` (Scout mode)
 * and the standalone `compare_scout_selection` CLI.
 */

import { execSync } from 'child_process';
import minimatch from 'minimatch';

import { findModuleForPath, getUpstreamClosure } from '../affected-packages';
import { getKibanaDir } from '../utils';
import { compareScoutSelection } from './compare_static';
import type { ComparisonReport } from './compare_static';

/**
 * Mirror of the overlay rules in
 * `.buildkite/scripts/steps/test/scout/scout_implicit_consumers.ts`. Duplicated
 * (not imported) because the `@kbn/imports` boundary forbids pipeline-utils from
 * importing CI test-step code; keep in sync with that file. The comparison uses
 * these to classify runtime-only packages that a hand-maintained rule already
 * covers ("overlay-rediscovered").
 */
const IMPLICIT_REGISTRY_CONSUMERS: ReadonlyArray<{
  patterns: readonly string[];
  consumers: readonly string[];
}> = [
  {
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

/** Packages owning ≥1 file matching an overlay rule whose consumers include `owningModule`. */
export function computeOverlayPublishers(owningModule: string): Set<string> {
  const rules = IMPLICIT_REGISTRY_CONSUMERS.filter((r) => r.consumers.includes(owningModule));
  if (rules.length === 0) {
    return new Set();
  }

  const files = execSync('git ls-files', {
    cwd: getKibanaDir(),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);

  const publishers = new Set<string>();
  for (const file of files) {
    if (!rules.some((rule) => rule.patterns.some((p) => minimatch(file, p, { dot: true })))) {
      continue;
    }
    const mod = findModuleForPath(file);
    if (mod && !mod.startsWith('[')) {
      publishers.add(mod);
    }
  }
  return publishers;
}

/** Compare a config's runtime coverage against its static selection set. */
export function runScoutComparison(input: {
  owningModule: string;
  runtimeServer: Set<string>;
  runtimeBrowser: Set<string>;
}): ComparisonReport {
  return compareScoutSelection({
    owningModule: input.owningModule,
    runtimeServer: input.runtimeServer,
    runtimeBrowser: input.runtimeBrowser,
    staticClosure: getUpstreamClosure(input.owningModule),
    overlayPublishers: computeOverlayPublishers(input.owningModule),
  });
}

export function printScoutComparison(report: ComparisonReport): void {
  const m = report.metrics;
  console.log(`\nowning module: ${report.owningModule}`);
  console.log(
    `runtime: ${report.runtime.combined.length} pkgs ` +
      `(server ${report.runtime.server.length}, browser ${report.runtime.browser.length})`
  );
  console.log(`static closure: ${report.staticClosure.length} pkgs`);
  console.log('');
  console.log(`agree:                 ${m.agree}`);
  console.log(`under-selected:        ${m.underSelected}  (runtime-only, static would SKIP)`);
  console.log(
    `overlay-rediscovered:  ${m.overlayRediscovered}  (runtime confirms a hand-written rule)`
  );
  console.log(`over-selected:         ${m.overSelected}  (static-only, wasted CI upper bound)`);
  console.log('');
  console.log(`graph recall:      ${(m.graphRecall * 100).toFixed(1)}%`);
  console.log(`effective recall:  ${(m.effectiveRecall * 100).toFixed(1)}%  (closure ∪ overlay)`);
  console.log(`static precision:  ${(m.staticPrecision * 100).toFixed(1)}%`);

  if (report.overlayRediscoveredPackages.length) {
    console.log('\noverlay rules confirmed by runtime:');
    for (const p of report.overlayRediscoveredPackages) console.log(`  ✓ ${p}`);
  }
  if (report.underSelectedPackages.length) {
    console.log('\nUNDER-SELECTED (runtime executed, static would skip — candidate new rules):');
    for (const p of report.underSelectedPackages) console.log(`  ⚠ ${p}`);
  }
}
