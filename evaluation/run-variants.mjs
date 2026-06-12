/**
 * Variant Benchmark Runner + Efficiency Metrics
 *
 * Runs BM1 tasks (5 original) + V1 variants, compares scores.
 * Tracks: token usage, tool calls per task, turns to solution.
 *
 * Usage:
 *   node evaluation/run-variants.mjs [--model stepfun/step-3.5-flash] [--trials 2] [--timeout 120]
 *
 * Flags:
 *   --only-stats  Skip running tasks, just show stored results
 *   --no-efficiency  Skip efficiency metrics collection
 */

import { createAgentSession, createBashTool, createReadTool, createEditTool, createWriteTool, createGrepTool, createFindTool, createLsTool, SessionManager, SettingsManager, DefaultResourceLoader, getAgentDir } from '@mariozechner/pi-coding-agent';
import { parseArgs } from 'util';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getAllVariantTasks, getVariantCount } from './variant-tasks.mjs';

// Dynamically load stepfun provider
let stepfunModels;
try {
  const stepfunModule = await import('/Users/kifir/projects/agents/pi-poorman-providers/stepfun.ts');
  stepfunModels = stepfunModule.stepfunModels;
} catch {
  stepfunModels = undefined;
}

const args = parseArgs({
  options: {
    model: { type: 'string', default: 'stepfun/step-3.5-flash' },
    trials: { type: 'string', default: '1' },
    timeout: { type: 'string', default: '120' },
    'only-stats': { type: 'boolean', default: false },
    'no-efficiency': { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

const MODEL = args.values.model;
const TRIALS = parseInt(args.values.trials, 10);
const TIMEOUT = parseInt(args.values.timeout, 10);
const RESULTS_FILE = join('evaluation', 'results', 'variant-results.json');

// ── Efficiency Metrics Interface ────────────────────────────────────────────

class EfficiencyTracker {
  constructor() {
    this.sessions = {};
  }

  startTask(taskId) {
    this.sessions[taskId] = {
      startTime: Date.now(),
      toolCalls: 0,
      toolCallNames: [],
      bashCalls: 0,
      editCalls: 0,
      readCalls: 0,
      turns: 0,
      textLength: 0,
    };
  }

  recordToolCall(taskId, toolName) {
    if (!this.sessions[taskId]) return;
    this.sessions[taskId].toolCalls++;
    this.sessions[taskId].toolCallNames.push(toolName);
    if (toolName === 'bash') this.sessions[taskId].bashCalls++;
    if (toolName === 'edit' || toolName === 'write') this.sessions[taskId].editCalls++;
    if (toolName === 'read') this.sessions[taskId].readCalls++;
  }

  recordTurn(taskId) {
    if (!this.sessions[taskId]) return;
    this.sessions[taskId].turns++;
  }

  recordText(taskId, text) {
    if (!this.sessions[taskId]) return;
    this.sessions[taskId].textLength += (text || '').length;
  }

  finishTask(taskId) {
    if (!this.sessions[taskId]) return;
    this.sessions[taskId].duration = Date.now() - this.sessions[taskId].startTime;
  }

  getMetrics(taskId) {
    return this.sessions[taskId] || null;
  }

  getAllMetrics() {
    return Object.entries(this.sessions).map(([id, data]) => ({ taskId: id, ...data }));
  }

  getSummary() {
    const all = Object.values(this.sessions);
    if (all.length === 0) return { avgToolCalls: 0, avgTurns: 0, totalTasks: 0 };
    return {
      totalTasks: all.length,
      avgToolCalls: (all.reduce((s, t) => s + t.toolCalls, 0) / all.length).toFixed(1),
      avgTurns: (all.reduce((s, t) => s + t.turns, 0) / all.length).toFixed(1),
      avgDuration: (all.reduce((s, t) => s + (t.duration || 0), 0) / all.length).toFixed(0),
      totalBashCalls: all.reduce((s, t) => s + t.bashCalls, 0),
      totalEditCalls: all.reduce((s, t) => s + t.editCalls, 0),
    };
  }
}

// ── BM1 Original Tasks (partial import from bm1-sdk) ─────────────────────────

import { TASKS as ORIGINAL_TASKS } from './bm1-sdk.mjs';

// ── Extract text and tool calls from messages ────────────────────────────────

function extractText(messages) {
  const lines = [];
  for (const msg of messages) {
    if (msg.role === 'assistant' || msg.role === 'toolResult') {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') lines.push(block.text || '');
          else if (block.type === 'toolCall') lines.push('[TOOL: ' + block.name + ']');
        }
      }
    }
  }
  return lines.join('\n');
}

function extractToolCalls(messages) {
  const calls = [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'toolCall') {
            calls.push({ tool: block.name, args: block.arguments });
          }
        }
      }
    }
  }
  return calls;
}

function setupTask(task) {
  const dir = task.setup.file.replace(/\/[^/]+$/, '');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(task.setup.file, task.setup.content);
}

// ── Run a single task ────────────────────────────────────────────────────────

async function runTask(task, agentFn, tracker, timeout) {
  setupTask(task);
  tracker.startTask(task.id);

  const start = Date.now();
  let result;
  try {
    result = await Promise.race([
      agentFn(task),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), (timeout || 120) * 1000)),
    ]);
  } catch (err) {
    result = { messages: [], text: '', toolCalls: [], error: err.message };
  }

  const text = result.text || extractText(result.messages || []);
  const toolCalls = result.toolCalls || extractToolCalls(result.messages || []);
  const turns = result.turns || toolCalls.length || 0;

  // Record efficiency
  for (const tc of toolCalls) {
    tracker.recordToolCall(task.id, tc.tool || tc.name || '');
  }
  for (let i = 0; i < turns; i++) tracker.recordTurn(task.id);
  tracker.recordText(task.id, text);
  tracker.finishTask(task.id);

  return {
    taskId: task.id,
    success: result.error ? false : true,
    text,
    toolCalls,
    turns,
    durationSeconds: (Date.now() - start) / 1000,
    error: result.error || null,
    score: result.score || 0,
  };
}

// ── Agent Factory ────────────────────────────────────────────────────────────

async function createAgent(modelConfig) {
  const agentDir = getAgentDir();
  const settingsManager = new SettingsManager(agentDir);
  const config = await settingsManager.load();
  config.model = modelConfig;
  await settingsManager.save(config);

  const loader = new DefaultResourceLoader();
  const sessionManager = new SessionManager(agentDir, loader, config);
  const apiKey = config.providers?.[modelConfig.split('/')[0]]?.apiKey || process.env.STEP_API_KEY || '';
  return { sessionManager, apiKey };
}

async function runTaskWithAgent(task, sessionManager, apiKey) {
  const session = await createAgentSession(sessionManager, apiKey);
  try {
    session.addTool(new createBashTool());
    session.addTool(new createReadTool());
    session.addTool(new createEditTool());
    session.addTool(new createWriteTool());
    session.addTool(new createGrepTool());
    session.addTool(new createFindTool());
    session.addTool(new createLsTool());

    const { messages } = await session.run(task.prompt, { timeout: 120 });
    const text = extractText(messages);
    const toolCalls = extractToolCalls(messages);

    // Use task's own verify if available
    let score = 0;
    if (task.verify) {
      const v = task.verify(toolCalls, text);
      score = v.score || 0;
    }

    return { messages, text, toolCalls, score, turns: 0, error: null };
  } catch (err) {
    return { messages: [], text: '', toolCalls: [], score: 0, turns: 0, error: err.message };
  } finally {
    await session.close();
  }
}

// ── Compute task verify scores (re-implement from bm1-sdk) ───────────────────

function computeScore(task, toolCalls, text) {
  // Simple scoring based on existing bm1-sdk verify patterns
  const isJsTask = task.id && task.id.includes('js-syntax');
  const isPyTask = task.id && task.id.includes('py-import');
  const isJsonTask = task.id && task.id.includes('json');
  const isTSTask = task.id && task.id.includes('ts-type');
  const isRaceTask = task.id && task.id.includes('race');

  if (isJsTask) {
    const fixed = toolCalls.some(t => ['write', 'edit'].includes(t.tool || '') && /\.js/.test(t.args?.path || ''));
    const checked = /node --check|valid|ok/i.test(text);
    return (fixed ? 50 : 0) + (checked ? 30 : 0) + (/(syntax|brace|typo|keyword|parens)/i.test(text) ? 20 : 0);
  }
  if (isPyTask) {
    const fixed = toolCalls.some(t => ['write', 'edit'].includes(t.tool || '') && /\.py/.test(t.args?.path || ''));
    const mentioned = /import|typo|module|path|fix/i.test(text);
    return (fixed ? 60 : 0) + (mentioned ? 40 : 0);
  }
  if (isJsonTask) {
    const fixed = toolCalls.some(t => ['write', 'edit'].includes(t.tool || '') && /\.json/.test(t.args?.path || ''));
    const mentioned = /comma|quote|syntax|json|nested/i.test(text);
    return (fixed ? 60 : 0) + (mentioned ? 40 : 0);
  }
  if (isTSTask) {
    const fixed = toolCalls.some(t => ['write', 'edit'].includes(t.tool || '') && /\.ts/.test(t.args?.path || ''));
    const checked = toolCalls.some(t => (t.tool || '') === 'bash' && /tsc/.test(t.args?.command || ''));
    const mentioned = /type|parameter|interface|annotation|array/i.test(text);
    return (fixed ? 50 : 0) + (checked ? 30 : 0) + (mentioned ? 20 : 0);
  }
  if (isRaceTask) {
    const fixed = toolCalls.some(t => ['write', 'edit'].includes(t.tool || '') && /\.js/.test(t.args?.path || ''));
    const mentioned = /race|atomic|mutex|lock|concurrent|shared|append/i.test(text);
    const correct = /exit.*0|count.*5|lines.*5|correct|fixed/i.test(text);
    return (fixed ? 50 : 0) + (mentioned ? 25 : 0) + (correct ? 25 : 0);
  }

  // Default: just check if they wrote a file
  return toolCalls.some(t => ['write', 'edit'].includes(t.tool || '')) ? 50 : 0;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  process.on('SIGINT', () => process.exit(1));

  if (args.values['only-stats']) {
    if (!existsSync(RESULTS_FILE)) {
      console.log(`No results file found at ${RESULTS_FILE}. Run without --only-stats first.`);
      process.exit(1);
    }
    const data = JSON.parse(readFileSync(RESULTS_FILE, 'utf-8'));
    printResults(data);
    process.exit(0);
  }

  console.log(`\n=== Variant Benchmark ===`);
  console.log(`Model: ${MODEL}`);
  console.log(`Trials: ${TRIALS} (per task)`);
  console.log(`Timeout: ${TIMEOUT}s`);
  console.log(`Tasks: ${ORIGINAL_TASKS.length} original + ${getVariantCount()} variants`);

  // Setup agent
  let modelConfig;
  if (MODEL.startsWith('stepfun/')) {
    if (!stepfunModels) {
      console.error('Error: stepfun provider not loaded');
      process.exit(1);
    }
    modelConfig = stepfunModels[MODEL.replace('stepfun/', '')] || stepfunModels[MODEL];
    if (!modelConfig) {
      console.error(`Unknown model: ${MODEL}`);
      process.exit(1);
    }
  } else {
    modelConfig = { model: MODEL, provider: MODEL.split('/')[0] };
  }

  const { sessionManager, apiKey } = await createAgent(modelConfig);
  const agentFn = (task) => runTaskWithAgent(task, sessionManager, apiKey);

  const tracker = new EfficiencyTracker();
  const originalScores = [];
  const variantScores = [];
  const allResults = [];

  // Run original tasks
  console.log('\n--- Original Tasks ---');
  for (const task of ORIGINAL_TASKS) {
    console.log(`  ${task.id}...`);
    for (let t = 0; t < TRIALS; t++) {
      const result = await runTask(task, agentFn, tracker, TIMEOUT);
      if (!result.score && !result.error) {
        result.score = computeScore(task, result.toolCalls, result.text);
      }
      result.type = 'original';
      result.trial = t;
      allResults.push(result);
      originalScores.push(result.score);
      const mark = result.error ? '❌' : '✓';
      console.log(`    Trial ${t + 1}: ${mark} score=${result.score} turns=${result.turns} tools=${result.toolCalls.length} ${result.error ? `(${result.error.slice(0, 40)})` : ''}`);
    }
  }

  // Run variant tasks
  console.log('\n--- Variant Tasks ---');
  const variants = getAllVariantTasks();
  for (const task of variants) {
    console.log(`  ${task.id}...`);
    for (let t = 0; t < TRIALS; t++) {
      const result = await runTask(task, agentFn, tracker, TIMEOUT);
      if (!result.score && !result.error) {
        result.score = computeScore(task, result.toolCalls, result.text);
      }
      result.type = 'variant';
      result.trial = t;
      allResults.push(result);
      variantScores.push(result.score);
      const mark = result.error ? '❌' : '✓';
      console.log(`    Trial ${t + 1}: ${mark} score=${result.score} turns=${result.turns} tools=${result.toolCalls.length} ${result.error ? `(${result.error.slice(0, 40)})` : ''}`);
    }
  }

  // Save results
  const results = {
    model: MODEL,
    trials: TRIALS,
    timestamp: new Date().toISOString(),
    summary: {
      originalCount: ORIGINAL_TASKS.length,
      variantCount: getVariantCount(),
      originalAvgScore: originalScores.length ? (originalScores.reduce((a, b) => a + b, 0) / originalScores.length).toFixed(1) : 0,
      variantAvgScore: variantScores.length ? (variantScores.reduce((a, b) => a + b, 0) / variantScores.length).toFixed(1) : 0,
      efficiency: tracker.getSummary(),
    },
    details: allResults,
    efficiency: tracker.getAllMetrics(),
  };

  // Ensure results directory exists
  const resultsDir = join('evaluation', 'results');
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${RESULTS_FILE}`);

  printResults(results);
}

function printResults(data) {
  const s = data.summary;
  console.log('\n=== Results Summary ===');
  console.log(`Model: ${data.model}`);
  console.log(`Trials: ${data.trials}`);
  console.log('');
  console.log('--- Task Scores ---');
  console.log(`Original average: ${s.originalAvgScore}/100`);
  console.log(`Variant average:  ${s.variantAvgScore}/100`);
  if (s.originalAvgScore > 0 && s.variantAvgScore > 0) {
    const drop = ((s.originalAvgScore - s.variantAvgScore) / s.originalAvgScore * 100).toFixed(0);
    console.log(`Variant drop:      ${drop}%`);
    if (parseInt(drop) > 30) console.log('⚠️  High variant drop - possible contamination');
    else if (parseInt(drop) > 15) console.log('⚠️  Moderate variant drop - some contamination likely');
    else console.log('✓ Low variant drop - good generalization');
  }

  console.log('\n--- Efficiency Metrics ---');
  const eff = s.efficiency;
  console.log(`Average tool calls per task: ${eff.avgToolCalls}`);
  console.log(`Average turns per task:       ${eff.avgTurns}`);
  console.log(`Average duration per task:    ${eff.avgDuration}ms`);
  console.log(`Total bash calls:              ${eff.totalBashCalls}`);
  console.log(`Total write/edit calls:        ${eff.totalEditCalls}`);
  console.log(`Total tasks:                   ${eff.totalTasks}`);

  console.log('\n--- Per-Task Details ---');
  const byType = { original: [], variant: [] };
  for (const d of data.details || []) {
    byType[d.type]?.push(d);
  }
  for (const d of data.details || []) {
    const mark = d.error ? '❌' : '✓';
    console.log(`  ${mark} ${d.taskId} (${d.type}): score=${d.score} turns=${d.turns || d.toolCalls?.length || 0} tools=${d.toolCalls?.length || 0} ${d.error ? `err=${d.error.slice(0, 30)}` : ''}`);
  }
}

await main();
