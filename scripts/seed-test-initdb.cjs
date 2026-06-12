#!/usr/bin/env node
'use strict';

// Generates `test-infra/initdb/01-core-ddl.sql` and `02-dml.sql` for the
// isolated test stack (ctxa-test-*). The directory is gitignored because
// 02-dml.sql contains a freshly randomized BCrypt seed password on every
// run; committing it would publish that hash to the repository history.
//
// Run BEFORE the first `docker compose -p ctxa-test up -d` (or before any
// `down -v` followed by re-up). Subsequent re-ups against an existing volume
// do not re-execute the initdb scripts.

const path = require('path');
const fs = require('fs-extra');
const { generateInitDbScripts } = require('../src/core/injector');

async function main() {
  const target = path.resolve(__dirname, '..', 'test-infra');
  await fs.ensureDir(target);
  const { initdbDir, seedPassword } = await generateInitDbScripts(target);
  console.log(`initdb files generated: ${initdbDir}`);
  console.log(`seed password (record once, NOT committed): ${seedPassword}`);
}

main().catch(err => { console.error(err); process.exit(1); });
