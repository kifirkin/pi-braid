#!/usr/bin/env node
/**
 * BM3: Real-World Tasks Benchmark - SDK version
 *
 * Tests agent on realistic development tasks that mirror actual usage:
 * 1. Refactor a messy function
 * 2. Add error handling to an API endpoint
 * 3. Write a test suite for existing code
 * 4. Debug a performance issue
 * 5. Implement a feature from a spec
 *
 * Run: node evaluation/bm3-sdk.mjs [--model stepfun/step-3.5-flash] [--timeout 120]
 */
import { createAgentSession, createBashTool, createReadTool, createWriteTool, createEditTool, createGrepTool, createFindTool, createLsTool, SessionManager, SettingsManager, DefaultResourceLoader, getAgentDir } from '@mariozechner/pi-coding-agent';
import { stepfunModels } from '/Users/kifir/projects/agents/pi-poorman-providers/stepfun.ts';
import { parseArgs } from 'util';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

const TASKS = [
  {
    id: 'refactor-function',
    setup: {
      file: '/tmp/bm3-task1/messy.js',
      content: [
        '// messy.js - needs refactoring',
        'function processData(d) {',
        '  var r = [];',
        '  for (var i = 0; i < d.length; i++) {',
        '    if (d[i].active == true) {',
        '      var item = {};',
        '      item.name = d[i].name;',
        '      item.val = d[i].value * 2;',
        '      if (item.val > 100) {',
        '        item.category = "high";',
        '      } else {',
        '        item.category = "low";',
        '      }',
        '      r.push(item);',
        '    }',
        '  }',
        '  return r;',
        '}',
        '',
        'module.exports = { processData };',
        '',
      ].join('\n'),
    },
    prompt: 'Refactor /tmp/bm3-task1/messy.js: use modern JS (const/let, arrow functions, filter/map), extract the category logic into a named function, add JSDoc. Run "node -c /tmp/bm3-task1/messy.js" to verify syntax.',
    verify: (toolCalls, text) => {
      const fixed = toolCalls.some(t => ['write', 'edit'].includes(t.tool) && /messy\.js/.test(t.args?.path || ''));
      const modern = /const |let |=> |filter|map/.test(text);
      const jsdoc = /\/\*\*|\*\//.test(text);
      return { fixed, modern, jsdoc, score: (fixed ? 40 : 0) + (modern ? 30 : 0) + (jsdoc ? 30 : 0) };
    },
  },
  {
    id: 'add-error-handling',
    setup: {
      file: '/tmp/bm3-task2/api.js',
      content: [
        '// api.js - needs error handling',
        'const express = require("express");',
        'const app = express();',
        '',
        'app.get("/users/:id", (req, res) => {',
        '  const user = database.findUser(req.params.id);',
        '  res.json(user);',
        '});',
        '',
        'app.post("/users", (req, res) => {',
        '  const user = database.createUser(req.body);',
        '  res.status(201).json(user);',
        '});',
        '',
        'app.listen(3000);',
        '',
      ].join('\n'),
    },
    prompt: 'Add proper error handling to /tmp/bm3-task2/api.js: wrap handlers in try/catch, return 404 for missing users, validate POST body, return 500 for server errors. Run "node -c /tmp/bm3-task2/api.js" to verify.',
    verify: (toolCalls, text) => {
      const fixed = toolCalls.some(t => ['write', 'edit'].includes(t.tool) && /api\.js/.test(t.args?.path || ''));
      const tryCatch = /try\s*\{|catch\s*\(/.test(text);
      const status404 = /404|not found/i.test(text);
      const status500 = /500|server error/i.test(text);
      return { fixed, tryCatch, status404, status500, score: (fixed ? 40 : 0) + (tryCatch ? 20 : 0) + (status404 ? 20 : 0) + (status500 ? 20 : 0) };
    },
  },
  {
    id: 'write-tests',
    setup: {
      file: '/tmp/bm3-task3/stringUtils.js',
      content: [
        '// stringUtils.js - write tests for this',
        'function capitalize(str) {',
        '  if (!str || typeof str !== "string") return "";',
        '  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();',
        '}',
        '',
        'function truncate(str, maxLen) {',
        '  if (!str || str.length <= maxLen) return str;',
        '  return str.slice(0, maxLen - 3) + "...";',
        '}',
        '',
        'function slugify(str) {',
        '  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");',
        '}',
        '',
        'module.exports = { capitalize, truncate, slugify };',
        '',
      ].join('\n'),
    },
    prompt: 'Write a comprehensive test file at /tmp/bm3-task3/stringUtils.test.js for /tmp/bm3-task3/stringUtils.js. Test all 3 functions with normal cases, edge cases (empty string, null, undefined), and boundary conditions. Use Node.js built-in test runner (node --test). Run the tests.',
    verify: (toolCalls, text) => {
      const wrote = toolCalls.some(t => ['write', 'edit'].includes(t.tool) && /stringUtils\.test\.js/.test(t.args?.path || ''));
      const ran = toolCalls.some(t => t.tool === 'bash' && /node --test|node -e/.test(t.args?.command || ''));
      const edgeCases = /null|undefined|empty|edge|boundary/i.test(text);
      return { wrote, ran, edgeCases, score: (wrote ? 50 : 0) + (ran ? 30 : 0) + (edgeCases ? 20 : 0) };
    },
  },
  {
    id: 'debug-performance',
    setup: {
      file: '/tmp/bm3-task4/search.js',
      content: [
        '// search.js - has O(n²) performance bug',
        'function findMatches(items, criteria) {',
        '  const results = [];',
        '  for (const item of items) {',
        '    for (const key of Object.keys(criteria)) {',
        '      if (item[key] === criteria[key]) {',
        '        // Bug: checks each key separately instead of all-at-once',
        '        if (!results.includes(item)) {',
        '          results.push(item);',
        '        }',
        '      }',
        '    }',
        '  }',
        '  return results;',
        '}',
        '',
        'module.exports = { findMatches };',
        '',
      ].join('\n'),
    },
    prompt: 'Fix the performance bug in /tmp/bm3-task4/search.js. The function uses results.includes(item) which is O(n), making the whole function O(n³). Replace with a Set-based approach. Also fix the logic bug: an item should match ALL criteria keys, not ANY. Run "node -e \'const {findMatches} = require(\'/tmp/bm3-task4/search.js\'); console.log(findMatches([{a:1,b:2},{a:1,b:3}], {a:1}))\' to verify.',
    verify: (toolCalls, text) => {
      const fixed = toolCalls.some(t => ['write', 'edit'].includes(t.tool) && /search\.js/.test(t.args?.path || ''));
      const setBased = /Set|set/i.test(text);
      const logicFix = /all.*criteria|every|match.*all/i.test(text);
      return { fixed, setBased, logicFix, score: (fixed ? 50 : 0) + (setBased ? 25 : 0) + (logicFix ? 25 : 0) };
    },
  },
  {
    id: 'implement-feature',
    setup: {
      file: '/tmp/bm3-task5/cache.js',
      content: [
        '// cache.js - implement a TTL cache per the spec below',
        '// Spec:',
        '// - class TTLCache with constructor(maxSize, defaultTtlMs)',
        '// - get(key): returns undefined if expired or missing',
        '// - set(key, value, ttlMs?): stores with optional custom TTL',
        '// - delete(key): removes entry, returns true if existed',
        '// - clear(): removes all entries',
        '// - size: getter for current entry count',
        '// - Eviction: when full, remove oldest entry (FIFO)',
        '// - Auto-expire: entries checked on access (lazy cleanup)',
        '',
      ].join('\n'),
    },
    prompt: 'Implement the TTLCache class in /tmp/bm3-task5/cache.js per the spec in the file comments. Write clean, well-documented code. Then run: "node -e \'const {TTLCache} = require(\'/tmp/bm3-task5/cache.js\'); const c = new TTLCache(3, 1000); c.set(\"a\",1); console.log(c.get(\"a\")); console.log(c.size);\' to verify.',
    verify: (toolCalls, text) => {
      const wrote = toolCalls.some(t => ['write', 'edit'].includes(t.tool) && /cache\.js/.test(t.args?.path || ''));
      const ran = toolCalls.some(t => t.tool === 'bash' && /cache/.test(t.args?.command || ''));
      const hasClass = /class TTLCache/.test(text);
      const hasMethods = /get\s*\(|set\s*\(|delete\s*\(|clear\s*\(/.test(text);
      return { wrote, ran, hasClass, hasMethods, score: (wrote ? 40 : 0) + (ran ? 20 : 0) + (hasClass ? 20 : 0) + (hasMethods ? 20 : 0) };
    },
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

async function runTask(task, modelConfig, timeout = 120) {
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
      model: { type: 'string', default: 'step-3.5-flash' },
      timeout: { type: 'string', default: '120' },
      output: { type: 'string' },
    },
  });

  const modelCfg = {
    ...stepfunModels.find(m => m.id === values.model),
    provider: 'stepfun', api: 'openai-completions',
    baseUrl: 'https://api.stepfun.ai/step_plan/v1',
  };

  console.log('=== BM3 Real-World Tasks Benchmark (SDK) ===');
  console.log('Model: stepfun/' + values.model + ' | Tasks: ' + TASKS.length + ' | Timeout: ' + values.timeout + 's\n');

  const allResults = [];
  const timeout = parseInt(values.timeout);

  for (const task of TASKS) {
    console.log('[' + task.id + ']... ');
    const r = await runTask(task, modelCfg, timeout);
    allResults.push(r);
    const status = r.error === 'timeout' ? 'T' : r.success ? 'P' : 'F';
    console.log(status + ' ' + r.durationSeconds.toFixed(1) + 's / ' + r.turns + 't / score=' + r.score + '/100');
  }

  console.log('\n=== Results ===');
  let totalScore = 0;
  console.log('| Task | Score | Turns | Duration |');
  console.log('|------|-------|-------|----------|');
  for (const r of allResults) {
    totalScore += r.score;
    console.log('| ' + r.taskId + ' | ' + r.score + '/100 | ' + r.turns + ' | ' + r.durationSeconds.toFixed(1) + 's |');
  }
  console.log('\nOverall: ' + (totalScore / allResults.length).toFixed(1) + '/100');

  if (values.output) {
    const outDir = values.output.replace(/\/[^/]+$/, '');
    if (outDir && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(values.output, JSON.stringify(allResults, null, 2));
    console.log('Saved to ' + values.output);
  }
  return allResults;
}

if (typeof process.send !== 'function' && process.argv[1] && process.argv[1].includes('bm3-sdk.mjs')) {
  main().then(() => process.exit(0)).catch((err) => { console.error('BM3 failed:', err); process.exit(1); });
}
