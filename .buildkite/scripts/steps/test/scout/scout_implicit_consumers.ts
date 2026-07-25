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
 * The rules live in `#pipeline-utils/scout_implicit_registry_consumers` (shared
 * with the ftr-runtime-map harness that validates them); this module applies
 * them to an affected-modules set.
 */

import minimatch from 'minimatch';
import type { ToolingLog } from '@kbn/tooling-log';
import { IMPLICIT_REGISTRY_CONSUMERS } from '#pipeline-utils/scout_implicit_registry_consumers';

/**
 * Augment an affected-modules set with consumer @kbn/ IDs whose registries are
 * touched by `changedFiles`. Returns a new Set; never removes entries and
 * never disables selective testing.
 */
export function expandWithImplicitConsumers(
  affected: ReadonlySet<string>,
  changedFiles: readonly string[],
  log: ToolingLog
): Set<string> {
  const expanded = new Set(affected);

  for (const rule of IMPLICIT_REGISTRY_CONSUMERS) {
    const trigger = changedFiles.find((file) =>
      rule.patterns.some((pattern) => minimatch(file, pattern, { dot: true }))
    );
    if (!trigger) continue;

    const added = rule.consumers.filter((id) => !expanded.has(id));
    if (added.length === 0) continue;

    for (const id of added) expanded.add(id);
    log.info(
      `Implicit consumers added: ${added.join(', ')} (triggered by '${trigger}' — ${rule.reason})`
    );
  }

  return expanded;
}
