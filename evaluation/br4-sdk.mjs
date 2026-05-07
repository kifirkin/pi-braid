#!/usr/bin/env node
/**
 * BR4: Latent Activator Multi-Turn Comparison
 * ==========================================
 * Research: Does identity framing work in multi-turn vs single-shot?
 *
 * Compares:
 *   A_braid: pi-braid with latent activator ON
 *   C_baseline: No extensions (baseline)
 *
 * Metrics: solve rate, turns, tokens, tool count, compliance behaviors
 *
 * Run: node evaluation/br4-sdk.mjs --task "multi-turn task"
 */
import { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, getAgentDir } from '@mariozechner/pi-coding-agent';
import { stepfunModels } from '/Users/kifir/projects/agents/pi-poorman-providers/stepfun.ts';
import { parseArgs } from 'util';

// --- Compliance behavior patterns ---
const COMPLIANCE_PATTERNS = [
  { name: 'excessive_verification', pattern: /verify.*again|check.*again|double.?check|confirm.*again/gi },
  { name: 'over_confirmation', pattern: /Let me confirm|I need to confirm|I should verify|Let me verify/gi },
  { name: 'rule_anchoring', pattern: /According to the guidelines|As per the prompt|As instructed/gi },
  { name: 'hasty_completion', pattern: /I.?ll do this now|Completing this|Finishing up|Done/gi },
  { name: 'defensive', pattern: /Sorry|apologies|I apologize|excuse me/gi },
];

function countComplianceBehaviors(text) {
  const counts = {};
  for (const { name, pattern } of COMPLIANCE_PATTERNS) {
    const matches = text.match(pattern);
    counts[name] = matches ? matches.length : 0;
  }
  return counts;
}

// --- Stepfun model ---
const stepfunModel = {
  ...stepfunModels.find(m => m.id === 'step-3.5-flash'),
  provider: 'stepfun',
  api: 'openai-completions',
  baseUrl: 'https://api.stepfun.ai/step_plan/v1',
};

// --- Run single trial ---
async function runTrial(config, taskPrompt, timeout = 90) {
  const loader = new DefaultResourceLoader({
    cwd: '/Users/kifir/projects/agents/pi-braid',
    agentDir: getAgentDir(),
    extensionFactories: config.noExtensions ? [] : [(pi) => {
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
    model: stepfunModel,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  });

  const result = { config, success: false, turns: 0, tokenCount: 0, toolCount: 0, complianceBehaviors: 0, duration: 0, error: null };
  let text = '';
  const startTime = Date.now();

  session.subscribe((evt) => {
    if (evt.type === 'turn_start') result.turns++;
    if (evt.type === 'tool_execution_start' || evt.type === 'tool_execution_end') result.toolCount++;
  });

  try {
    await Promise.race([
      session.prompt(taskPrompt),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout * 1000)),
    ]);
    result.success = true;
  } catch (err) {
    result.error = err.message === 'timeout' ? 'timeout' : err.message;
  }

  result.duration = (Date.now() - startTime) / 1000;

  // Extract text
  for (const m of session.state?.messages || []) {
    if (m.role === 'assistant') {
      for (const b of m.content || []) {
        if (b.type === 'text') text += b.text || '';
      }
    }
  }
  result.tokenCount = text.length / 4;

  // Count compliance behaviors
  const compliance = countComplianceBehaviors(text);
  result.complianceBehaviors = Object.values(compliance).reduce((s, v) => s + v, 0);

  return result;
}

// --- Run full BR4 ---
export async function runBR4(taskPrompt, trials = 3, timeout = 90) {
  const configs = [
    { name: 'C_baseline', noExtensions: true },
    { name: 'A_braid_latent', noExtensions: false },
  ];

  const results = {};

  for (const config of configs) {
    results[config.name] = [];
    for (let t = 0; t < trials; t++) {
      console.error(`[${config.name}] Trial ${t + 1}/${trials}...`);
      const r = await runTrial(config, taskPrompt, timeout);
      results[config.name].push(r);
      console.error(`  → success=${r.success}, turns=${r.turns}, compliance=${r.complianceBehaviors}, tools=${r.toolCount}, duration=${r.duration.toFixed(1)}s`);
    }
  }

  // Aggregate
  const summary = {};
  for (const [name, trialsData] of Object.entries(results)) {
    if (!trialsData.length) continue;
    const avg = (fn) => trialsData.reduce((s, r) => s + fn(r), 0) / trialsData.length;
    summary[name] = {
      trials: trialsData.length,
      solveRate: trialsData.filter(r => r.success).length / trialsData.length,
      avgTurns: avg(r => r.turns),
      avgTokens: avg(r => r.tokenCount),
      avgTools: avg(r => r.toolCount),
      avgCompliance: avg(r => r.complianceBehaviors),
      raw: trialsData,
    };
  }

  return summary;
}

// --- Format results ---
export function formatSummary(summary) {
  const lines = ['# BR4: Latent Activator Multi-Turn Results\n'];

  lines.push('## Configuration Comparison');
  lines.push('| Config | Solve Rate | Avg Turns | Avg Tokens | Avg Tools | Compliance |');
  lines.push('|--------|------------|-----------|------------|-----------|------------|');
  for (const [name, data] of Object.entries(summary)) {
    lines.push(`| ${name} | ${(data.solveRate * 100).toFixed(0)}% | ${data.avgTurns.toFixed(1)} | ${data.avgTokens.toFixed(0)} | ${data.avgTools.toFixed(1)} | ${data.avgCompliance.toFixed(1)} |`);
  }

  lines.push('\n## Research Question');
  lines.push('Does identity framing work in multi-turn vs single-shot?');

  if (summary.A_braid_latent && summary.C_baseline) {
    const a = summary.A_braid_latent;
    const c = summary.C_baseline;
    const complianceDelta = a.avgCompliance - c.avgCompliance;
    const turnDelta = a.avgTurns - c.avgTurns;

    lines.push('\n### Findings');
    if (complianceDelta < 0) {
      lines.push(`- ✅ Latent reduced compliance behaviors: ${complianceDelta.toFixed(1)}`);
    } else {
      lines.push(`- ⚠️ Latent increased compliance behaviors: ${complianceDelta.toFixed(1)}`);
    }
    if (turnDelta > 0) {
      lines.push(`- ✅ Latent increased persistence: +${turnDelta.toFixed(1)} turns`);
    } else {
      lines.push(`- ⚠️ Latent decreased persistence: ${turnDelta.toFixed(1)} turns`);
    }
    lines.push(`- Solve rate: ${(a.solveRate * 100).toFixed(0)}% (braid) vs ${(c.solveRate * 100).toFixed(0)}% (baseline)`);
  }

  return lines.join('\n');
}

// --- Default task ---
const DEFAULT_TASK = 'Read /Users/kifir/projects/agents/pi-braid/package.json, tell me the project name, then list the src/ directory contents using bash.';

// --- Main ---
async function main() {
  const { values } = parseArgs({
    options: {
      task: { type: 'string', default: DEFAULT_TASK },
      trials: { type: 'string', default: '3' },
      timeout: { type: 'string', default: '90' },
      output: { type: 'string' },
    },
  });

  console.error('=== BR4 Latent Multi-Turn (SDK) ===');
  console.error(`Model: stepfun/step-3.5-flash`);
  console.error(`Task: ${values.task.slice(0, 60)}...`);
  console.error(`Trials: ${values.trials}, Timeout: ${values.timeout}s\n`);

  const summary = await runBR4(
    values.task,
    parseInt(values.trials),
    parseInt(values.timeout),
  );

  const output = formatSummary(summary);
  console.log(output);

  if (values.output) {
    const { writeFileSync } = await import('fs');
    writeFileSync(values.output, JSON.stringify(summary, null, 2));
    console.error(`\nSaved to ${values.output}`);
  }
}

if (typeof process.send !== 'function' && process.argv[1] && process.argv[1].includes('br4-sdk.mjs')) {
  main().catch((err) => {
    console.error('BR4 failed:', err);
    process.exit(1);
  });
}
