#!/usr/bin/env node
/**
 * pi-braid vs Naked pi - node.js comparison runner v2
 *
 * Runs each SDK benchmark as a subprocess with PI_CODING_AGENT_DIR set
 * for the naked baseline. Each benchmark mode has its own overall timeout
 * so one stuck run doesn't block the entire comparison.
 */

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, cpSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const ROOT = '/Users/kifir/projects/agents/pi-braid';
const RESULTS_DIR = join(ROOT, 'evaluation/results');
const TS = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync(RESULTS_DIR, { recursive: true });

const NAKED_DIR = `/tmp/pi-naked-${TS}`;

// ── Create clean agent dir for naked pi ─────────────────────────────
console.log(`Setting up naked agent dir at ${NAKED_DIR}...`);
for (const sub of ['extensions','sessions','scratchpads','checkpoints','skills','memory','errors']) {
  mkdirSync(join(NAKED_DIR, sub), { recursive: true });
}
const authSrc = join(homedir(), '.pi', 'agent', 'auth.json');
if (existsSync(authSrc)) cpSync(authSrc, join(NAKED_DIR, 'auth.json'));

writeFileSync(join(NAKED_DIR, 'settings.json'), JSON.stringify({
  defaultProvider: 'stepfun',
  defaultModel: 'step-3.5-flash',
  thinking: 'high',
  compaction: { enabled: false },
  hideThinkingBlock: true,
  quietStartup: true,
  enableSkillCommands: false,
  retry: { enabled: false },
  disableConfirmations: true,
  extensions: ['/Users/kifir/projects/agents/pi-poorman-providers'],
  packages: [],
}, null, 2));

// ── Per-benchmark config ────────────────────────────────────────────
const BENCHES = [
  { name: 'bm1-sdk', file: 'bm1-sdk.mjs', taskTimeout: 90, overallMs: 12 * 60 * 1000 },
  { name: 'bm2-sdk', file: 'bm2-sdk.mjs', taskTimeout: 60, overallMs: 5 * 60 * 1000 },
  { name: 'br1-sdk', file: 'br1-sdk.mjs', taskTimeout: 60, overallMs: 8 * 60 * 1000 },
];

function runBenchmark(name, file, taskTimeout, mode, overallMs) {
  const log = join(RESULTS_DIR, `${name}_${mode}_${TS}.log`);
  const label = `${name} [${mode}]`;

  const env = { ...process.env, PI_MODEL: 'step-3.5-flash', PI_PROVIDER: 'stepfun' };
  if (mode === 'naked') env.PI_CODING_AGENT_DIR = NAKED_DIR;
  else delete env.PI_CODING_AGENT_DIR;
  // Enable safe mode for all benchmarks (restricts bash)
  env.SAFE_MODE = 'true';

  process.stdout.write(`  ${label} (task=${taskTimeout}s, wall=${(overallMs/1000).toFixed(0)}s) ... `);

  try {
    const stdout = execSync(`node evaluation/${file} --timeout ${taskTimeout}`, {
      cwd: ROOT,
      env,
      timeout: overallMs,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    writeFileSync(log, stdout);
    const m = stdout.match(/Overall:\s*([\d.]+)\/100/);
    const score = m ? parseFloat(m[1]) : null;
    process.stdout.write(`score=${score ?? 'N/A'}\n`);
    return score;
  } catch (err) {
    const output = err.stdout || '';
    writeFileSync(log, output);
    const m = output.match(/Overall:\s*([\d.]+)\/100/);
    const score = m ? parseFloat(m[1]) : null;
    process.stdout.write(`score=${score ?? 'ERR'} (${err.message.slice(0,50)})\n`);
    return score;
  }
}

// ── Run ─────────────────────────────────────────────────────────────
console.log('\n=== pi-braid vs Naked pi ===\n');
const results = {};

for (const { name, file, taskTimeout, overallMs } of BENCHES) {
  console.log(`--- ${name} ---`);
  const braid = runBenchmark(name, file, taskTimeout, 'braid', overallMs);
  const naked = runBenchmark(name, file, taskTimeout, 'naked', overallMs);
  results[name] = { braid, naked };
}

// ── Output ──────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(50));
console.log('COMPARISON RESULTS');
console.log('='.repeat(50));

const md = [];
md.push('# pi-braid vs Naked pi - Comparison Results');
md.push('');
md.push(`**Generated**: ${new Date().toISOString()}`);
md.push('**Model**: stepfun/step-3.5-flash');
md.push('');
md.push('| Benchmark | braid | naked | Delta |');
md.push('|-----------|-------|-------|-------|');

for (const [name, { braid, naked }] of Object.entries(results)) {
  const b = braid ?? '?';
  const n = naked ?? '?';
  let delta = '-';
  if (typeof b === 'number' && typeof n === 'number') {
    const d = b - n;
    delta = `${d > 0 ? '+' : ''}${d.toFixed(1)}`;
  }
  md.push(`| ${name} | ${b}/100 | ${n}/100 | ${delta} |`);
  console.log(`${name}: braid=${b}  naked=${n}  delta=${delta}`);
}

md.push('');
md.push('### Setup');
md.push('- braid: ~/.pi/agent (pi-braid + poorman-providers)');
md.push(`- naked: ${NAKED_DIR} (only stepfun provider)`);
md.push('');

const out = join(RESULTS_DIR, `comparison_${TS}.md`);
writeFileSync(out, md.join('\n'));
console.log(`\nResults saved to ${out}`);
