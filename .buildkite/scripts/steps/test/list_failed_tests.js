#!/usr/bin/env node
/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/**
 * List failed JUnit test cases found under target/junit/**\/*.xml that were
 * produced (mtime) at or after the given epoch-ms timestamp. Emits one stable
 * test identifier per line on stdout in the form `<classname> \u2016 <name>`.
 *
 * Usage:
 *   node .buildkite/scripts/steps/test/list_failed_tests.js <since-epoch-ms> [glob-root]
 *
 * `glob-root` defaults to `target/junit`.
 */

const Fs = require('fs');
const Path = require('path');
const xml2js = require('xml2js');

const SEP = ' \u2016 '; // double vertical line, unlikely to appear in test names

const sinceMs = Number(process.argv[2] || 0);
const root = process.argv[3] || 'target/junit';

if (!Number.isFinite(sinceMs)) {
  console.error(`Invalid since-epoch-ms argument: ${process.argv[2]}`);
  process.exit(2);
}

const xmlFiles = [];
const walk = (dir) => {
  let entries;
  try {
    entries = Fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const full = Path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile() && entry.name.endsWith('.xml')) {
      const stat = Fs.statSync(full);
      if (stat.mtimeMs >= sinceMs) {
        xmlFiles.push(full);
      }
    }
  }
};
walk(root);

const ids = new Set();

const collect = (testsuite) => {
  if (!testsuite || !Array.isArray(testsuite.testcase)) return;
  for (const tc of testsuite.testcase) {
    if (!tc.failure) continue;
    const name = (tc.$ && tc.$.name) || '';
    const classname = (tc.$ && tc.$.classname) || '';
    if (!name && !classname) continue;
    ids.add(`${classname}${SEP}${name}`);
  }
};

(async () => {
  for (const file of xmlFiles) {
    let report;
    try {
      report = await xml2js.parseStringPromise(Fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`Failed to parse ${file}: ${err.message}`);
      continue;
    }
    if (report && report.testsuites && Array.isArray(report.testsuites.testsuite)) {
      for (const suite of report.testsuites.testsuite) collect(suite);
    } else if (report && report.testsuite) {
      collect(report.testsuite);
    }
  }

  const sorted = [...ids].sort();
  if (sorted.length) process.stdout.write(sorted.join('\n') + '\n');
})().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
