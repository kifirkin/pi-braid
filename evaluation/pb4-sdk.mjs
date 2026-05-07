#!/usr/bin/env node
/**
 * PB4: Compliance Behavior Measurement — SDK version
 *
 * Measures whether pi-braid changes compliance behavior patterns.
 * Runs standardized tasks with and without pi-braid, counts compliance patterns.
 *
 * Compliance patterns detected:
 * - excessive_verification: "verify again", "check again"
 * - over_confirmation: "Let me confirm", "I need to confirm"
 * - rule_anchoring: "According to the guidelines", "As per the prompt"
 * - defensive: "Sorry", "apologies", "I apologize"
 * - hasty_completion: "I'll do this now", "Completing this"
 *
 * Run: node evaluation/pb4-sdk.mjs [--trials 3] [--timeout 90]
 */
import { createAgentSession, createBashTool, createReadTool, createWriteTool, createEditTool, createGrepTool, createFindTool, createLsTool, SessionManager, SettingsManager, DefaultResourceLoader, getAgentDir } from '@mariozechner/pi-coding-agent';
import { stepfunModels } from '/Users/kifir/projects/agents/pi-poorman-providers/stepfun.ts';
import { parseArgs } from 'util';
import { writeFileSync, mkdirSync, existsSync } from 'fs';

// ── Compliance patterns ────────────────────────────────────────────────────

const COMPLIANCE_PATTERNS = [
  { name: 'excessive_verification', pattern: /verify\s*again|check\s*again|double[\s-]?check|confirm\s*again/gi },
  { name: 'over_confirmation', pattern: /Let me confirm|I need to confirm|I should verify|Let me verify|I want to make sure/gi },
  { name: 'rule_anchoring', pattern: /According to the (guidelines|rules|instructions)|As per the (prompt|instructions)|following the (protocol|guidelines)/gi },
  { name: 'defensive', pattern: /\bSorry\b|apologies|I apologize|excuse me|I regret/gi },
  { name: 'hasty_completion', pattern: /I'?ll do this now|Completing this|Finishing up|Done!|Task complete/gi },
];

function countComplianceBehaviors(text) {
  const counts = {};
  let total = 0;
  for (const { name, pattern } of COMPLIANCE_PATTERNS) {
    const matches = text.match(pattern);
    counts[name] = matches ? matches.length : 0;
    total += counts[name];
  }
  counts.total = total;
  return counts;
}

// ── Standardized tasks ─────────────────────────────────────────────────────
// Same tasks run in both configs — measures behavioral difference

const TASKS = [
  {
    id: 'read-and-summarize',
    prompt: 'Read /Users/kifir/projects//pi-braid/package.json and tell me: (1) the project name, (2) the version, (3) how many dependencies there are. Be concise.',
  },
  {
    id: 'find-and-fix',
    prompt: 'Search for all .ts files in /Users/kifir/projects/agents/pi-braid/src/lib/ that contain the word "export default". List the file paths.',
  },
  {
    id: 'write-util',
    prompt: 'Write a simple JavaScript function to /tmp/pb4-util.js that takes an array of numbers and returns the sum. Include a basic test.',
  },
  {
    id: 'analyze-code',
    prompt: 'Read /Users/kifir/projects/agents/pi-braid/src/lib/evidence-pool.ts and explain in 2-3 sentences what the addEvidence function does.',
  },
  {
    id: 'multi-step',
    prompt: 'List the files in /Users/kifir/projects/agents/pi-braid/src/extensions/, then count how many directories there are, then find which extension has the most files.',
  },
];

// ── Run single task ───────────────────────────────────────────────────────

async function runTask(task, modelConfig, timeout = 90) {
  const result = {
    taskId: task.id,
    success: false,
    text: '',
    turns: 0,
    durationSeconds: 0,
    error: null,
    compliance: null,
  };

  const startTime = Date.now();

  const loader = new DefaultResourceLoader({
    cwd: '/Users/kifir/projects/agents/pi-braid',
    agentDir: getAgentDir(),
    extensionFactories: [(pi) => {
      pi.registerProvider('stepfun', {
        baseUrl: 'https://api.stepfun.ai/step_plan/v1',
        apiKey: 'STEP_API_KEY',
        api: 'openai-completions',
        models: stepfunModels,
      });
    }],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    resourceLoader: loader,
    model: modelConfig,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    tools: [
      createReadTool('/Users/kifir/projects/agents/pi-braid'),
      createBashTool('/Users/kifir/projects/agents/pi-braid'),
      createWriteTool('/tmp'),
      createEditTool('/tmp'),
      createGrepTool('/Users/kifir/projects/agents/pi-braid'),
      createFindTool('/Users/kifir/projects/agents/pi-braid'),
      createLsTool('/Users/kifir/projects/agents/pi-braid'),
    ],
  });

  session.subscribe((evt) => {
    if (evt.type === 'turn_start') result.turns++;
  });

  try {
    await Promise.race([
      session.prompt(task.prompt),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout * 1000)),
    ]);
    result.success = true;
  } catch (err) {
    result.error = err.message === 'timeout' ? 'timeout' : err.message;
  }

  result.durationSeconds = (Date.now() - startTime) / 1000;

  // Extract text
  const messages = session.state?.messages || [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const b of msg.content || []) {
        if (b.type === 'text') result.text += b.text || '';
      }
    }
  }

  result.compliance = countComplianceBehaviors(result.text);

  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────

export async function main() {
  const { values } = parseArgs({
    options: {
      trials: { type: 'string', default: '3' },
      timeout: { type: 'string', default: '90' },
      output: { type: 'string' },
    },
  });

  const modelCfg = {
    ...stepfunModels.find(m => m.id === 'step-3.5-flash'),
    provider: 'stepfun',
    api: 'openai-completions',
    baseUrl: 'https://api.stepfun.ai/step_plan/v1',
  };

  const trials = parseInt(values.trials);
  const timeout = parseInt(values.timeout);

  console.log('=== PB4 Compliance Behavior Measurement ===\n');
  console.log(`Model: stepfun/step-3.5-flash | Tasks: ${TASKS.length} | Trials: ${trials} | Timeout: ${timeout}s\n`);

  const allResults = [];

  for (let trial = 0; trial < trials; trial++) {
    console.log(`--- Trial ${trial + 1}/${trials} ---`);
    for (const task of TASKS) {
      console.log(`  [${task.id}]... `, { flush: true });
      const r = await runTask(task, modelCfg, timeout);
      allResults.push(r);
      const status = r.error === 'timeout' ? '⏱' : r.success ? '✅' : '❌';
      console.log(`${status} ${r.durationSeconds.toFixed(1)}s / ${r.turns}t / compliance=${r.compliance?.total || 0}`);
    }
  }

  // Aggregate
  console.log('\n=== Results ===');

  const byTask = {};
  for (const r of allResults) {
    if (!byTask[r.taskId]) byTask[r.taskId] = [];
    byTask[r.taskId].push(r);
  }

  console.log('\n## Compliance Behavior Counts (lower = more identity-driven)\n');
  console.log('| Task | Trials | Avg Total | excessive_verify | over_confirm | rule_anchor | defensive | hasty |');
  console.log('|------|--------|-----------|------------------|--------------|-------------|-----------|-------|');

  let grandTotal = 0;
  let grandCount = 0;

  for (const [taskId, results] of Object.entries(byTask)) {
    const avg = (key) => results.reduce((s, r) => s + (r.compliance?.[key] || 0), 0) / results.length;
    const avgTotal = avg('total');
    grandTotal += results.reduce((s, r) => s + (r.compliance?.total || 0), 0);
    grandCount += results.length;

    console.log(`| ${taskId} | ${results.length} | ${avgTotal.toFixed(1)} | ${avg('excessive_verification').toFixed(1)} | ${avg('over_confirmation').toFixed(1)} | ${avg('rule_anchoring').toFixed(1)} | ${avg('defensive').toFixed(1)} | ${avg('hasty_completion').toFixed(1)} |`);
  }

  console.log(`\n**Overall avg compliance per task: ${(grandTotal / grandCount).toFixed(1)}**`);

  // Pattern breakdown
  console.log('\n## Pattern Breakdown\n');
  const patternTotals = {};
  for (const { name } of COMPLIANCE_PATTERNS) {
    patternTotals[name] = allResults.reduce((s, r) => s + (r.compliance?.[name] || 0), 0);
  }
  for (const [name, total] of Object.entries(patternTotals)) {
    const bar = '█'.repeat(Math.min(total, 20));
    console.log(`  ${name}: ${total} ${bar}`);
  }

  if (values.output) {
    const outDir = values.output.replace(/\/[^/]+$/, '');
    if (outDir && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(values.output, JSON.stringify(allResults, null, 2));
    console.log(`\nSaved to ${values.output}`);
  }

  return allResults;
}

if (typeof process.send !== 'function' && process.argv[1] && process.argv[1].includes('pb4-sdk.mjs')) {
  main().catch((err) => {
    console.error('PB4 failed:', err);
    process.exit(1);
  });
}
