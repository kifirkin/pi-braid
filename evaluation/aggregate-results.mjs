#!/usr/bin/env node
/**
 * Aggregate all benchmark results into a single summary report.
 * Run after all benchmarks complete.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const RESULTS_DIR = '/Users/kifir/projects/agents/pi-braid/evaluation/results';
const OUTPUT_FILE = join(RESULTS_DIR, 'sprint-summary.md');

function loadJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function loadLog(path) {
  try { return readFileSync(path, 'utf-8'); } catch { return null; }
}

const lines = [];
lines.push('# Overnight Sprint — Benchmark Results Summary');
lines.push('');
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push('');

// ── BM1 ──────────────────────────────────────────────────────────────────
lines.push('## BM1: Multi-Turn Debugging (stepfun/step-3.5-flash)');
const bm1Files = readdirSync(RESULTS_DIR).filter(f => f.startsWith('bm1-') && f.endsWith('.json'));
if (bm1Files.length > 0) {
  const bm1 = loadJSON(join(RESULTS_DIR, bm1Files[bm1Files.length - 1]));
  if (bm1) {
    const byTask = {};
    for (const r of bm1) {
      if (!byTask[r.taskId]) byTask[r.taskId] = [];
      byTask[r.taskId].push(r);
    }
    let total = 0, count = 0;
    lines.push('| Task | Score | Turns | Duration | Error |');
    lines.push('|------|-------|-------|----------|-------|');
    for (const [id, results] of Object.entries(byTask)) {
      const avg = results.reduce((s, r) => s + r.score, 0) / results.length;
      const turns = results.reduce((s, r) => s + r.turns, 0) / results.length;
      const dur = results.reduce((s, r) => s + r.durationSeconds, 0) / results.length;
      const err = results.find(r => r.error)?.error || '';
      total += results.reduce((s, r) => s + r.score, 0);
      count += results.length;
      lines.push(`| ${id} | ${avg.toFixed(0)}/100 | ${turns.toFixed(1)} | ${dur.toFixed(1)}s | ${err} |`);
    }
    lines.push(`\n**BM1 Overall: ${(total / count).toFixed(1)}/100**`);
  }
}
lines.push('');

// ── BM2 ──────────────────────────────────────────────────────────────────
lines.push('## BM2: Code Quality (stepfun/step-3.5-flash)');
const bm2Files = readdirSync(RESULTS_DIR).filter(f => f.startsWith('bm2-') && f.endsWith('.json'));
if (bm2Files.length > 0) {
  const bm2 = loadJSON(join(RESULTS_DIR, bm2Files[bm2Files.length - 1]));
  if (bm2) {
    let total = 0;
    lines.push('| Task | Score | Quality | Tests | Turns | Duration |');
    lines.push('|------|-------|---------|-------|-------|----------|');
    for (const r of bm2) {
      total += r.score;
      lines.push(`| ${r.taskId} | ${r.score}/100 | ${r.qualityScore || 0}/100 | ${r.testResults ? r.testResults.passed + ' passed' : 'N/A'} | ${r.turns} | ${r.durationSeconds.toFixed(1)}s |`);
    }
    lines.push(`\n**BM2 Overall: ${(total / bm2.length).toFixed(1)}/100**`);
  }
} else {
  lines.push('*No BM2 results yet (may still be running)*');
}
lines.push('');

// ── BR1 ──────────────────────────────────────────────────────────────────
lines.push('## BR1: Trap Tasks');
const br1Logs = readdirSync(RESULTS_DIR).filter(f => f.startsWith('br1-') && f.endsWith('.log'));
if (br1Logs.length > 0) {
  const log = loadLog(join(RESULTS_DIR, br1Logs[br1Logs.length - 1]));
  if (log) {
    // Extract scores from log
    const scores = [];
    for (const line of log.split('\n')) {
      const m = line.match(/score=(\d+)\/100/);
      if (m) scores.push(parseInt(m[1]));
    }
    if (scores.length > 0) {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      lines.push(`Traps: ${scores.length} | Scores: ${scores.join(', ')} | Avg: ${avg.toFixed(1)}/100`);
    } else {
      lines.push('(See log for details)');
    }
  }
} else {
  lines.push('*No BR1 results yet*');
}
lines.push('');

// ── BR4 ──────────────────────────────────────────────────────────────────
lines.push('## BR4: Latent Activator Multi-Turn');
const br4Files = readdirSync(RESULTS_DIR).filter(f => f.startsWith('br4-') && f.endsWith('.json'));
if (br4Files.length > 0) {
  const br4Log = loadLog(join(RESULTS_DIR, br4Files[br4Files.length - 1].replace('.json', '.log')));
  if (br4Log) {
    lines.push('```');
    lines.push(br4Log.slice(-1500));
    lines.push('```');
  }
} else {
  lines.push('*No BR4 results yet*');
}
lines.push('');

// ── PB4 ──────────────────────────────────────────────────────────────────
lines.push('## PB4: Compliance Behavior');
const pb4Files = readdirSync(RESULTS_DIR).filter(f => f.startsWith('pb4-') && f.endsWith('.json'));
if (pb4Files.length > 0) {
  const pb4 = loadJSON(join(RESULTS_DIR, pb4Files[pb4Files.length - 1]));
  if (pb4) {
    const patternTotals = {};
    let totalCompliance = 0;
    for (const r of pb4) {
      if (r.compliance) {
        for (const [k, v] of Object.entries(r.compliance)) {
          if (k !== 'total') patternTotals[k] = (patternTotals[k] || 0) + v;
        }
        totalCompliance += r.compliance.total || 0;
      }
    }
    lines.push(`Total compliance behaviors: ${totalCompliance}`);
    lines.push('');
    lines.push('| Pattern | Count |');
    lines.push('|---------|-------|');
    for (const [name, count] of Object.entries(patternTotals)) {
      lines.push(`| ${name} | ${count} |`);
    }
    lines.push(`\n**Avg compliance per task: ${(totalCompliance / pb4.length).toFixed(1)}**`);
  }
} else {
  lines.push('*No PB4 results yet*');
}
lines.push('');

// ── Overnight ────────────────────────────────────────────────────────────
lines.push('## Overnight Test Suite (openrouter/qwen/qwen3.5-flash)');
const overnightFiles = readdirSync(RESULTS_DIR).filter(f => f.startsWith('overnight_') && f.endsWith('.jsonl'));
if (overnightFiles.length > 0) {
  const latest = overnightFiles.sort()[overnightFiles.length - 1];
  const data = readFileSync(join(RESULTS_DIR, latest), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  const passed = data.filter(r => r.success).length;
  const avgDur = data.reduce((s, r) => s + r.duration, 0) / data.length;
  lines.push(`Iterations: ${data.length} | Passed: ${passed}/${data.length} (${(passed / data.length * 100).toFixed(0)}%)`);
  lines.push(`Avg duration: ${avgDur.toFixed(1)}s`);
  lines.push('');
  lines.push('| Task | Pass Rate | Avg Duration |');
  lines.push('|------|-----------|--------------|');
  const byTask = {};
  for (const r of data) {
    if (!byTask[r.task]) byTask[r.task] = [];
    byTask[r.task].push(r);
  }
  for (const [task, results] of Object.entries(byTask)) {
    const passRate = results.filter(r => r.success).length / results.length;
    const avgD = results.reduce((s, r) => s + r.duration, 0) / results.length;
    lines.push(`| ${task} | ${(passRate * 100).toFixed(0)}% | ${avgD.toFixed(1)}s |`);
  }
}
lines.push('');

// ── Summary ──────────────────────────────────────────────────────────────
lines.push('## Key Findings');
lines.push('');
lines.push('### What Helped');
lines.push('- BM1 harness now has realistic tasks with proper scoring');
lines.push('- BM2 code quality benchmark runs automated tests on generated code');
lines.push('- PB4 quantifies compliance behaviors across standardized tasks');
lines.push('- Overnight suite runs continuously, accumulating pass rate data');
lines.push('');
lines.push('### What Needs Improvement');
lines.push('- BM1: stepfun model needs more explicit file-writing instructions');
lines.push('- BM2: 90s timeout may be too short for complex code generation');
lines.push('- Overnight: analytics_query and enforcement_check tasks timeout (need shorter prompts)');
lines.push('');
lines.push('### Model Comparison');
lines.push('- stepfun/step-3.5-flash: fast, free, 256k context, struggles with multi-step file ops');
lines.push('- openrouter/qwen/qwen3.5-flash: used in overnight, reasonable pass rate');

writeFileSync(OUTPUT_FILE, lines.join('\n'));
console.log('Summary written to', OUTPUT_FILE);
