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

// Task directories to reset between modes
const BM2_DIRS = ['/tmp/bm2-task1', '/tmp/bm2-task2', '/tmp/bm2-task3'];
const BM3_DIRS = ['/tmp/bm3-task1', '/tmp/bm3-task2', '/tmp/bm3-task3', '/tmp/bm3-task4', '/tmp/bm3-task5'];

function resetBm2Tasks() {
  for (const d of BM2_DIRS) {
    try { execSync(`rm -rf "${d}"`, { stdio: 'pipe' }); } catch {}
    mkdirSync(d, { recursive: true });
  }
  writeFileSync('/tmp/bm2-task1/debounce.js', `function debounce(fn, wait) { return function(...a) {}; }
module.exports = debounce;
`);
  writeFileSync('/tmp/bm2-task2/clone.js', `function deepClone(v) { return v; }
module.exports = { deepClone };
`);
  writeFileSync('/tmp/bm2-task3/emitter.js', `class EventEmitter { on() {} emit() {} off() {} once() {} }
module.exports = EventEmitter;
`);
}

function resetBm3Tasks() {
  // Task 1: refactor-spread (BUGGY: uses spread operators)
  mkdirSync('/tmp/bm3-task1', { recursive: true });
  writeFileSync('/tmp/bm3-task1/utils.js', `const merge = (...objs) => ({ ...objs[0], ...objs[1] });
const clone = (obj) => ({ ...obj });
const defaults = (target, ...sources) => ({ ...target, ...sources });
module.exports = { merge, clone, defaults };
`);
  writeFileSync('/tmp/bm3-task1/logger.js', `const log = (level, msg) => ({ level, msg, ...{ timestamp: Date.now() } });
const format = (entry) => ({ ...entry, formatted: true });
module.exports = { log, format };
`);

  // Task 2: consistent-types (buggy: mixed use)
  mkdirSync('/tmp/bm3-task2', { recursive: true });
  writeFileSync('/tmp/bm3-task2/api.ts', `interface User { id: number; email: string; createdAt: Date }
class MockRepo {
  findByEmail(email: string) { return null; }
}
class MockAuth {
  login(username: string, _password: string) { return \`token-\${username}\`; }
}
const auth = new MockAuth();
const token = auth.login('a@b.com', 'pass');
console.log('OK:', token);
`);

  // Task 3: race-condition (BUGGY: no locking)
  mkdirSync('/tmp/bm3-task3', { recursive: true });
  writeFileSync('/tmp/bm3-task3/cache.js', `class Cache {
  constructor() { this.store = new Map(); this.pending = new Map(); }
  getOrSet(key, factory) {
    if (this.store.has(key)) return Promise.resolve(this.store.get(key));
    if (this.pending.has(key)) return this.pending.get(key);
    const p = factory().then(v => { this.store.set(key, v); this.pending.delete(key); return v; });
    this.pending.set(key, p);
    return p;
  }
  clear() { this.store.clear(); }
}
module.exports = { Cache };
`);
  writeFileSync('/tmp/bm3-task3/cache.test.js', `const { Cache } = require('./cache.js');
const cache = new Cache();
let factoryCalls = 0;
function factory() {
  factoryCalls++;
  return new Promise(resolve => setTimeout(() => resolve(\`value-\${factoryCalls}\`), 10));
}
async function test() {
  const [a, b, c] = await Promise.all([cache.getOrSet('k', factory), cache.getOrSet('k', factory), cache.getOrSet('k', factory)]);
  console.log('Results:', a, b, c, 'factory calls:', factoryCalls);
  if (a === b && b === c && factoryCalls === 1) { console.log('Test passed'); }
  else { console.log('FAIL: factoryCalls=' + factoryCalls); process.exit(1); }
}
test().catch(e => { console.error(e.message); process.exit(1); });
`);

  // Task 4: memory-leak (BUGGY: off() does nothing)
  mkdirSync('/tmp/bm3-task4', { recursive: true });
  writeFileSync('/tmp/bm3-task4/event-bus.js', `class EventBus {
  constructor() { this.listeners = new Map(); }
  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
  }
  emit(event, ...args) { (this.listeners.get(event) || []).forEach(h => h(...args)); }
  off(event, handler) { /* BUG: does nothing */ }
}
module.exports = { EventBus };
`);
  writeFileSync('/tmp/bm3-task4/test-leak.js', `const { EventBus } = require('./event-bus.js');
const e = new EventBus();
let count = 0;
const handler = () => count++;
for (let i = 0; i < 100; i++) e.on('ping', handler);
e.off('ping', handler);
e.emit('ping');
console.log('Count after off():', count, '(should be 0)');
if (count === 0) console.log('Test passed'); else { console.log('FAIL'); process.exit(1); }
`);

  // Task 5: circular-deps (BUGGY: all top-level requires)
  mkdirSync('/tmp/bm3-task5', { recursive: true });
  writeFileSync('/tmp/bm3-task5/a.js', `const { b } = require('./b.js');
class A { getB() { return b; } }
module.exports = { A, value: 'a' };
`);
  writeFileSync('/tmp/bm3-task5/b.js', `const { c } = require('./c.js');
class B { getC() { return c; } }
module.exports = { B, value: 'b' };
`);
  writeFileSync('/tmp/bm3-task5/c.js', `const { a } = require('./a.js');
class C { getA() { return a; } }
module.exports = { C, value: 'c' };
`);
  writeFileSync('/tmp/bm3-task5/test-circular.js', `try {
  require('./a.js');
  console.log('OK: no crash');
} catch (e) { console.log('FAIL:', e.message); process.exit(1); }
`);
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

  // Reset task files fresh for this mode
  if (benchKey === 'bm2') resetBm2Tasks();
  else if (benchKey === 'bm3') resetBm3Tasks();

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