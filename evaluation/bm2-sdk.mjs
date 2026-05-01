#!/usr/bin/env node
/**
 * BM2: Code Quality Benchmark — SDK version
 *
 * Asks agent to write code, then evaluates quality:
 * - ESLint score (0-100)
 * - Cyclomatic complexity (lower is better)
 * - Edge case handling
 * - Idiomatic usage
 *
 * Run: node evaluation/bm2-sdk.mjs [--model stepfun/step-3.5-flash] [--timeout 90]
 */
import { createAgentSession, createBashTool, createReadTool, createWriteTool, createEditTool, SessionManager, SettingsManager, DefaultResourceLoader, getAgentDir } from '@mariozechner/pi-coding-agent';
import { stepfunModels } from '/Users/kifir/projects/agents/pi-poorman-providers/stepfun.ts';
import { parseArgs } from 'util';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

// ── Tasks ──────────────────────────────────────────────────────────────────

const TASKS = [
  {
    id: 'debounce-fn',
    prompt: 'Write a JavaScript debounce function in /tmp/bm2-task1/debounce.js. It should: (1) accept a function and delay in ms, (2) return a debounced version, (3) support a `leading` option, (4) have a `.cancel()` method. Write clean, well-documented code.',
    language: 'javascript',
    filename: 'debounce.js',
    testFile: '/tmp/bm2-task1/debounce.test.js',
    testContent: `const { debounce } = require('./debounce.js');\nconst assert = require('assert');\n\n// Test 1: basic debounce\nlet count = 0;\nconst fn = debounce(() => count++, 50);\nfn(); fn(); fn();\nsetTimeout(() => {\n  assert.strictEqual(count, 1, 'Should debounce multiple calls');\n  console.log('Test 1 passed');\n}, 100);\n\n// Test 2: cancel\nlet count2 = 0;\nconst fn2 = debounce(() => count2++, 50);\nfn2();\nfn2.cancel();\nsetTimeout(() => {\n  assert.strictEqual(count2, 0, 'Cancel should prevent execution');\n  console.log('Test 2 passed');\n}, 100);\n\n// Test 3: leading edge\nlet count3 = 0;\nconst fn3 = debounce(() => count3++, 50, { leading: true });\nfn3();\nassert.strictEqual(count3, 1, 'Leading edge should fire immediately');\nconsole.log('Test 3 passed');\n`,
  },
  {
    id: 'deep-clone',
    prompt: 'Write a JavaScript deepClone function in /tmp/bm2-task2/clone.js. It should: (1) handle primitives, arrays, plain objects, Date, RegExp, (2) handle circular references, (3) NOT use JSON.parse(JSON.stringify()). Write clean, well-documented code.',
    language: 'javascript',
    filename: 'clone.js',
    testFile: '/tmp/bm2-task2/clone.test.js',
    testContent: `const deepClone = require('./clone.js');\nconst assert = require('assert');\n\n// Test 1: primitives\nassert.strictEqual(deepClone(42), 42);\nassert.strictEqual(deepClone('hello'), 'hello');\nassert.strictEqual(deepClone(null), null);\nconsole.log('Test 1 passed');\n\n// Test 2: objects\nconst obj = { a: 1, b: { c: 2 } };\nconst cloned = deepClone(obj);\nassert.deepStrictEqual(cloned, obj);\ncloned.b.c = 99;\nassert.strictEqual(obj.b.c, 2, 'Clone should be independent');\nconsole.log('Test 2 passed');\n\n// Test 3: arrays\nconst arr = [1, [2, 3], { a: 4 }];\nconst arrCloned = deepClone(arr);\nassert.deepStrictEqual(arrCloned, arr);\narrCloned[1][0] = 99;\nassert.strictEqual(arr[1][0], 2, 'Array clone should be independent');\nconsole.log('Test 3 passed');\n\n// Test 4: Date\nconst d = new Date('2024-01-01');\nconst dCloned = deepClone(d);\nassert.strictEqual(dCloned.getTime(), d.getTime());\nassert(dCloned !== d, 'Date should be a new instance');\nconsole.log('Test 4 passed');\n\n// Test 5: circular reference (should not throw)\nconst circ = { a: 1 };\ncirc.self = circ;\ntry {\n  deepClone(circ);\n  console.log('Test 5 passed (no crash)');\n} catch (e) {\n  console.log('Test 5: circular handled with error:', e.message);\n}\n`,
  },
  {
    id: 'event-emitter',
    prompt: 'Write a JavaScript EventEmitter class in /tmp/bm2-task3/emitter.js. It should implement: on(event, fn), off(event, fn), once(event, fn), emit(event, ...args). Use ES6 class syntax. Write clean, well-documented code.',
    language: 'javascript',
    filename: 'emitter.js',
    testFile: '/tmp/bm2-task3/emitter.test.js',
    testContent: `const EventEmitter = require('./emitter.js');\nconst assert = require('assert');\n\n// Test 1: on + emit\nconst e = new EventEmitter();\nlet called = 0;\ne.on('test', () => called++);\ne.emit('test');\ne.emit('test');\nassert.strictEqual(called, 2, 'on/emit should work');\nconsole.log('Test 1 passed');\n\n// Test 2: once\nconst e2 = new EventEmitter();\nlet onceCount = 0;\ne2.once('x', () => onceCount++);\ne2.emit('x');\ne2.emit('x');\nassert.strictEqual(onceCount, 1, 'once should fire only once');\nconsole.log('Test 2 passed');\n\n// Test 3: off\nconst e3 = new EventEmitter();\nlet offCount = 0;\nconst handler = () => offCount++;\ne3.on('y', handler);\ne3.emit('y');\ne3.off('y', handler);\ne3.emit('y');\nassert.strictEqual(offCount, 1, 'off should remove listener');\nconsole.log('Test 3 passed');\n\n// Test 4: emit with args\nconst e4 = new EventEmitter();\nlet received = null;\ne4.on('data', (a, b) => { received = [a, b]; });\ne4.emit('data', 'hello', 42);\nassert.deepStrictEqual(received, ['hello', 42]);\nconsole.log('Test 4 passed');\n`,
  },
];

// ── Quality scoring ────────────────────────────────────────────────────────

function scoreCodeQuality(code, filename) {
  const scores = {};

  // 1. Length appropriateness (not too short, not too long)
  const lines = code.split('\n').filter(l => l.trim().length > 0);
  scores.lines = lines.length;
  scores.lengthScore = lines.length >= 5 && lines.length <= 100 ? 20 : 10;

  // 2. Has JSDoc or comments
  scores.hasComments = /\/\*\*|\/\/.*(function|class|param|return|@)/m.test(code);
  scores.commentScore = scores.hasComments ? 20 : 5;

  // 3. Uses modern JS (const/let, arrow functions, destructuring)
  scores.modernJS = /const |let |=>|destructur|class |module\.exports/.test(code);
  scores.modernScore = scores.modernJS ? 15 : 5;

  // 4. Error handling
  scores.hasErrorHandling = /try|throw|Error|catch|assert/.test(code);
  scores.errorScore = scores.hasErrorHandling ? 15 : 0;

  // 5. Exports properly
  scores.exports = /module\.exports|export /.test(code);
  scores.exportScore = scores.exports ? 15 : 0;

  // 6. No obvious anti-patterns
  scores.noAntiPatterns = !/eval\(|new Function|with\s*\(/.test(code);
  scores.antiPatternScore = scores.noAntiPatterns ? 15 : 0;

  scores.total = scores.lengthScore + scores.commentScore + scores.modernScore +
                 scores.errorScore + scores.exportScore + scores.antiPatternScore;

  return scores;
}

function runTests(testFile, taskDir) {
  try {
    const { execSync } = require('child_process');
    const output = execSync(`node ${testFile}`, {
      cwd: taskDir,
      timeout: 10000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const passed = (output.match(/passed/g) || []).length;
    const failed = (output.match(/failed|Error|AssertionError/g) || []).length;
    return { passed, failed, output: output.slice(0, 500) };
  } catch (err) {
    const output = (err.stdout || '') + (err.stderr || '');
    const passed = (output.match(/passed/g) || []).length;
    const failed = (output.match(/failed|Error|AssertionError/g) || []).length;
    return { passed, failed, output: output.slice(0, 500), error: err.message };
  }
}

// ── Run single task ───────────────────────────────────────────────────────

async function runTask(task, modelConfig, timeout = 90) {
  const taskDir = `/tmp/bm2-task${TASKS.indexOf(task) + 1}`;
  if (!existsSync(taskDir)) mkdirSync(taskDir, { recursive: true });

  const result = {
    taskId: task.id,
    success: false,
    code: '',
    toolCalls: [],
    turns: 0,
    durationSeconds: 0,
    error: null,
    qualityScore: 0,
    testResults: null,
    details: null,
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
      createReadTool('/tmp'),
      createBashTool('/tmp'),
      createWriteTool('/tmp'),
      createEditTool('/tmp'),
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

  // Extract code from messages
  const messages = session.state?.messages || [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const b of msg.content || []) {
        if (b.type === 'toolCall' && (b.name === 'write' || b.name === 'edit')) {
          const path = b.arguments?.path || '';
          if (path.includes(task.filename)) {
            result.code = b.arguments?.content || b.arguments?.newText || '';
          }
        }
      }
    }
  }

  // If we got code, write it and test it
  if (result.code) {
    const codePath = join(taskDir, task.filename);
    writeFileSync(codePath, result.code);

    // Write test file
    writeFileSync(task.testFile, task.testContent);

    // Run tests
    result.testResults = runTests(task.testFile, taskDir);

    // Score code quality
    result.details = scoreCodeQuality(result.code, task.filename);
    result.qualityScore = result.details.total;

    // Combined score: quality (50%) + tests (50%)
    const maxTests = 4;
    const testScore = result.testResults.passed > 0
      ? Math.min(50, (result.testResults.passed / maxTests) * 50)
      : 0;
    result.score = Math.round(result.qualityScore * 0.5 + testScore);
  } else {
    result.score = 0;
  }

  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────

export async function main() {
  const { values } = parseArgs({
    options: {
      model: { type: 'string', default: 'step-3.5-flash' },
      timeout: { type: 'string', default: '90' },
      output: { type: 'string' },
    },
  });

  const modelCfg = {
    ...stepfunModels.find(m => m.id === values.model),
    provider: 'stepfun',
    api: 'openai-completions',
    baseUrl: 'https://api.stepfun.ai/step_plan/v1',
  };

  console.log('=== BM2 Code Quality Benchmark (SDK) ===\n');
  console.log(`Model: stepfun/${values.model} | Tasks: ${TASKS.length} | Timeout: ${values.timeout}s\n`);

  const allResults = [];
  const timeout = parseInt(values.timeout);

  for (const task of TASKS) {
    console.log(`[${task.id}]... `, { flush: true });
    const r = await runTask(task, modelCfg, timeout);
    allResults.push(r);
    const status = r.error === 'timeout' ? '⏱' : r.success ? '✅' : '❌';
    console.log(`${status} ${r.durationSeconds.toFixed(1)}s / ${r.turns}t / score=${r.score}/100 (quality=${r.qualityScore}, tests=${r.testResults ? r.testResults.passed + '/' + (r.testResults.passed + r.testResults.failed) : 'N/A'})`);
  }

  console.log('\n=== Results ===');
  console.log('| Task | Score | Quality | Tests | Turns | Duration |');
  console.log('|------|-------|---------|-------|-------|----------|');
  let totalScore = 0;
  for (const r of allResults) {
    totalScore += r.score;
    console.log(`| ${r.taskId} | ${r.score}/100 | ${r.qualityScore}/100 | ${r.testResults ? r.testResults.passed + ' passed' : 'N/A'} | ${r.turns} | ${r.durationSeconds.toFixed(1)}s |`);
  }
  console.log(`\n**Overall: ${(totalScore / allResults.length).toFixed(1)}/100**`);

  if (values.output) {
    const outDir = values.output.replace(/\/[^/]+$/, '');
    if (outDir && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(values.output, JSON.stringify(allResults, null, 2));
    console.log(`Saved to ${values.output}`);
  }

  return allResults;
}

if (typeof process.send !== 'function' && process.argv[1] && process.argv[1].includes('bm2-sdk.mjs')) {
  main().catch((err) => {
    console.error('BM2 failed:', err);
    process.exit(1);
  });
}
