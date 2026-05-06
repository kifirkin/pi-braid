#!/usr/bin/env node
/**
 * run‑benchmark — Unified pi‑braid benchmark runner.
 *
 * Clean, maintainable, human‑readable.
 * Builds dist/ first. Leaves no stale processes or temp dirs.
 *
 * Usage:
 *   node evaluation/run-benchmark.mjs --bm1              # Run BM1 debugging
 *   node evaluation/run-benchmark.mjs --bm2 --safe       # BM2 without bash
 *   node evaluation/run-benchmark.mjs --br1              # BR1 trap tasks
 *   node evaluation/run-benchmark.mjs --bm2 --output results/today.json
 *   node evaluation/run-benchmark.mjs --list             # List available benchmarks
 *   node evaluation/run-benchmark.mjs --verify           # Check build/temps are clean
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RESULTS = join(ROOT, 'evaluation', 'results');

// ── Registry ──────────────────────────────────────────────────────────────

const REGISTRY = {
  bm1: { name: 'BM1 Multi‑Turn Debugging',     file: './tasks/bm1-debug.mjs',  tasks: null },
  bm2: { name: 'BM2 Code Quality',              file: './tasks/bm2-code.mjs',  tasks: null },
  br1: { name: 'BR1 Trap Task Validation',      file: './tasks/br1-trap.mjs',  tasks: null },
};

async function loadTasks(key) {
  if (!REGISTRY[key]) throw new Error(`Unknown benchmark: ${key}`);
  const mod = await import(REGISTRY[key].file);
  REGISTRY[key].tasks = mod.TASKS;
  return mod.TASKS;
}

// ── Verify build ──────────────────────────────────────────────────────────

async function ensureBuild() {
  const { verifyBuild } = await import('./lib/evaluator.mjs');
  verifyBuild();
  console.log('[pipeline] Build OK');
}

// ── Run a single benchmark ────────────────────────────────────────────────

async function runBenchmark(benchKey, options) {
  const bench = REGISTRY[benchKey];
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${bench.name}`);
  console.log(`${'='.repeat(60)}\n`);

  // Dynamic import of shared evaluator
  const { createBenchSession, runTask, formatResultsTable } = await import('./lib/evaluator.mjs');
  const tasks = await loadTasks(benchKey);

  // Determine per‑task timeout
  const defaultTimeout = tasks.reduce((max, t) => Math.max(max, t.timeout || 60), 60);
  const timeout = options.timeout || defaultTimeout;

  // Create session
  const { session, cleanup } = await createBenchSession({
    safeMode: options.safe,
    compaction: false,
    sessionDir: `/tmp/pi-${benchKey}-${Date.now()}`,
  });

  // Run tasks — each task gets a FRESH session (clean state, no cross-contamination)
  const results = [];
  for (const task of tasks) {
    const taskTimeout = task.timeout || timeout;
    process.stdout.write(`  [${task.id}]... `);
    const { session: taskSession, cleanup: taskCleanup } = await createBenchSession({
      safeMode: options.safe,
      compaction: false,
      sessionDir: `/tmp/pi-${benchKey}-${task.id}-${Date.now()}`,
    });
    try {
      const result = await runTask(taskSession, { id: task.id, prompt: task.prompt, timeout: taskTimeout });
      const status = result.error ? `✗ ${result.error.slice(0, 30)}` : `✓ ${(result.duration / 1000).toFixed(1)}s`;
      console.log(status);
      results.push(result);
    } finally {
      taskCleanup();
    }
  }

  cleanup();

  // Score and print results
  let scores = null;
  if (benchKey === 'bm2') {
    const { scoreCodeQuality, runCodeTest, extractCode } = await import('./lib/scoring.mjs');
    const { TESTS } = await import('./tasks/bm2-tests.mjs');
    scores = await Promise.all(results.map(async (r) => {
      const task = tasks.find(t => t.id === r.taskId);
      if (!task || !task.filename) return 0;
      const taskDir = `/tmp/bm2-${r.taskId}-${Date.now()}`;
      mkdirSync(taskDir, { recursive: true });
      const rawText = r.text;
      if (!rawText) return 0;

      // Extract clean code from markdown blocks
      let code = extractCode(rawText, task.filename);

      // Try agent's file path if extractCode failed
      if (!code || code.length < 10) {
        // Match both "to" and "in" paths: "Write ... to /tmp/bm2-task1/debounce.js"
        const pathMatch = task.prompt.match(/\b(?:to|in)\s+([\/\w.-]+\/[\w.-]+\.js)/);
        const agentFile = pathMatch ? pathMatch[1] : null;
        if (agentFile && existsSync(agentFile)) {
          const agentCode = readFileSync(agentFile, 'utf8');
          if (agentCode.length > 20) {
            console.log(`  ${task.id}: read from ${agentFile}`);
            code = agentCode;
          }
        }
      }

      if (!code || code.length < 10) {
        console.log(`  ${task.id}: no code found (text=${rawText.length}b)`);
        return 0;
      }

      // Score quality on the clean code
      const quality = scoreCodeQuality(code, task.filename).total;

      // Run benchmark tests
      const testCode = TESTS[r.taskId];
      if (testCode) {
        const testFile = join(taskDir, task.filename.replace('.js', '.test.js'));
        writeFileSync(testFile, testCode);
        writeFileSync(join(taskDir, task.filename), code);
        const testResult = runCodeTest(testFile, taskDir);
        const totalTests = testResult.passed + testResult.failed;
        const testScore = totalTests > 0 ? Math.round((testResult.passed / totalTests) * 50) : 0;
        const qualityScore = totalTests > 0 ? Math.round(quality * 0.5) : quality;
        const taskScore = qualityScore + testScore;
        console.log(`  ${task.id}: quality=${quality}/100 + tests=${testResult.passed}/${totalTests} → ${taskScore}/100`);
        return taskScore;
      }

      return Math.round(quality);
    }));
  } else if (benchKey === 'br1') {
    const { scoreTrapTask } = await import('./lib/scoring.mjs');
    scores = results.map((r, i) => {
      const task = tasks[i];
      const s = scoreTrapTask(r.text, task.expectedRefusal);
      console.log(`  ${task.id}: ${s.score}/100 — ${s.reason}`);
      return s.score;
    });
  }

  console.log(`\n--- Results ---`);
  console.log(formatResultsTable(results));
  if (scores && scores.length > 0) {
    const avg = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
    console.log(`\n**Overall: ${avg}/100**`);
  }

  // Save to file if requested
  if (options.output) {
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, JSON.stringify({ benchmark: benchKey, results, safe: !!options.safe, timestamp: new Date().toISOString() }, null, 2));
    console.log(`\nSaved to ${options.output}`);
  }

  return results;
}

// ── CLI ───────────────────────────────────────────────────────────────────

async function main() {
  const { values } = parseArgs({
    options: {
      bm1: { type: 'boolean', default: false },
      bm2: { type: 'boolean', default: false },
      br1: { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      verify: { type: 'boolean', default: false },
      safe: { type: 'boolean', default: false },
      timeout: { type: 'string' },
      output: { type: 'string' },
    },
  });

  if (values.list) {
    console.log('\nAvailable benchmarks:');
    for (const [key, b] of Object.entries(REGISTRY)) {
      console.log(`  ${key.padEnd(4)} — ${b.name}`);
    }
    console.log('');
    return;
  }

  if (values.verify) {
    await ensureBuild();
    const { checkStaleDirs } = await import('./lib/evaluator.mjs');
    const issues = checkStaleDirs();
    if (issues.length === 0) {
      console.log('[pipeline] Clean room: OK');
    } else {
      console.log('[pipeline] Issues:');
      issues.forEach(i => console.log(`  ⚠ ${i}`));
    }
    return;
  }

  // Determine which benchmarks to run
  const toRun = [];
  if (values.bm1) toRun.push('bm1');
  if (values.bm2) toRun.push('bm2');
  if (values.br1) toRun.push('br1');
  if (toRun.length === 0) {
    console.log('Specify a benchmark: --bm1, --bm2, --br1, or --list');
    process.exit(1);
  }

  // Ensure built before running
  await ensureBuild();

  // Set model env
  process.env.PI_MODEL = process.env.PI_MODEL || 'step-3.5-flash';
  process.env.PI_PROVIDER = process.env.PI_PROVIDER || 'stepfun';

  const allResults = {};
  for (const key of toRun) {
    allResults[key] = await runBenchmark(key, {
      safe: values.safe,
      timeout: values.timeout ? parseInt(values.timeout) : undefined,
      output: values.output,
    });
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('  DONE');
  console.log(`${'='.repeat(60)}`);
  console.log(`  Benchmarks: ${toRun.join(', ')}`);
  console.log(`  Safe mode: ${values.safe ? 'ON (bash restricted)' : 'OFF'}`);
  console.log(`  Model: ${process.env.PI_MODEL}`);
}

main().catch(err => {
  console.error('[pipeline] Fatal:', err);
  process.exit(1);
});
