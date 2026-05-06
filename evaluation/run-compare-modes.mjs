#!/usr/bin/env node
/**
 * run-compare-modes — Compare 2 modes: naked vs braid
 *
 * Modes:
 *   naked — plain pi with only stepfun provider (no pi-braid extensions)
 *   braid  — full pi-braid (all extensions)
 *
 * Usage:
 *   node run-compare-modes.mjs --bm2        # BM2 code quality
 *   node run-compare-modes.mjs --bm2 --bm1  # BM1 + BM2
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RESULTS = join(ROOT, 'evaluation', 'results');

// Task directories to clear between modes
const TASK_DIRS = ['/tmp/bm2-task1', '/tmp/bm2-task2', '/tmp/bm2-task3'];

function clearTaskDirs() {
  for (const d of TASK_DIRS) {
    try { execSync(`rm -rf "${d}"`, { stdio: 'pipe' }); } catch {}
    mkdirSync(d, { recursive: true });
  }
}

function setupNakedDir(ts) {
  const dir = `/tmp/pi-naked-${ts}`;
  mkdirSync(dir, { recursive: true });
  for (const sub of ['sessions', 'scratchpads', 'checkpoints', 'memory', 'errors', 'extensions', 'skills']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  const authSrc = join(process.env.HOME || '', '.pi/agent/auth.json');
  const authDst = join(dir, 'auth.json');
  if (existsSync(authSrc)) {
    try { writeFileSync(authDst, readFileSync(authSrc)); } catch {}
  }
  // Minimal settings: only poorman provider, no pi-braid
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    defaultProvider: process.env.PI_PROVIDER || 'stepfun',
    defaultModel: process.env.PI_MODEL || 'step-3.5-flash',
    compaction: { enabled: false },
    hideThinkingBlock: true,
    quietStartup: true,
    extensions: ['/Users/kifir/projects/agents/pi-poorman-providers'],
  }, null, 2));
  return dir;
}

// Mode configs
const MODES = [
  {
    key: 'naked',
    name: 'naked',
    env: (ts) => ({
      PI_CODING_AGENT_DIR: setupNakedDir(ts),
      PI_MODEL: process.env.PI_MODEL || 'step-3.5-flash',
      PI_PROVIDER: process.env.PI_PROVIDER || 'stepfun',
    }),
  },
  {
    key: 'braid',
    name: 'braid',
    env: () => ({
      PI_MODEL: process.env.PI_MODEL || 'step-3.5-flash',
      PI_PROVIDER: process.env.PI_PROVIDER || 'stepfun',
    }),
  },
];

async function runMode(mode, benchKey, ts) {
  const env = mode.env(ts);
  const envPairs = Object.entries(env).map(([k, v]) => `${k}="${v}"`).join(' ');
  const fullCmd = `${envPairs} node ${ROOT}/evaluation/run-benchmark.mjs --${benchKey} 2>&1`;

  console.log(`  ▶ ${mode.name}...`);
  const start = Date.now();

  let output = '';
  try {
    output = execSync(fullCmd, { cwd: ROOT, maxBuffer: 10 * 1024 * 1024, timeout: 600000, encoding: 'utf-8' });
  } catch (e) {
    output = e.stdout?.toString() || e.stderr?.toString() || e.message;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(0);

  // Extract overall score
  const overallMatch = output.match(/\*\*Overall:\s*([0-9.]+)\/100\*\*/);
  const overall = overallMatch ? parseFloat(overallMatch[1]) : 0;

  // Extract per-task info
  const taskLines = [];
  for (const line of output.split('\n')) {
    if (line.match(/^\s*(\w[\w-]+):\s+quality=/)) taskLines.push(line.trim());
    if (line.match(/^\s*(\w[\w-]+):\s+\d+\/100/)) taskLines.push(line.trim());
  }

  console.log(`    ${mode.name}: ${overall.toFixed(1)}/100 (${elapsed}s)`);
  if (taskLines.length) {
    for (const l of taskLines) console.log(`      ${l}`);
  }

  return { key: mode.key, average: overall, elapsed: parseInt(elapsed), output };
}

async function main() {
  const args = process.argv.slice(2);
  const benches = args.filter(a => !a.startsWith('--'));
  const toRun = benches.length ? benches : ['bm2'];

  console.log('\n' + '='.repeat(60));
  console.log('  PI-BRAID — NAKED VS BRAID COMPARISON');
  console.log('='.repeat(60));
  console.log(`  Model: ${process.env.PI_MODEL || 'step-3.5-flash'} (${process.env.PI_PROVIDER || 'stepfun'})`);
  console.log(`  Benchmarks: ${toRun.join(', ')}`);
  console.log(`  Started: ${new Date().toISOString()}\n`);

  const ts = Date.now();
  const runDir = join(RESULTS, 'modes', `run_${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(runDir, { recursive: true });

  const summary = {};

  for (const benchKey of toRun) {
    console.log('─'.repeat(60));
    console.log(`  ${benchKey.toUpperCase()}`);
    console.log('─'.repeat(60) + '\n');

    const results = [];
    for (const mode of MODES) {
      clearTaskDirs();
      const r = await runMode(mode, benchKey, ts);
      results.push(r);
      summary[benchKey] = results;
    }

    // Sort and print
    const sorted = [...results].sort((a, b) => b.average - a.average);
    console.log(`  Results:`);
    for (const r of sorted) {
      const bar = '█'.repeat(Math.round(r.average / 5)) + '░'.repeat(20 - Math.round(r.average / 5));
      const winner = r === sorted[0] ? ' ◄' : '';
      console.log(`    ${r.key.padEnd(6)} ${bar} ${r.average.toFixed(1)}/100${winner} (${r.elapsed}s)`);
    }
    console.log('');
  }

  // Final table
  console.log('='.repeat(60));
  console.log('  FINAL SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Model: ${process.env.PI_MODEL || 'step-3.5-flash'}\n`);

  for (const [benchKey, results] of Object.entries(summary)) {
    console.log(`  ${benchKey.toUpperCase()}`);
    const sorted = [...results].sort((a, b) => b.average - a.average);
    for (const r of sorted) {
      const score = r.average.toFixed(1);
      const bar = '█'.repeat(Math.round(parseFloat(score) / 5)) + '░'.repeat(20 - Math.round(parseFloat(score) / 5));
      const winner = r === sorted[0] ? ' ◄' : '';
      console.log(`    ${r.key.padEnd(6)} ${bar} ${score}/100${winner} (${r.elapsed}s)`);
    }
    console.log('');
  }

  writeFileSync(join(runDir, 'summary.json'), JSON.stringify({
    timestamp: new Date().toISOString(),
    model: process.env.PI_MODEL || 'step-3.5-flash',
    provider: process.env.PI_PROVIDER || 'stepfun',
    summary: Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, v.map(r => ({ key: r.key, average: r.average, elapsed: r.elapsed }))])),
  }, null, 2));

  console.log(`  Results: ${runDir}`);
  console.log('  DONE\n');
}

main().catch(e => {
  console.error('\n[pipeline] Fatal:', e.message);
  process.exit(1);
});