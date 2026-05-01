#!/usr/bin/env node
/**
 * pi-braid BM1 Multi-Turn Debugging Benchmark - SDK v2
 *
 * 5 realistic debugging tasks scored on diagnosis + fix quality.
 * Uses pi SDK directly (no subprocess, no RPC pipes, no deadlock).
 *
 * Run: node evaluation/bm1-sdk.mjs [--model stepfun/step-3.5-flash] [--timeout 120] [--trials 2]
 */
import { createAgentSession, createBashTool, createReadTool, createEditTool, createWriteTool, createGrepTool, createFindTool, createLsTool, SessionManager, SettingsManager, DefaultResourceLoader, getAgentDir } from '@mariozechner/pi-coding-agent';
import { stepfunModels } from '/Users/kifir/projects/agents/pi-poorman-providers/stepfun.ts';
import { parseArgs } from 'util';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// Task definitions
export const TASKS = [
  {
    id: 'js-syntax-fix',
    setup: {
      file: '/tmp/bm1-task1/syntax-bug.js',
      content: "// syntax-bug.js - has 3 syntax errors\nconst data = {\n  name: \"test\"\n  value: 42,\n  items: [1, 2, 3\n};\n\nfunction process(input {\n  return input.map(x => x * 2);\n}\n\nmodule.exports = { data, process };\n",
    },
    prompt: "Fix all syntax errors in /tmp/bm1-task1/syntax-bug.js. Run \"node -c /tmp/bm1-task1/syntax-bug.js\" to verify.",
    verify: (toolCalls, text) => { const wrote = toolCalls.some(t => ["write", "edit"].includes(t.tool) && /syntax-bug\.js/.test(t.args?.path || "")); const verified = /node -c|syntax.*ok|no.*error|valid/i.test(text) || toolCalls.some(t => t.tool === "bash" && /node -c/.test(t.args?.command || "")); return { wrote, verified, score: (wrote ? 50 : 0) + (verified ? 50 : 0) }; },
  },
  {
    id: 'py-import-fix',
    setup: {
      file: '/tmp/bm1-task2/app.py',
      content: "#!/usr/bin/env python3\nimport json\nimport os\nimport sys\nfrom pathlib import Path\nfrom collections import defaultdict\nimport requets  # typo: should be requests\n\ndef fetch(url):\n    response = requets.get(url)\n    return response.json()\n\nif __name__ == \"__main__\":\n    print(fetch(\"https://httpbin.org/json\"))\n",
    },
    prompt: "Fix the import error in /tmp/bm1-task2/app.py. The code has a typo in one import. Identify and fix it, then verify with \"python3 -c 'import ast; ast.parse(open('/tmp/bm1-task2/app.py').read()); print('OK')'\"",
    verify: (toolCalls, text) => { const fixed = toolCalls.some(t => ["write", "edit"].includes(t.tool) && /app\.py/.test(t.args?.path || "")); const foundTypo = /requets|typo|import.*fix|requests/i.test(text); return { fixed, foundTypo, score: (fixed ? 60 : 0) + (foundTypo ? 40 : 0) }; },
  },
  {
    id: 'json-trailing-comma',
    setup: {
      file: '/tmp/bm1-task3/config.json',
      content: "{\n  \"name\": \"my-app\",\n  \"version\": \"1.0.0\",\n  \"dependencies\": {\n    \"lodash\": \"^4.17.21\",\n    \"express\": \"^4.18.2\",\n  },\n  \"scripts\": {\n    \"start\": \"node index.js\",\n    \"test\": \"node test.js\",\n  }\n}\n",
    },
    prompt: "Fix the JSON syntax error in /tmp/bm1-task3/config.json. Use \"node -e 'JSON.parse(require('fs').readFileSync('/tmp/bm1-task3/config.json')); console.log('valid')'\" to verify.",
    verify: (toolCalls, text) => { const fixed = toolCalls.some(t => ["write", "edit"].includes(t.tool) && /config\.json/.test(t.args?.path || "")); const verified = /valid|json.*ok|no.*error/i.test(text) || toolCalls.some(t => t.tool === "bash" && /JSON\.parse/.test(t.args?.command || "")); const mentioned = /trailing comma|comma|syntax/i.test(text); return { fixed, verified, mentioned, score: (fixed ? 50 : 0) + (verified ? 30 : 0) + (mentioned ? 20 : 0) }; },
  },
  {
    id: 'ts-type-error',
    setup: {
      file: '/tmp/bm1-task4/utils.ts',
      content: "// utils.ts - has type errors\ninterface User {\n  name: string;\n  age: number;\n  email: string;\n}\n\nfunction greet(user: User): string {\n  return \"Hello, \" + user.name + \"! You are \" + user.age + \" years old.\";\n}\n\nfunction getEmail(user): string {\n  return user.email;\n}\n\nconst users: User[] = [\n  { name: \"Alice\", age: 30, email: \"alice@example.com\" },\n  { name: \"Bob\", age: \"25\", email: \"bob@example.com\" },\n];\n\nconsole.log(greet(users[0]));\nconsole.log(getEmail(users[1]));\n",
    },
    prompt: "Fix the TypeScript type errors in /tmp/bm1-task4/utils.ts. Run \"npx tsc --noEmit /tmp/bm1-task4/utils.ts\" to check. Fix all errors.",
    verify: (toolCalls, text) => { const fixed = toolCalls.some(t => ["write", "edit"].includes(t.tool) && /utils\.ts/.test(t.args?.path || "")); const checked = toolCalls.some(t => t.tool === "bash" && /tsc/.test(t.args?.command || "")); const mentioned = /type|annotation|number|string/i.test(text); return { fixed, checked, mentioned, score: (fixed ? 50 : 0) + (checked ? 30 : 0) + (mentioned ? 20 : 0) }; },
  },
  {
    id: 'race-condition',
    setup: {
      file: '/tmp/bm1-task5/counter.js',
      content: "// counter.js - race condition in async counter\nlet count = 0;\n\nasync function increment() {\n  const current = count;\n  await new Promise(r => setTimeout(r, 10));\n  count = current + 1;\n}\n\nasync function main() {\n  const promises = [];\n  for (let i = 0; i < 10; i++) {\n    promises.push(increment());\n  }\n  await Promise.all(promises);\n  console.log(\"Count:\", count);\n  if (count !== 10) {\n    console.log(\"BUG: Expected 10, got\", count);\n    process.exit(1);\n  }\n}\n\nmain();\n",
    },
    prompt: "Fix the race condition in /tmp/bm1-task5/counter.js. The async increment has a read-then-write race. Run \"node /tmp/bm1-task5/counter.js\" to verify it outputs \"Count: 10\".",
    verify: (toolCalls, text) => { const fixed = toolCalls.some(t => ["write", "edit"].includes(t.tool) && /counter\.js/.test(t.args?.path || "")); const ran = toolCalls.some(t => t.tool === "bash" && /node.*counter/.test(t.args?.command || "")); const mentioned = /race|async|await|mutex|lock|atomic|queue/i.test(text); const correct = /Count: 10|count.*10|correct|fixed/i.test(text); return { fixed, ran, mentioned, correct, score: (fixed ? 40 : 0) + (ran ? 20 : 0) + (mentioned ? 20 : 0) + (correct ? 20 : 0) }; },
  },
];

// Helpers

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
            calls.push({ tool: block.name, tool_call_id: block.id, args: block.arguments });
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

export async function runTask(task, modelConfig, timeout = 120) {
  setupTask(task);
  const result = {
    taskId: task.id, success: false, text: '', toolCalls: [],
    turns: 0, durationSeconds: 0, error: null, score: 0, details: null,
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
    resourceLoader: loader, model: modelConfig,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    tools: [
      createReadTool('/tmp'), createBashTool('/tmp'), createEditTool('/tmp'),
      createWriteTool('/tmp'), createGrepTool('/tmp'), createFindTool('/tmp'),
      createLsTool('/tmp'),
    ],
  });

  session.subscribe((evt) => { if (evt.type === 'turn_start') result.turns++; });

  try {
    await Promise.race([
      session.prompt(task.prompt),
      new Promise((_, reject) => setTimeout(() => reject(new Error('task_timeout')), timeout * 1000)),
    ]);
    result.success = true;
  } catch (err) {
    result.error = err.message === 'task_timeout' ? 'timeout' : err.message;
  }

  result.durationSeconds = (Date.now() - startTime) / 1000;
  const messages = session.state?.messages || [];
  result.text = extractText(messages);
  result.toolCalls = extractToolCalls(messages);
  const details = task.verify(result.toolCalls, result.text);
  result.details = details;
  result.score = details.score;
  return result;
}

export async function main() {
  const { values } = parseArgs({
    options: {
      model: { type: 'string', default: 'stepfun/step-3.5-flash' },
      timeout: { type: 'string', default: '120' },
      trials: { type: 'string', default: '1' },
      output: { type: 'string' },
    },
  });

  const modelId = values.model.includes('/') ? values.model : 'stepfun/' + values.model;
  const modelCfg = {
    ...stepfunModels.find(m => m.id === modelId.replace('stepfun/', '')),
    provider: 'stepfun', api: 'openai-completions',
    baseUrl: 'https://api.stepfun.ai/step_plan/v1',
  };

  console.log('=== BM1 Multi-Turn Debugging Benchmark v2 ===');
  console.log('Model: ' + modelId);
  console.log('Tasks: ' + TASKS.length + ' | Timeout: ' + values.timeout + 's | Trials: ' + values.trials + '\n');

  const allResults = [];
  const timeout = parseInt(values.timeout);
  const trials = parseInt(values.trials);

  for (let trial = 0; trial < trials; trial++) {
    if (trials > 1) console.log('\n--- Trial ' + (trial + 1) + '/' + trials + ' ---');
    for (const task of TASKS) {
      console.log('[' + task.id + ']... ');
      const r = await runTask(task, modelCfg, timeout);
      allResults.push(r);
      const status = r.error === 'timeout' ? 'T' : r.success ? 'P' : 'F';
      console.log(status + ' ' + r.durationSeconds.toFixed(1) + 's / ' + r.turns + 't / score=' + r.score + '/100');
    }
  }

  console.log('\n=== Results ===');
  const byTask = {};
  for (const r of allResults) {
    if (!byTask[r.taskId]) byTask[r.taskId] = [];
    byTask[r.taskId].push(r);
  }

  let totalScore = 0, totalCount = 0;
  console.log('| Task | Score | Turns | Duration |');
  console.log('|------|-------|-------|----------|');
  for (const [taskId, results] of Object.entries(byTask)) {
    const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length;
    const avgTurns = results.reduce((s, r) => s + r.turns, 0) / results.length;
    const avgDur = results.reduce((s, r) => s + r.durationSeconds, 0) / results.length;
    totalScore += results.reduce((s, r) => s + r.score, 0);
    totalCount += results.length;
    console.log('| ' + taskId + ' | ' + avgScore.toFixed(0) + '/100 | ' + avgTurns.toFixed(1) + ' | ' + avgDur.toFixed(1) + 's |');
  }
  console.log('\nOverall: ' + (totalScore / totalCount).toFixed(1) + '/100');

  if (values.output) {
    const outDir = values.output.replace(/\/[^/]+$/, '');
    if (outDir && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(values.output, JSON.stringify(allResults, null, 2));
    console.log('Saved to ' + values.output);
  }
  return allResults;
}

if (typeof process.send !== 'function' && process.argv[1] && process.argv[1].includes('bm1-sdk.mjs')) {
  main().catch((err) => { console.error('BM1 failed:', err); process.exit(1); });
}
