/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { compareScoutSelection } from './compare_static';

const set = (...ids: string[]) => new Set(ids);

describe('compareScoutSelection', () => {
  it('classifies each package into the right bucket', () => {
    const report = compareScoutSelection({
      owningModule: '@kbn/dashboard-plugin',
      // dashboard exercises: itself + data (both in closure = agree), ml (runtime
      // registry coupling, in overlay), lens (runtime-only, no overlay), scout (harness)
      runtimeServer: set('@kbn/dashboard-plugin', '@kbn/data-plugin', '@kbn/scout'),
      runtimeBrowser: set('@kbn/dashboard-plugin', '@kbn/ml-plugin', '@kbn/lens-plugin'),
      // static closure: dashboard depends on data + embeddable (embeddable never ran)
      staticClosure: set('@kbn/dashboard-plugin', '@kbn/data-plugin', '@kbn/embeddable-plugin'),
      overlayPublishers: set('@kbn/ml-plugin'),
    });

    const cls = Object.fromEntries(report.matrix.map((r) => [r.packageId, r.classification]));
    expect(cls['@kbn/dashboard-plugin']).toBe('agree');
    expect(cls['@kbn/data-plugin']).toBe('agree');
    expect(cls['@kbn/ml-plugin']).toBe('runtime-only-overlay');
    expect(cls['@kbn/lens-plugin']).toBe('runtime-only');
    expect(cls['@kbn/scout']).toBe('harness');
    expect(cls['@kbn/embeddable-plugin']).toBe('static-only');
  });

  it('reports the actionable under-selected and rediscovered lists', () => {
    const report = compareScoutSelection({
      owningModule: '@kbn/dashboard-plugin',
      runtimeServer: set('@kbn/dashboard-plugin'),
      runtimeBrowser: set('@kbn/ml-plugin', '@kbn/lens-plugin'),
      staticClosure: set('@kbn/dashboard-plugin'),
      overlayPublishers: set('@kbn/ml-plugin'),
    });

    expect(report.overlayRediscoveredPackages).toEqual(['@kbn/ml-plugin']);
    expect(report.underSelectedPackages).toEqual(['@kbn/lens-plugin']);
    expect(report.metrics.overlayRediscovered).toBe(1);
    expect(report.metrics.underSelected).toBe(1);
  });

  it('drops runtime sentinels from every set', () => {
    const report = compareScoutSelection({
      owningModule: '@kbn/dashboard-plugin',
      runtimeServer: set('@kbn/dashboard-plugin', '[uncategorized]'),
      runtimeBrowser: set('[browser-unattributed]'),
      staticClosure: set('@kbn/dashboard-plugin'),
      overlayPublishers: set(),
    });

    expect(report.matrix.map((r) => r.packageId)).toEqual(['@kbn/dashboard-plugin']);
    expect(report.runtime.combined).toEqual(['@kbn/dashboard-plugin']);
  });

  it('computes recall/precision, excluding harness from effective recall', () => {
    const report = compareScoutSelection({
      owningModule: '@kbn/a',
      // runtime real = a, b, c ; harness = scout (excluded from effective recall)
      runtimeServer: set('@kbn/a', '@kbn/b', '@kbn/c', '@kbn/scout'),
      runtimeBrowser: set(),
      // static closure = a, b, d ; overlay covers c
      staticClosure: set('@kbn/a', '@kbn/b', '@kbn/d'),
      overlayPublishers: set('@kbn/c'),
    });

    // agree = a,b (2); runtime = a,b,c,scout (4); closure = a,b,d (3)
    expect(report.metrics.agree).toBe(2);
    expect(report.metrics.graphRecall).toBeCloseTo(2 / 4); // agree / |runtime|
    // effective: runtimeReal = a,b,c (scout excluded); hits = a,b (closure) + c (overlay) = 3
    expect(report.metrics.effectiveRecall).toBeCloseTo(3 / 3);
    expect(report.metrics.staticPrecision).toBeCloseTo(2 / 3); // agree / |closure|
    expect(report.metrics.overSelected).toBe(1); // d
  });
});
