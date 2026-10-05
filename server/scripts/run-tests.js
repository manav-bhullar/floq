#!/usr/bin/env node
/**
 * Test runner for Floq server tests.
 *
 * Runs each *.test.js file in server/tests/ as a separate child process.
 * Reports pass (exit 0) or fail (non-zero exit) per file.
 *
 * Usage:
 *   node scripts/run-tests.js              # run all tests
 *   node scripts/run-tests.js --unit       # run only unit tests (no DB/Redis needed)
 *   node scripts/run-tests.js --filter=foo # run only files matching "foo"
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const TESTS_DIR = path.join(__dirname, '..', 'tests');

// Tests that can run without external services (Postgres, Redis, running server)
const UNIT_TESTS = [
  'route-optimizer.test.js',
  'payment-unit.test.js',
  'lifecycle-socket.test.js',
  'client-lifecycle.test.js',
  'socket-transport.test.js',
];

// Parse CLI flags
const args = process.argv.slice(2);
const unitOnly = args.includes('--unit');
const filterArg = args.find(a => a.startsWith('--filter='));
const filter = filterArg ? filterArg.split('=')[1] : null;

// Discover test files
let testFiles = fs.readdirSync(TESTS_DIR)
  .filter(f => f.endsWith('.test.js') && !f.startsWith('._'));

if (unitOnly) {
  testFiles = testFiles.filter(f => UNIT_TESTS.includes(f));
}
if (filter) {
  testFiles = testFiles.filter(f => f.includes(filter));
}

testFiles.sort();

console.log(`\n🧪 Floq Test Runner`);
console.log(`${'─'.repeat(50)}`);
console.log(`Found ${testFiles.length} test file(s)\n`);

let passed = 0;
let failed = 0;
const failures = [];

for (const file of testFiles) {
  const filePath = path.join(TESTS_DIR, file);
  const label = file.replace('.test.js', '');

  try {
    execFileSync(process.execPath, [filePath], {
      timeout: 30000,         // 30s per test file
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' },
    });
    passed++;
    console.log(`  ✅  ${label}`);
  } catch (err) {
    failed++;
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    const stdout = err.stdout ? err.stdout.toString().trim() : '';
    const detail = stderr || stdout || `${err.code || "test failure"} (exit code ${err.status})`;
    failures.push({ label, detail });
    console.log(`  ❌  ${label}`);
  }
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);

if (failures.length > 0) {
  console.log('Failures:\n');
  for (const { label, detail } of failures) {
    console.log(`  ${label}:`);
    // Show first 5 lines of error output
    const lines = detail.split('\n').slice(0, 5);
    for (const line of lines) {
      console.log(`    ${line}`);
    }
    console.log('');
  }
  process.exit(1);
}

process.exit(0);
