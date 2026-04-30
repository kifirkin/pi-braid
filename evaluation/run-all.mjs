#!/usr/bin/env node
/**
 * pi-braid Benchmark Runner
 * 
 * Runs all benchmarks with SDK + stepfun model.
 * 
 * Usage:
 *   node evaluation/run-all.mjs              # Run all benchmarks
 *   node evaluation/run-all.mjs --bm1         # Run BM1 only
 *   node evaluation/run-all.mjs --bm2         # Run BM2 only
 *   node evaluation/run-all.mjs --br4         # Run BR4 only
 */
import { parseArgs } from 'util';
import { existsSync } from 'fs';

// Import benchmark runners
import { runTask as runBM1 } from './bm1-sdk.mjs';
import { runBR4 } from './br4-sdk.mjs';

const BENCHMARKS = {
  bm1: {
    name: 'BM1 Multi-Turn Debugging',
    file: './bm1-sdk.mjs',
  },
  bm2: {
    name: 'BM2 Code Quality',
    file: './bm2-sdk.mjs',
  },
  br4: {
    name: 'BR4 Latent Multi-Turn',
    file: './br4-sdk.mjs',
  },
};

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      all: { type: 'boolean', default: false },
      bm1: { type: 'boolean', default: false },
      bm2: { type: 'boolean', default: false },
      br4: { type: 'boolean', default: false },
      trials: { type: 'string', default: '3' },
      timeout: { type: 'string', default: '90' },
      output: { type: 'string' },
    },
  });

  // Determine which benchmarks to run
  const toRun = [];
  if (values.all || (!values.bm1 && !values.bm2 && !values.br4)) {
    // Default: run all
    toRun.push(...Object.keys(BENCHMARKS));
  } else {
    if (values.bm1) toRun.push('bm1');
    if (values.bm2) toRun.push('bm2');
    if (values.br4) toRun.push('br4');
  }

  console.log('=== pi-braid Benchmark Suite (SDK) ===\n');
  console.log(`Model: stepfun/step-3.5-flash`);
  console.log(`Benchmarks: ${toRun.join(', ')}`);
  console.log(`Trials: ${values.trials}, Timeout: ${values.timeout}s\n`);

  const allResults = {};

  for (const key of toRun) {
    const bm = BENCHMARKS[key];
    console.log(`\n${'='.repeat(60)}`);
    console.log(`${bm.name} (${bm.file})`);
    console.log('='.repeat(60));

    try {
      if (key === 'bm1') {
        const results = [];
        // BM1 tasks - run once per task
        const tasks = [
          {
            id: 'ts-read-fail',
            prompt: 'Read the file test/runtime/test-retry-command.mjs and identify any JavaScript syntax errors. If found, fix them.',
            workspace: '/Users/kifir/projects/agents/pi-braid',
            expected: 'Fix syntax errors in test-retry-command.mjs',
          },
        ];
        // TODO: Add all BM1 tasks
        allResults.bm1 = { status: 'TODO: add full BM1 tasks' };
      } else if (key === 'br4') {
        const task = 'Read /Users/kifir/projects/agents/pi-braid/package.json and tell me the project name, then list the src/ directory.';
        const summary = await runBR4(task, parseInt(values.trials), parseInt(values.timeout));
        allResults.br4 = summary;
      }
    } catch (err) {
      console.error(`Error running ${key}:`, err.message);
      allResults[key] = { error: err.message };
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('ALL BENCHMARKS COMPLETE');
  console.log('='.repeat(60));

  if (values.output) {
    const { writeFileSync } = await import('fs');
    writeFileSync(values.output, JSON.stringify(allResults, null, 2));
    console.log(`\nResults saved to ${values.output}`);
  }
}

if (typeof process.send !== 'function' && process.argv[1] && process.argv[1].includes('run-all.mjs')) {
  main().catch((err) => {
    console.error('Runner failed:', err);
    process.exit(1);
  });
}
