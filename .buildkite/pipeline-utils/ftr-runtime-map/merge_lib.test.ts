/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { CiCoverageSummary } from './ci_summary';
import {
  assembleRuntimeMap,
  formatRuntimeMap,
  hashFunctionKey,
  pickWinners,
  StratumNoiseCounter,
  survivingModules,
  toSummaryHead,
  type AssembleRuntimeMapInputs,
  type RuntimeMap,
} from './merge_lib';
import type { FtrConfigStratum } from './strata';

function summary(
  configPath: string,
  {
    exitCode = 0,
    recordedAt = '2026-07-26T02:30:00.000Z',
    server = {},
    browser = {},
  }: Partial<Omit<CiCoverageSummary, 'meta'>> & {
    exitCode?: number;
    recordedAt?: string;
  } = {}
): CiCoverageSummary {
  return {
    meta: { configPath, exitCode, jobId: 'job-1', buildId: 'build-1', recordedAt },
    server,
    browser,
  };
}

const STRATUM: FtrConfigStratum = { stratum: 'ftr_platform_stateful_configs', flavor: 'stateful' };

function baseInputs(overrides: Partial<AssembleRuntimeMapInputs>): AssembleRuntimeMapInputs {
  return {
    enabledConfigs: new Map(),
    okConfigs: new Map(),
    failedHeads: new Map(),
    previousMap: undefined,
    branch: 'main',
    commit: 'abc123',
    generatedAt: '2026-07-26T04:00:00.000Z',
    collectionBuild: { pipelineSlug: 'kibana-ftr-runtime-map', buildNumber: 7 },
    ...overrides,
  };
}

describe('hashFunctionKey', () => {
  it('is deterministic and distinguishes close keys', () => {
    const key = 'node_modules/@kbn/foo/index.js::doThing::120';
    expect(hashFunctionKey(key)).toBe(hashFunctionKey(key));
    expect(hashFunctionKey(key)).not.toBe(hashFunctionKey(`${key}1`));
    expect(Number.isSafeInteger(hashFunctionKey(key))).toBe(true);
  });
});

describe('pickWinners', () => {
  it('prefers exit-0 summaries over newer failed ones, then the newest', () => {
    const heads = [
      toSummaryHead('a.gz', summary('cfg', { exitCode: 0, recordedAt: '2026-07-26T01:00:00Z' })),
      toSummaryHead('b.gz', summary('cfg', { exitCode: 1, recordedAt: '2026-07-26T03:00:00Z' })),
      toSummaryHead('c.gz', summary('cfg', { exitCode: 0, recordedAt: '2026-07-26T02:00:00Z' })),
      toSummaryHead('d.gz', summary('other', { exitCode: 10 })),
    ];
    const winners = pickWinners(heads);
    expect(winners.get('cfg')?.file).toBe('c.gz');
    expect(winners.get('other')?.file).toBe('d.gz');
  });
});

describe('StratumNoiseCounter', () => {
  const key = (n: string) => `node_modules/@kbn/x/index.js::${n}::0`;

  it('classifies keys at or above the frequency threshold as noise, per stratum', () => {
    const counter = new StratumNoiseCounter();
    for (let i = 0; i < 10; i++) {
      counter.addConfig('a', {
        ...summary(`cfg-${i}`),
        server: {
          '@kbn/x': [
            key('everywhere'),
            ...(i > 0 ? [key('in-90-percent')] : []),
            ...(i < 8 ? [key('in-80-percent')] : []),
            ...(i === 0 ? [key('rare')] : []),
          ],
        },
      });
    }
    // A single-config stratum must not have its (trivially 100%-frequent) keys subtracted.
    counter.addConfig('tiny', { ...summary('tiny-cfg'), server: { '@kbn/x': [key('rare')] } });

    const noise = counter.computeNoiseKeys();
    expect(noise.get('a')).toEqual(
      new Set([hashFunctionKey(key('everywhere')), hashFunctionKey(key('in-90-percent'))])
    );
    expect(noise.get('tiny')).toEqual(new Set());
  });
});

describe('survivingModules', () => {
  it('keeps a module iff at least one function key survives, per realm', () => {
    const noise = new Set([
      hashFunctionKey('common::a::0'),
      hashFunctionKey('bundles/common::b::0'),
    ]);
    const result = survivingModules(
      {
        ...summary('cfg'),
        server: {
          '@kbn/boot-only': ['common::a::0'],
          '@kbn/exercised': ['common::a::0', 'rare::c::0'],
        },
        browser: { '@kbn/ui-boot-only': ['bundles/common::b::0'] },
      },
      noise
    );
    expect(result).toEqual({ server: ['@kbn/exercised'], browser: [] });
  });
});

describe('assembleRuntimeMap', () => {
  const enabledConfigs = new Map<string, FtrConfigStratum>([
    ['test/a/config.ts', STRATUM],
    ['test/b/config.ts', STRATUM],
    ['test/c/config.ts', { stratum: 'ftr_base_serverless_configs', flavor: 'serverless' }],
  ]);

  function okConfig(configPath: string, present: string[], survivors: string[]) {
    return {
      head: toSummaryHead(
        `${configPath}.gz`,
        summary(configPath, {
          server: Object.fromEntries(present.map((p) => [p, [`${p}::fn::0`]])),
        })
      ),
      survivors: { server: survivors, browser: [] },
    };
  }

  it('interns packages, computes per-flavor boot noise, and marks non-collected configs failed', () => {
    const map = assembleRuntimeMap(
      baseInputs({
        enabledConfigs,
        okConfigs: new Map([
          [
            'test/a/config.ts',
            okConfig('test/a/config.ts', ['@kbn/boot', '@kbn/dash'], ['@kbn/dash']),
          ],
          ['test/b/config.ts', okConfig('test/b/config.ts', ['@kbn/boot'], [])],
        ]),
      })
    );

    expect(map.packages).toEqual(['@kbn/boot', '@kbn/dash']);
    // @kbn/boot ran in both stateful configs but survived in neither → stateful boot noise.
    expect(map.bootNoisePackages).toEqual({
      stateful: [map.packages.indexOf('@kbn/boot')],
      serverless: [],
    });
    expect(map.configs['test/a/config.ts']).toMatchObject({
      status: 'ok',
      server: [map.packages.indexOf('@kbn/dash')],
      testFileDirs: ['test/a'],
    });
    expect(map.configs['test/b/config.ts']).toMatchObject({ status: 'ok', server: [] });
    expect(map.configs['test/c/config.ts']).toMatchObject({
      status: 'failed',
      server: [],
      collectedAt: '2026-07-26T04:00:00.000Z',
    });
    // 2/3 ok is below the 0.8 floor.
    expect(map.collection).toEqual({
      status: 'partial',
      enabled: 3,
      ok: 2,
      carried: 0,
      failed: 1,
    });
  });

  it('does not mark a package as boot noise while it survives anywhere in the flavor', () => {
    const map = assembleRuntimeMap(
      baseInputs({
        enabledConfigs,
        okConfigs: new Map([
          ['test/a/config.ts', okConfig('test/a/config.ts', ['@kbn/boot'], [])],
          ['test/b/config.ts', okConfig('test/b/config.ts', ['@kbn/boot'], ['@kbn/boot'])],
        ]),
      })
    );
    expect(map.bootNoisePackages.stateful).toEqual([]);
  });

  it('carries fresh entries from the previous map and re-interns their packages', () => {
    const previousMap: RuntimeMap = {
      mapVersion: 1,
      branch: 'main',
      commit: 'older',
      generatedAt: '2026-07-25T04:00:00.000Z',
      collectionBuild: { pipelineSlug: 'kibana-ftr-runtime-map', buildNumber: 6 },
      collection: { status: 'complete', enabled: 3, ok: 3, carried: 0, failed: 0 },
      packages: ['@kbn/serverless-thing', '@kbn/zzz'],
      bootNoisePackages: { stateful: [], serverless: [] },
      configs: {
        'test/c/config.ts': {
          status: 'ok',
          collectedAt: '2026-07-25T03:00:00.000Z',
          server: [0],
          browser: [1],
          testFileDirs: ['test/c'],
        },
      },
    };

    const map = assembleRuntimeMap(
      baseInputs({
        enabledConfigs,
        okConfigs: new Map([
          ['test/a/config.ts', okConfig('test/a/config.ts', ['@kbn/aaa'], ['@kbn/aaa'])],
          ['test/b/config.ts', okConfig('test/b/config.ts', ['@kbn/aaa'], ['@kbn/aaa'])],
        ]),
        previousMap,
      })
    );

    const carried = map.configs['test/c/config.ts'];
    expect(carried.status).toBe('carried');
    expect(carried.collectedAt).toBe('2026-07-25T03:00:00.000Z');
    expect(carried.server.map((i) => map.packages[i])).toEqual(['@kbn/serverless-thing']);
    expect(carried.browser.map((i) => map.packages[i])).toEqual(['@kbn/zzz']);
    expect(map.collection).toEqual({
      status: 'partial',
      enabled: 3,
      ok: 2,
      carried: 1,
      failed: 0,
    });
  });

  it.each([
    ['stale entries', { collectedAt: '2026-07-01T00:00:00.000Z' }, {}],
    ['other branches', {}, { branch: '8.19' }],
    ['unknown map versions', {}, { mapVersion: 99 }],
  ])('does not carry %s', (_name, entryOverrides, mapOverrides) => {
    const previousMap = {
      mapVersion: 1,
      branch: 'main',
      commit: 'older',
      generatedAt: '2026-07-25T04:00:00.000Z',
      collectionBuild: { pipelineSlug: 'kibana-ftr-runtime-map', buildNumber: 6 },
      collection: { status: 'complete', enabled: 1, ok: 1, carried: 0, failed: 0 },
      packages: ['@kbn/x'],
      bootNoisePackages: { stateful: [], serverless: [] },
      configs: {
        'test/c/config.ts': {
          status: 'ok',
          collectedAt: '2026-07-25T03:00:00.000Z',
          server: [0],
          browser: [],
          testFileDirs: ['test/c'],
          ...entryOverrides,
        },
      },
      ...mapOverrides,
    } as RuntimeMap;

    const map = assembleRuntimeMap(baseInputs({ enabledConfigs, previousMap }));
    expect(map.configs['test/c/config.ts'].status).toBe('failed');
  });

  it('uses the failed summary timestamp for failed entries when available', () => {
    const failedHead = toSummaryHead(
      'c.gz',
      summary('test/c/config.ts', { exitCode: 10, recordedAt: '2026-07-26T02:10:00.000Z' })
    );
    const map = assembleRuntimeMap(
      baseInputs({
        enabledConfigs,
        failedHeads: new Map([['test/c/config.ts', failedHead]]),
      })
    );
    expect(map.configs['test/c/config.ts']).toMatchObject({
      status: 'failed',
      collectedAt: '2026-07-26T02:10:00.000Z',
    });
  });
});

describe('formatRuntimeMap', () => {
  it('emits valid JSON that round-trips, one line per config entry', () => {
    const map = assembleRuntimeMap(
      baseInputs({
        enabledConfigs: new Map([
          ['test/a/config.ts', STRATUM],
          ['test/b/config.ts', STRATUM],
        ]),
        okConfigs: new Map([
          [
            'test/a/config.ts',
            {
              head: toSummaryHead('a.gz', summary('test/a/config.ts')),
              survivors: { server: ['@kbn/dash'], browser: ['@kbn/dash'] },
            },
          ],
        ]),
      })
    );

    const text = formatRuntimeMap(map);
    expect(JSON.parse(text)).toEqual(map);
    const configLines = text
      .split('\n')
      .filter((line) => line.includes('"test/a/config.ts"') || line.includes('"test/b/config.ts"'));
    expect(configLines).toHaveLength(2);
  });
});
