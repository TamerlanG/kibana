/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

// Shared bootstrap for the ftr-runtime-map CLIs. Plain JS so it can be required
// before ts-node is registered.

const path = require('path');

/** Register ts-node so the sibling `*.ts` modules can be required from a CLI. */
function registerTsNode() {
  require('ts-node').register({
    transpileOnly: true,
    compilerOptions: {
      module: 'commonjs',
    },
    project: path.join(__dirname, '../../tsconfig.json'),
  });
}

/**
 * Build a minimist `unknown` handler that rejects typo'd flags instead of
 * silently ignoring them (these runs cost ~20 min). Bound to the caller's help
 * text so the error stays specific.
 */
function rejectUnknownFlags(helpText) {
  return (arg) => {
    if (arg.startsWith('-')) {
      console.error(`Unknown flag: ${arg}\n`);
      console.log(helpText);
      process.exit(1);
    }
    return true;
  };
}

/** minimist turns repeated flags into arrays; keep the last occurrence. */
function lastValue(value) {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

module.exports = { registerTsNode, rejectUnknownFlags, lastValue };
