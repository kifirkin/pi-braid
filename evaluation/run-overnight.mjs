#!/usr/bin/env node
/**
 * run‑overnight - Autonomous benchmark marathon.
 *
 * Runs the full sequence unattended:
 *   1. Compaction stress test
 *   2. All benchmarks (braid + naked + safe)
 *   3. Consolidation test
 *   4. Generate report
 *
 * Usage:
 *   node evaluation/run-overnight.mjs
 *   nohup node evaluation/run-overnight.mjs &    # background
 *
 * No stale processes. No temp file leaks.
 * dist/ is built automatically.
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RESULTS = join(ROOT, 'evaluation', 'results');
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const LOG = join(RESULTS, `overnight_${TS}.log`);

mkdirSync(RESULTS, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  try { writeFileSync(LOG, line + '\n', { flag: 'a' }); } catch {}
}

function run(label, cmd, opts = {}) {
  log(`${label}...`);
  const start = Date.now();
  try {
    const stdout = execSync(cmd, {
      cwd: ROOT,
      env: { ...process.env, ...opts.env },
      timeout: opts.timeout || 10 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
      stdio: opts.silent ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'inherit', 'pipe'],
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    log(`${label} OK (${elapsed}s)`);
    return stdout;
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    log(`${label} FAIL (${elapsed}s): ${err.message.slice(0, 60)}`);
    return err.stdout || '';
  }
}

async function main() {
  log('='.repeat(50));
  log('pi-braid Autonomous Overnight Runner');
  log(`Started: ${new Date().toISOString()}`);
  log('='.repeat(50));

  // 0. Build
  run('Build dist/', 'npm run build', { timeout: 120000 });

  // 1. Compaction stress test
  log('\n--- Phase 1: Compaction Stress Test ---');
  const stressLog = run('Stress test', 'node evaluation/stress-test.mjs', { timeout: 300000 });
  const stressPassed = !stressLog?.includes('ISSUES') && stressLog?.includes('ZERO issues');

  // 2. Benchmarks
  log('\n--- Phase 2: Benchmarks ---');
  run('BM1 braid',  'node evaluation/run-benchmark.mjs --bm1 --timeout 90', { timeout: 600000 });
  run('BM1 safe',   'node evaluation/run-benchmark.mjs --bm1 --timeout 90 --safe', { timeout: 600000 });
  run('BM2 braid',  'node evaluation/run-benchmark.mjs --bm2 --timeout 60', { timeout: 300000 });
  run('BM2 safe',   'node evaluation/run-benchmark.mjs --bm2 --timeout 60 --safe', { timeout: 300000 });
  run('BR1 braid',  'node evaluation/run-benchmark.mjs --br1 --timeout 60', { timeout: 300000 });
  run('BR1 safe',   'node evaluation/run-benchmark.mjs --br1 --timeout 60 --safe', { timeout: 300000 });

  // 3. Consolidation test
  log('\n--- Phase 3: Consolidation Test ---');
  run('Consolidation', 'node -e "
    import { createBenchSession, runTask } from \"./evaluation/lib/evaluator.mjs\";
    const { session, cleanup } = await createBenchSession({ safeMode: false, compaction: true });
    const r1 = await runTask(session, { id: \"debounce\", prompt: \"Write a debounce function to /tmp/consolidate/debounce.js\", timeout: 60 });
    const r2 = await runTask(session, { id: \"throttle\", prompt: \"Now write a throttle function to /tmp/consolidate/throttle.js\", timeout: 60 });
    console.log(\"Results:\", JSON.stringify({ r1: r1.error, r2: r2.error }));
    cleanup();
  "', { timeout: 180000 });

  // 4. Report
  log('\n--- Phase 4: Report ---');
  const report = [];
  report.push('# pi-braid Autonomous Overnight Report');
  report.push('');
  report.push(`**Generated**: ${new Date().toISOString()}`);
  report.push(`**Stress test**: ${stressPassed ? 'PASSED' : 'FAILED'}`);
  report.push('');
  report.push('See log for full results: `evaluation/results/`');
  report.push('');
  report.push(`Log: ${LOG}`);

  const reportFile = join(RESULTS, `overnight-report_${TS}.md`);
  writeFileSync(reportFile, report.join('\n'));

  log(`\nReport: ${reportFile}`);
  log('=== DONE ===');
}

main().catch(err => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
