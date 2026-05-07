#!/usr/bin/env node
/**
 * deep-investigate — Run a single task with full session capture.
 *
 * Captures:
 * 1. Full system prompt (after all extension modifications)
 * 2. All tool calls with timing and arguments
 * 3. Agent's reasoning text
 * 4. Session export to HTML for human review
 * 5. Score and failure explanation
 *
 * Usage:
 *   node evaluation/deep-investigate.mjs --bm2 deep-clone           # single task
 *   node evaluation/deep-investigate.mjs --bm2 --all                # all BM2 tasks
 *   node evaluation/deep-investigate.mjs --bm1 --compare           # compare braid vs naked
 *
 * Output:
 *   evaluation/results/investigation/{benchmark}/{task}/{mode}.html
 *   evaluation/results/investigation/report.md
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RESULTS = join(ROOT, 'evaluation', 'results', 'investigation');
const NS = new Date().toISOString().replace(/[:.]/g, '-');

mkdirSync(RESULTS, { recursive: true });

// ── Build check ──────────────────────────────────────────────────────────

const { verifyBuild } = await import('./lib/evaluator.mjs');
verifyBuild();

const distEval = join(ROOT, 'dist', 'evaluation', 'lib', 'evaluator.js');
if (!existsSync(distEval)) {
  // The evaluator is .mjs, not compiled by tsc — need to import directly
}

// ── Load tasks ───────────────────────────────────────────────────────────

async function loadTasks(benchKey) {
  const registry = {
    bm1: { file: './tasks/bm1-debug.mjs', name: 'BM1 Multi‑Turn Debugging' },
    bm2: { file: './tasks/bm2-code.mjs', name: 'BM2 Code Quality' },
    br1: { file: './tasks/br1-trap.mjs', name: 'BR1 Trap Tasks' },
  };
  const entry = registry[benchKey];
  if (!entry) throw new Error(`Unknown benchmark: ${benchKey}`);
  const mod = await import(entry.file);
  return { tasks: mod.TASKS, name: entry.name, key: benchKey };
}

// ── Single-task investigation ────────────────────────────────────────────

async function investigateTask(benchKey, task, mode, outDir) {
  const taskOut = join(outDir, `${mode}.html`);
  console.log(`\n  ┌─ ${task.id} [${mode}]`);
  console.log(`  │ Prompt: ${task.prompt.slice(0, 60)}...`);

  // Create fresh session
  const { createBenchSession, runTask } = await import('./lib/evaluator.mjs');
  const { session, cleanup } = await createBenchSession({
    safeMode: mode === 'safe',
    compaction: false,
    sessionDir: `/tmp/invest-${benchKey}-${task.id}-${mode}-${Date.now()}`,
  });

  // Capture: system prompt, tool calls, reasoning
  const capture = {
    systemPrompt: '',
    toolCalls: [],
    reasoning: '',
    finalText: '',
    turns: 0,
  };

  const unsub = session.subscribe((evt) => {
    if (evt.type === 'turn_start') capture.turns++;
    if (evt.type === 'agent_start') {
      // Capture system prompt from agent state
      try { capture.systemPrompt = session.agent?.state?.systemPrompt || ''; } catch {}
    }
    if (evt.type === 'tool_execution_start') {
      capture.toolCalls.push({
        tool: evt.toolName,
        args: JSON.stringify(evt.args).slice(0, 200),
        time: Date.now(),
      });
    }
    if (evt.type === 'message_end' && evt.message?.role === 'assistant') {
      for (const b of (evt.message.content || [])) {
        if (b.type === 'text') capture.finalText += b.text;
        if (b.type === 'thinking') capture.reasoning += b.thinking;
      }
    }
  });

  // Run the task
  const result = await runTask(session, {
    id: task.id,
    prompt: task.prompt,
    timeout: task.timeout || 60,
  });

  unsub();
  cleanup();

  // Score
  let score = result.error ? 0 : 100;
  let scoreReason = result.error ? `error: ${result.error}` : 'completed';

  if (benchKey === 'br1') {
    const { scoreTrapTask } = await import('./lib/scoring.mjs');
    const s = scoreTrapTask(capture.finalText, task.expectedRefusal);
    score = s.score;
    scoreReason = s.reason;
  }

  // Generate HTML report
  const html = generateReport(benchKey, task, mode, capture, result, score, scoreReason);
  writeFileSync(taskOut, html);

  console.log(`  │ Turns: ${capture.turns} | Tools: ${new Set(capture.toolCalls.map(t => t.tool)).size} | Score: ${score}/100`);
  console.log(`  │ ${scoreReason}`);
  console.log(`  │ Report: ${taskOut}`);
  console.log(`  └─`);

  return { taskId: task.id, score, reason: scoreReason, mode, htmlFile: taskOut, toolCalls: capture.toolCalls.length, turns: capture.turns, systemPrompt: capture.systemPrompt.slice(0, 500) };
}

// ── HTML report template ────────────────────────────────────────────────

function generateReport(benchKey, task, mode, capture, result, score, scoreReason) {
  const toolCallsHtml = capture.toolCalls.map((tc, i) =>
    `<tr><td>${i + 1}</td><td>${tc.tool}</td><td><code>${escapeHtml(tc.args)}</code></td></tr>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${benchKey} — ${task.id} [${mode}]</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 960px; margin: 2em auto; padding: 0 1em; }
  h1 { color: #333; border-bottom: 2px solid #eee; }
  .score { font-size: 2em; font-weight: bold; padding: 0.3em 0.6em; border-radius: 4px; display: inline-block; }
  .score.good { background: #e6ffe6; color: #060; }
  .score.bad { background: #ffe6e6; color: #600; }
  .score.mid { background: #fffbe6; color: #660; }
  pre { background: #f5f5f5; padding: 1em; border-radius: 4px; overflow-x: auto; font-size: 0.9em; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #ddd; padding: 0.5em; text-align: left; }
  th { background: #f0f0f0; }
  .section { margin: 2em 0; }
  .section h2 { color: #444; }
</style>
</head>
<body>
<h1>${benchKey}: ${escapeHtml(task.id)}</h1>
<p>Mode: <strong>${mode}</strong> | Task: ${escapeHtml(task.prompt)}</p>

<div class="section">
  <h2>Score</h2>
  <div class="score ${score >= 80 ? 'good' : score >= 50 ? 'mid' : 'bad'}">${score}/100</div>
  <p>${escapeHtml(scoreReason)}</p>
</div>

<div class="section">
  <h2>Stats</h2>
  <table>
    <tr><td>Duration</td><td>${(result.duration / 1000).toFixed(1)}s</td></tr>
    <tr><td>Turns</td><td>${capture.turns}</td></tr>
    <tr><td>Tool calls</td><td>${capture.toolCalls.length}</td></tr>
    <tr><td>Error</td><td>${result.error || 'none'}</td></tr>
  </table>
</div>

<div class="section">
  <h2>Tool Calls</h2>
  <table>
    <tr><th>#</th><th>Tool</th><th>Arguments</th></tr>
    ${toolCallsHtml}
  </table>
</div>

<div class="section">
  <h2>System Prompt (first 2K)</h2>
  <pre>${escapeHtml(capture.systemPrompt.slice(0, 2000))}</pre>
  ${capture.systemPrompt.length > 2000 ? '<p><em>...truncated</em></p>' : ''}
</div>

<div class="section">
  <h2>Agent Reasoning</h2>
  <pre>${escapeHtml(capture.reasoning.slice(0, 3000))}</pre>
</div>

<div class="section">
  <h2>Final Response</h2>
  <pre>${escapeHtml(capture.finalText.slice(0, 3000))}</pre>
</div>
</body>
</html>`;
}

function escapeHtml(text) {
  return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const { values } = parseArgs({
    options: {
      bm1: { type: 'boolean', default: false },
      bm2: { type: 'boolean', default: false },
      br1: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      compare: { type: 'boolean', default: false },
      task: { type: 'string' },
    },
  });

  const benchKey = values.bm1 ? 'bm1' : values.bm2 ? 'bm2' : values.br1 ? 'br1' : 'bm2';
  const { tasks, name } = await loadTasks(benchKey);
  const taskList = values.all ? tasks : tasks.filter(t => !values.task || t.id === values.task);
  if (taskList.length === 0) {
    console.log(`Available tasks for ${benchKey}:`);
    tasks.forEach(t => console.log(`  ${t.id}`));
    return;
  }

  const modes = values.compare ? ['braid', 'naked', 'safe'] : ['braid'];
  const outDir = join(RESULTS, benchKey, NS);
  mkdirSync(outDir, { recursive: true });

  console.log(`\n=== Deep Investigation: ${name} ===`);
  console.log(`Tasks: ${taskList.map(t => t.id).join(', ')}`);
  console.log(`Modes: ${modes.join(', ')}`);
  console.log(`Output: ${outDir}\n`);

  const allResults = [];

  for (const task of taskList) {
    for (const mode of modes) {
      // For 'naked' mode, set env var to disable braid extensions
      if (mode === 'naked') {
        process.env.PI_CODING_AGENT_DIR = '/tmp/pi-naked-investigate';
        if (!existsSync('/tmp/pi-naked-investigate')) {
          mkdirSync('/tmp/pi-naked-investigate/extensions', { recursive: true });
          const { homedir } = await import('os');
          const authSrc = join(homedir(), '.pi', 'agent', 'auth.json');
          if (existsSync(authSrc)) cpSync(authSrc, join('/tmp/pi-naked-investigate', 'auth.json'));
          writeFileSync(join('/tmp/pi-naked-investigate', 'settings.json'), JSON.stringify({
            defaultProvider: 'stepfun', defaultModel: 'step-3.5-flash',
            compaction: { enabled: false }, hideThinkingBlock: true, quietStartup: true,
            extensions: ['/Users/kifir/projects/agents/pi-poorman-providers'],
          }, null, 2));
        }
      } else {
        delete process.env.PI_CODING_AGENT_DIR;
      }

      const r = await investigateTask(benchKey, task, mode, outDir);
      allResults.push(r);
    }
  }

  // Summary report
  const report = [];
  report.push(`# Deep Investigation: ${name}\n`);
  report.push(`**Date**: ${new Date().toISOString()}\n`);
  report.push(`| Task | Mode | Score | Reason | Turns | Tools |`);
  report.push(`|------|------|-------|--------|-------|-------|`);
  for (const r of allResults) {
    report.push(`| ${r.taskId} | ${r.mode} | ${r.score}/100 | ${r.reason} | ${r.turns} | ${r.toolCalls} |`);
  }

  // Observations
  report.push(`\n## Observations\n`);
  for (const r of allResults) {
    if (r.score < 50) {
      report.push(`### ${r.taskId} [${r.mode}] — FAIL (${r.score}/100)\n`);
      report.push(`Reason: ${r.reason}\n`);
      if (r.systemPrompt) {
        report.push(`System prompt excerpt: \`${r.systemPrompt.slice(0, 200)}...\`\n`);
      }
      report.push(`Full report: [${r.htmlFile}](${r.htmlFile})\n`);
    }
  }

  const reportFile = join(outDir, 'report.md');
  writeFileSync(reportFile, report.join('\n'));
  console.log(`\n=== Report: ${reportFile} ===`);
}

main().catch(err => { console.error(err); process.exit(1); });
