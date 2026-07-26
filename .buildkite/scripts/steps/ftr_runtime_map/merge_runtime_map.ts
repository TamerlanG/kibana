/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/**
 * Final step of the daily `kibana-ftr-runtime-map` pipeline: download every
 * per-config coverage summary the FTR jobs uploaded, subtract per-stratum boot
 * noise, and write the committed map for `commit_map.sh` to publish.
 *
 * The summaries are re-read once per pass instead of held in memory — the full
 * build's function keys are ~10^8 string instances, far beyond the heap, while
 * each pass only needs one summary at a time plus hashed frequency tables.
 *
 * Always exits 0 with a map on disk (possibly `partial`): a red FTR day must
 * still refresh what it can, and consumers always run configs the map lacks.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  readCiSummary,
  type CiCoverageSummary,
} from '../../../pipeline-utils/ftr-runtime-map/ci_summary';
import {
  assembleRuntimeMap,
  formatRuntimeMap,
  pickWinners,
  StratumNoiseCounter,
  survivingModules,
  toSummaryHead,
  type OkConfigResult,
  type RuntimeMap,
  type SummaryHead,
} from '../../../pipeline-utils/ftr-runtime-map/merge_lib';
import { loadFtrStrata } from '../../../pipeline-utils/ftr-runtime-map/strata';
import { getKibanaDir } from '../../../pipeline-utils/utils';

const SUMMARIES_DIR = 'target/ftr-runtime-map/summaries';
const MAP_PATH = '.buildkite/ftr-runtime-map/runtime_map.json';

function tryExec(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

function annotate(message: string, style: 'info' | 'warning'): void {
  if (!process.env.BUILDKITE_JOB_ID) return;
  tryExec(
    `buildkite-agent annotate --style ${style} --context ftr-runtime-map ${JSON.stringify(message)}`
  );
}

function readPreviousMap(mapAbsPath: string): RuntimeMap | undefined {
  try {
    return JSON.parse(fs.readFileSync(mapAbsPath, 'utf8')) as RuntimeMap;
  } catch (error) {
    console.warn(`No usable previous map at ${mapAbsPath}: ${error}`);
    return undefined;
  }
}

function forEachWinnerSummary(
  winners: Iterable<SummaryHead>,
  onSummary: (head: SummaryHead, summary: CiCoverageSummary) => void
): void {
  for (const head of winners) {
    try {
      onSummary(head, readCiSummary(head.file));
    } catch (error) {
      console.warn(`Skipping ${head.file} (readable in pass 1, failed now): ${error}`);
    }
  }
}

function main(): void {
  const kibanaDir = getKibanaDir();
  const summariesDir = path.join(kibanaDir, SUMMARIES_DIR);
  const mapAbsPath = path.join(kibanaDir, MAP_PATH);

  console.log('--- Downloading per-config coverage summaries');
  fs.mkdirSync(summariesDir, { recursive: true });
  const downloaded = tryExec(
    `.buildkite/scripts/common/download_artifact.sh --include-retried-jobs "${SUMMARIES_DIR}/*.json.gz" .`
  );
  if (!downloaded) {
    console.warn('No coverage summary artifacts found — map will carry/fail every config.');
  }

  console.log('--- Pass 1/3: reading summary metadata');
  const heads: SummaryHead[] = [];
  for (const file of fs.readdirSync(summariesDir).filter((f) => f.endsWith('.json.gz'))) {
    const filePath = path.join(summariesDir, file);
    try {
      heads.push(toSummaryHead(filePath, readCiSummary(filePath)));
    } catch (error) {
      console.warn(`Skipping unreadable summary ${file}: ${error}`);
    }
  }
  console.log(`${heads.length} readable summaries`);

  const enabledConfigs = loadFtrStrata();
  const winners = pickWinners(heads);
  const okWinners = new Map<string, SummaryHead>();
  const failedHeads = new Map<string, SummaryHead>();
  for (const [configPath, head] of winners) {
    if (!enabledConfigs.has(configPath)) {
      console.warn(`Dropping summary for config not in any manifest: ${configPath}`);
    } else if (head.meta.exitCode === 0) {
      okWinners.set(configPath, head);
    } else {
      failedHeads.set(configPath, head);
    }
  }
  console.log(
    `${winners.size} configs with summaries → ${okWinners.size} ok, ${failedHeads.size} failed, ` +
      `${enabledConfigs.size} enabled in manifests`
  );

  console.log('--- Pass 2/3: counting per-stratum function frequencies');
  const counter = new StratumNoiseCounter();
  forEachWinnerSummary(okWinners.values(), (head, summary) => {
    counter.addConfig(enabledConfigs.get(head.meta.configPath)!.stratum, summary);
  });
  const noiseByStratum = counter.computeNoiseKeys();
  for (const [stratum, noise] of noiseByStratum) {
    console.log(`${stratum}: ${noise.size} boot-noise function keys`);
  }

  console.log('--- Pass 3/3: subtracting noise per config');
  const okConfigs = new Map<string, OkConfigResult>();
  forEachWinnerSummary(okWinners.values(), (head, summary) => {
    const { stratum } = enabledConfigs.get(head.meta.configPath)!;
    okConfigs.set(head.meta.configPath, {
      head,
      survivors: survivingModules(summary, noiseByStratum.get(stratum) ?? new Set()),
    });
  });

  console.log('--- Assembling map');
  const map = assembleRuntimeMap({
    enabledConfigs,
    okConfigs,
    failedHeads,
    previousMap: readPreviousMap(mapAbsPath),
    branch: process.env.BUILDKITE_BRANCH || 'main',
    commit: process.env.BUILDKITE_COMMIT || 'unknown',
    generatedAt: new Date().toISOString(),
    collectionBuild: {
      pipelineSlug: process.env.BUILDKITE_PIPELINE_SLUG || 'local',
      buildNumber: Number(process.env.BUILDKITE_BUILD_NUMBER) || 0,
    },
  });

  fs.mkdirSync(path.dirname(mapAbsPath), { recursive: true });
  fs.writeFileSync(mapAbsPath, formatRuntimeMap(map));

  const { status, enabled, ok, carried, failed } = map.collection;
  const summaryLine =
    `FTR runtime map: ${status} — ${ok}/${enabled} collected, ` +
    `${carried} carried, ${failed} failed/missing, ` +
    `${map.packages.length} packages (${Math.round(fs.statSync(mapAbsPath).size / 1024)} KiB)`;
  console.log(summaryLine);
  annotate(summaryLine, status === 'complete' ? 'info' : 'warning');

  if (process.env.BUILDKITE_JOB_ID) {
    tryExec(`cd ${JSON.stringify(kibanaDir)} && buildkite-agent artifact upload ${MAP_PATH}`);
  }
}

main();
