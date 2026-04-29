#!/usr/bin/env node
/**
 * pi-braid BM1 Multi-Turn Debugging Benchmark — SDK version
 * 
 * Uses pi SDK directly (no subprocess, no RPC pipes, no deadlock).
 * Registers stepfun/step-3.5-flash from pi-poorman-providers.
 * Reliable text extraction from session.state.messages after prompt() resolves.
 * 
 * Run: node evaluation/bm1-sdk.mjs
 */
import { createAgentSession, createBashTool, createReadTool, createEditTool, createWriteTool, SessionManager, SettingsManager, DefaultResourceLoader, getAgentDir } from '@mariozechner/pi-coding-agent';
import { stepfunModels } from '/Users/kifir/projects/agents/pi-poorman-providers/stepfun.ts';
import { a0veniceModels } from '/Users/kifir/projects/agents/pi-poorman-providers/a0venice.ts';

// --- Task definitions ---
export const TASKS = [
  {
    id: 'ts-read-fail',
    prompt: 'Read the file test/runtime/test-retry-command.mjs and identify any JavaScript syntax errors. If found, fix them.',
    workspace: '/Users/kifir/projects/agents/pi-braid',
    expected: 'Fix syntax errors in test-retry-command.mjs',
  },
  {
    id: 'ls-bash-fail',
    prompt: 'Run: ls /nonexistent/path/xyz123 2>&1 || echo "not found"',
    workspace: '/Users/kifir/projects/agents/pi-braid',
    expected: 'Non-zero exit code from ls, then echo "not found"',
  },
  {
    id: 'edit-fail',
    prompt: 'Append a comment "# DEBUG MARKER" to the end of package.json without corrupting JSON.',
    workspace: '/Users/kifir/projects/agents/pi-braid',
    expected: 'Valid JSON with comment at end (invalid JSON — task tests error recovery)',
  },
];

// --- Helpers ---
function extractText(messages) {
  const lines = [];
  for (const msg of messages) {
    if (msg.role === 'assistant' || msg.role === 'toolResult') {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') lines.push(block.text || '');
          else if (block.type === 'toolCall') lines.push(`[TOOL: ${block.name}]`);
          else if (block.type === 'thinking') lines.push(`[THINKING: ${block.thinking || ''}]`);
        }
      }
    }
  }
  return lines.join('\n');
}

function extractToolCalls(messages) {
  const calls = [];
  for (const msg of messages) {
    if (msg.role === 'assistant' || msg.role === 'toolResult') {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'toolCall') {
            calls.push({ tool: block.name, tool_call_id: block.id, args: block.arguments });
          }
        }
      }
    }
  }
  return calls;
}

// --- Score ---
function score(task, result) {
  let score = 0;
  const text = result.text || '';
  
  if (task.id === 'ts-read-fail') {
    // Check if file was read + any edit/write of .mjs file
    const fileFixed = /test[.-]?retry[.-]?command\.mjs/.test(text) || 
                     result.toolCalls.some(t => /write|edit/.test(t.tool) && /\.mjs$/.test(t.args?.path || ''));
    if (fileFixed) score += 70;
    if (/syntax|parse|error|fix/i.test(text)) score += 30;
  } else if (task.id === 'ls-bash-fail') {
    const lsCorrect = result.toolCalls.some(t => t.tool === 'bash' && /nonexistent.*xyz123|xyz123.*nonexistent/.test(t.args?.command || ''));
    const echoFound = /not found/i.test(text);
    if (lsCorrect) score += 50;
    if (echoFound) score += 50;
  } else if (task.id === 'edit-fail') {
    const wrotePkg = result.toolCalls.some(t => t.tool === 'write' && /package\.json/.test(t.args?.path || ''));
    if (wrotePkg) score += 70;
    if (/json|comment|corrupt|invalid/i.test(text)) score += 30;
  }
  
  return Math.min(100, score);
}

// --- Run single task ---
export async function runTask(task, timeout = 90) {
  const result = {
    taskId: task.id,
    success: false,
    text: '',
    toolCalls: [],
    turns: 0,
    durationSeconds: 0,
    error: null,
    score: 0,
  };
  
  const startTime = Date.now();
  
  // Create resource loader with stepfun provider registered
  const loader = new DefaultResourceLoader({
    cwd: task.workspace,
    agentDir: getAgentDir(),
    extensionFactories: [(pi) => {
      pi.registerProvider('stepfun', {
        baseUrl: 'https://api.stepfun.ai/step_plan/v1',
        apiKey: 'STEP_API_KEY',
        api: 'openai-completions',
        models: stepfunModels,
      });
      pi.registerProvider('a0-venice', {
        baseUrl: 'https://api.agent-zero.ai/venice/v1',
        apiKey: 'A0_VENICE_API_KEY_EXT',
        api: 'openai-completions',
        models: a0veniceModels,
      });
    }],
  });
  await loader.reload();
  
  // Build full stepfun model object (provider+api+baseUrl needed for API calls)
  const stepfunModel = {
    ...stepfunModels.find(m => m.id === 'step-3.5-flash'),
    provider: 'stepfun',
    api: 'openai-completions',
    baseUrl: 'https://api.stepfun.ai/step_plan/v1',
  };

  // Create session with stepfun model + tools
  const { session } = await createAgentSession({
    resourceLoader: loader,
    model: stepfunModel,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    tools: [
      createReadTool(task.workspace),
      createBashTool(task.workspace),
      createEditTool(task.workspace),
      createWriteTool(task.workspace),
    ],
  });
  
  // Count turns from events
  session.subscribe((evt) => {
    if (evt.type === 'turn_start') result.turns++;
  });
  
  // Run prompt with per-task timeout
  try {
    await Promise.race([
      session.prompt(task.prompt),
      new Promise((_, reject) => setTimeout(() => reject(new Error('task_timeout')), timeout * 1000)),
    ]);
    result.success = true;
  } catch (err) {
    if (err.message === 'task_timeout') {
      result.error = 'timeout';
      result.durationSeconds = timeout;
    } else {
      result.error = err.message || String(err);
    }
  }
  
  result.durationSeconds = (Date.now() - startTime) / 1000;
  
  // Extract text + tool calls from messages
  const messages = session.state?.messages || [];
  result.text = extractText(messages);
  result.toolCalls = extractToolCalls(messages);
  
  // Score
  result.score = score(task, result);
  
  return result;
}

// --- Main ---
export async function main() {
  console.log('=== pi-braid BM1 Multi-Turn Debugging (SDK) ===\n');
  console.log('Model: stepfun/step-3.5-flash (via pi-poorman-providers)\n');
  
  const results = [];
  
  for (const task of TASKS) {
    console.log(`[${task.id}] Running: ${task.prompt.slice(0, 60)}...`);
    const r = await runTask(task);
    results.push(r);
    console.log(`  → turns=${r.turns} duration=${r.durationSeconds.toFixed(1)}s score=${r.score}/100`);
    if (r.error) console.log(`  → error: ${r.error}`);
    console.log(`  → text: ${r.text.slice(0, 100).replace(/\n/g, ' ')}...`);
    console.log(`  → tools: ${r.toolCalls.map(t => t.tool).join(', ')}`);
    console.log();
  }
  
  // Summary
  const avg = results.reduce((s, r) => s + r.score, 0) / results.length;
  console.log('=== Results ===');
  for (const r of results) {
    console.log(`  ${r.taskId}: ${r.score}/100`);
  }
  console.log(`\nAverage score: ${avg.toFixed(1)}/100`);
  console.log(`Total duration: ${results.reduce((s, r) => s + r.durationSeconds, 0).toFixed(1)}s`);
}

// Only run main() when executed directly (not imported)
if (typeof process.send !== 'function' && process.argv[1] && process.argv[1].includes('bm1-sdk.mjs')) {
  main().catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}
