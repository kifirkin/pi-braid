#!/usr/bin/env node
/**
 * run‑compare — Compare pi‑braid vs naked pi vs safe‑mode.
 *
 * Clean pipeline: builds dist/ first, runs each mode separately,
 * saves structured results.
 *
 * Usage:
 *   node evaluation/run-compare.mjs              # All benchmarks, all modes
 *   node evaluation/run-compare.mjs --bm1        # BM1 only
 *   node evaluation/run-compare.mjs --modes braid,naked
 *   node evaluation/run-compare.mjs --output results/compare.json
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RESULTS = join(ROOT, 'evaluation', 'results');
const TS = new Date().toISOString().replace(/[:.]/g, '-');

mkdirSync(RESULTS, { recursive: true });

// ── Build check ───────────────────────────────────────────────────────────

const distDir = join(ROOT, 'dist');
if (!existsSync(distDir)) {
  console.log('[pipeline] dist/ missing — building...');
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit', timeout: 120000 });
}
if (!existsSync(join(ROOT, 'dist', 'lib', 'tool-security.js'))) {
  throw new Error('Build incomplete — missing dist/lib/tool-security.js');
}
console.log('[pipeline] Build OK');

// ── Modes ─────────────────────────────────────────────────────────────────

const MODES = {
  braid: {
    label: 'pi‑braid (full)',
    env: {} // use default PI_CODING_AGENT_DIR
  },
  naked: {
    label: 'naked pi (no braid)',
    env: {} // created below
  },
  safe: {
    label: 'pi‑braid (safe, no bash)',
    env: { SAFE_MODE: 'true' }
  },
};

// ── Run helper ────────────────────────────────────────────────────────────

function runBenchmark(benchKey, mode, taskTimeout = 60) {
  const label = `${benchKey} [${mode}]`;
  const logFile = join(RESULTS, `${benchKey}_${mode}_${TS}.log`);
  const env = { ...process.env, PI_MODEL: 'step-3.5-flash', PI_PROVIDER: 'stepfun', ...MODES[mode].env };

  process.stdout.write(`  ${label.padEnd(25)} `);

  try {
    const stdout = execSync(
      `node evaluation/run-benchmark.mjs --${benchKey} --timeout ${taskTimeout}`,
      { cwd: ROOT, env, timeout: 15 * 60 * 1000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    writeFileSync(logFile, stdout);

    // Extract score from output (format from evaluator's formatResultsTable)
    // Each task line: | task-id | 12.3s | 5 | read,write... | ✓ |
    const tasks = stdout.split('\n').filter(l => l.startsWith('|') && !l.includes('---'));
    const completed = tasks.length - 2; // header + separator
    const errors = stdout.match(/✗/g)?.length || 0;

    process.stdout.write(`✓ ${completed} tasks, ${errors} errors\n`);
    return { bench: benchKey, mode, completed, errors, log: logFile };
  } catch (err) {
    const output = err.stdout || '';
    writeFileSync(logFile, output);
    process.stdout.write(`✗ ${err.message.slice(0, 50)}\n`);
    return { bench: benchKey, mode, completed: 0, errors: 1, log: logFile, error: err.message };
  }
}

// ── Naked pi setup ────────────────────────────────────────────────────────

async function setupNakedDir() {
  const dir = `/tmp/pi-naked-${TS}`;
  for (const sub of ['extensions','sessions','scratchpads','checkpoints','skills','memory','errors']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  const authSrc = join(homedir(), '.pi', 'agent', 'auth.json');
  if (existsSync(authSrc)) {
    const { cpSync } = await import('fs');
    cpSync(authSrc, join(dir, 'auth.json'));
  }
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    defaultProvider: 'stepfun', defaultModel: 'step-3.5-flash',
    thinking: 'high', compaction: { enabled: false },
    hideThinkingBlock: true, quietStartup: true,
    enableSkillCommands: false, retry: { enabled: false },
    disableConfirmations: true,
    extensions: ['/Users/kifir/projects/agents/pi-poorman-providers'],
    packages: [],
  }, null, 2));

  MODES.naked.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const { values } = parseArgs({
    options: {
      bm1: { type: 'boolean', default: false },
      bm2: { type: 'boolean', default: false },
      br1: { type: 'boolean', default: false },
      modes: { type: 'string', default: 'braid,naked,safe' },
      output: { type: 'string', default: join(RESULTS, `compare_${TS}.md`) },
    },
  });

  const benchKeys = [];
  if (values.bm1) benchKeys.push('bm1');
  if (values.bm2) benchKeys.push('bm2');
  if (values.br1) benchKeys.push('br1');
  if (benchKeys.length === 0) benchKeys.push('bm1', 'bm2', 'br1');

  const modeList = values.modes.split(',').filter(m => MODES[m]);

  console.log(`\n${'='.repeat(60)}`);
  console.log('  pi‑braid vs Naked pi — Comparison');
  console.log(`${'='.repeat(60)}\n`);
  console.log(`Benchmarks: ${benchKeys.join(', ')}`);
  console.log(`Modes: ${modeList.join(', ')}`);
  console.log(`Timestamp: ${TS}\n`);

  // Setup naked dir if needed
  if (modeList.includes('naked')) await setupNakedDir();

  // Run each benchmark in each mode
  const allResults = [];
  for (const key of benchKeys) {
    console.log(`\n--- ${key.toUpperCase()} ---`);
    for (const mode of modeList) {
      const timeout = key === 'bm1' ? 90 : 60;
      allResults.push(runBenchmark(key, mode, timeout));
    }
  }

  // Generate markdown report
  const md = [];
  md.push('# pi‑braid vs Naked pi — Comparison');
  md.push('');
  md.push(`**Generated**: ${new Date().toISOString()}`);
  md.push(`**Model**: stepfun/step-3.5-flash`);
  md.push('');
  md.push('| Benchmark | braid | naked | safe |');
  md.push('|-----------|-------|-------|------|');

  for (const key of benchKeys) {
    const braid = allResults.find(r => r.bench === key && r.mode === 'braid');
    const naked = allResults.find(r => r.bench === key && r.mode === 'naked');
    const safe = allResults.find(r => r.bench === key && r.mode === 'safe');
    const b = braid?.completed ?? '?';
    const n = naked?.completed ?? '—';
    const s = safe?.completed ?? '—';
    md.push(`| ${key} | ${b} tasks / ${braid?.errors || 0} err | ${n} tasks / ${naked?.errors || 0} err | ${s} tasks / ${safe?.errors || 0} err |`);
  }

  md.push('');
  md.push(`### ${TS}`);
  if (modeList.includes('naked')) {
    md.push(`- naked: \`/tmp/pi-naked-${TS}\` (no braid extensions)`);
  }
  if (modeList.includes('safe')) {
    md.push('- safe: `SAFE_MODE=true` (bash restricted)');
  }

  writeFileSync(values.output, md.join('\n'));
  console.log(`\nReport: ${values.output}`);
}

main().catch(err => {
  console.error('[pipeline] Fatal:', err);
  process.exit(1);
});
