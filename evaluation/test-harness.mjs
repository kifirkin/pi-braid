#!/usr/bin/env node
/**
 * pi-braid JS Test Harness
 * =========================
 * Node.js test harness for pi-braid agent evaluation.
 *
 * pi 0.69.0 Event Protocol:
 * - message_update: streaming tokens via assistantMessageEvent (type: text_delta, text_end, thinking_delta, thinking_end)
 * - message_end: final accumulated content array
 * - tool_execution_start/end: tool calls
 * - agent_end: completion
 * - extension_ui_request: cancel to stay focused
 *
 * Usage:
 *   PI_MODEL=step-3.5-flash-2603 PI_PROVIDER=stepfun node test-harness.mjs --trials 1 --task flatten_deep
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createInterface } from "node:readline";

// ── Configuration ──────────────────────────────────────────────────────────────

const PI_BRAID = process.env.PI_BRAID || "/Users/kifir/projects/agents/pi-braid";
const DEFAULT_MODEL = process.env.PI_MODEL || "step-3.5-flash-2603";
const DEFAULT_PROVIDER = process.env.PI_PROVIDER || "stepfun";
const DEFAULT_TRIALS = 3;
const DEFAULT_TIMEOUT = 60; // seconds per trial

// ── Task Definitions ─────────────────────────────────────────────────────────

const TASKS = [
  {
    id: "flatten_deep",
    name: "Flatten Deep",
    prompt: `Implement \`flattenDeep(arr)\` that recursively flattens nested arrays.

Example: flattenDeep([1,[2,[3]],4]) == [1,2,3,4]

Provide only the function in a JavaScript code block. No test cases, no main.`,
    test: `const assert = require('assert');
assert.deepStrictEqual(flattenDeep([1,[2,[3]],4]), [1,2,3,4]);
assert.deepStrictEqual(flattenDeep([[[[5]]]]), [5]);
assert.deepStrictEqual(flattenDeep([]), []);
assert.deepStrictEqual(flattenDeep([1,2,3]), [1,2,3]);
assert.deepStrictEqual(flattenDeep([1,[2,3],[4,[5,6]]]), [1,2,3,4,5,6]);
console.log("ALL PASSED");`,
  },
  {
    id: "debounce",
    name: "Debounce",
    prompt: `Implement \`debounce(fn, delay)\` that returns a debounced function.

Example:
  const d = debounce(console.log, 100);
  d('a'); d('b');
  // after 100ms, only 'b' is logged

Provide only the function in a JavaScript code block. No test cases, no main.`,
    test: `const assert = require('assert');
let calls = [];
const d = debounce((x) => calls.push(x), 50);
d(1); d(2); d(3);
await new Promise(r => setTimeout(r, 150));
assert.deepStrictEqual(calls, [3]);
console.log("ALL PASSED");`,
  },
  {
    id: "deep_clone",
    name: "Deep Clone",
    prompt: `Implement \`deepClone(obj)\` that creates a deep copy of a plain object/array.

Handles: nested objects, arrays, primitives, null.
Does NOT need to handle: circular refs, Date, Map, Set, RegExp, functions.

Provide only the function in a JavaScript code block. No test cases, no main.`,
    test: `const assert = require('assert');
const a = { x: 1, y: { z: [2, 3] } };
const b = deepClone(a);
assert.notStrictEqual(a, b);
assert.notStrictEqual(a.y, b.y);
assert.notStrictEqual(a.y.z, b.y.z);
assert.deepStrictEqual(a, b);
b.y.z.push(4);
assert.deepStrictEqual(a.y.z, [2, 3]);
console.log("ALL PASSED");`,
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeEvent(type, extra = {}) {
  return JSON.stringify({ type, ...extra }) + "\n";
}

/**
 * Extract code from markdown-fenced text.
 * Handles: ```js, ```javascript, ``` (any), with or without trailing newline.
 * NOTE: Does NOT handle backtick-escaped strings inside code (rare in LLM output).
 */
function extractCode(text) {
  if (!text) return null;
  // Try js/javascript tagged block first
  let m = text.match(/```(?:js|javascript)\s*\n([\s\S]*?)\n```(?:\s*(?:\n|$))/i);
  if (m) return m[1].trim();
  // Fallback: any fenced block
  m = text.match(/```\s*\n([\s\S]*?)\n```(?:\s*(?:\n|$))/);
  if (m) return m[1].trim();
  // Last resort: just the raw text if it looks like code
  return text.trim();
}

/**
 * Execute candidate code + test in an isolated Node process.
 * Returns { success, stdout, stderr, exitCode }.
 */
async function executeCode(code, testCode, timeoutMs = 10000) {
  const dir = mkdtempSync(join(tmpdir(), "pi-braid-test-"));
  const testFile = join(dir, "test.js");

  // Wrap test in async IIFE if it contains await
  const isAsync = testCode.includes("await");
  const testBody = isAsync
    ? `(async () => {\n${testCode}\n})();`
    : testCode;

  writeFileSync(testFile, `${code}\n\n${testBody}\n`);

  return new Promise((resolve) => {
    const proc = spawn("node", [testFile], {
      timeout: timeoutMs,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("exit", (code) => {
      rmSync(dir, { recursive: true, force: true });
      resolve({
        success: code === 0 && stdout.includes("ALL PASSED"),
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code,
      });
    });

    proc.on("error", (err) => {
      rmSync(dir, { recursive: true, force: true });
      resolve({ success: false, stdout, stderr: err.message, exitCode: -1 });
    });
  });
}

// ── pi RPC Wrapper ────────────────────────────────────────────────────────────

class PiRPC {
  constructor({ model = DEFAULT_MODEL, provider = DEFAULT_PROVIDER, extensions = PI_BRAID, noExtensions = false, tools = null } = {}) {
    this.args = [
      "pi",
      "--mode", "rpc",
      "--no-session",
      "--provider", provider,
      "--model", model,
    ];
    if (noExtensions) {
      this.args.push("--no-extensions");
    } else if (extensions) {
      this.args.push("-e", extensions);
    }
    if (tools) {
      this.args.push("--tools", tools);
    }
    this.proc = null;
    this.rl = null;
  }

  async start(startupDelayMs = 2000) {
    this.proc = spawn(this.args[0], this.args.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.rl = createInterface({
      input: this.proc.stdout,
      crlfDelay: Infinity,
    });

    await sleep(startupDelayMs);

    if (this.proc.exitCode !== null) {
      const err = await new Promise((resolve) => {
        let data = "";
        this.proc.stderr.on("data", (d) => { data += d.toString(); });
        setTimeout(() => resolve(data), 500);
      });
      throw new Error(`pi process exited early (code ${this.proc.exitCode}): ${err}`);
    }
  }

  stop() {
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
    }
    if (this.rl) {
      this.rl.close();
    }
  }

  send(event) {
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.write(event);
    }
  }

  /**
   * Run a single task and collect structured results.
   */
  async runTask(prompt, { timeoutSec = DEFAULT_TIMEOUT, cancelExtensions = true } = {}) {
    const result = {
      success: false,
      finalText: "",
      code: null,
      codeOk: false,
      toolCalls: [],
      tokens: 0,
      turns: 0,
      duration: 0,
      error: null,
    };

    await this.start();
    const startTime = Date.now();

    try {
      this.send(makeEvent("prompt", { message: prompt }));

      const timer = setTimeout(() => {
        result.error = "timeout";
        this.stop();
      }, timeoutSec * 1000);

      for await (const line of this.rl) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        const etype = event.type;

        if (etype === "extension_ui_request" && cancelExtensions) {
          this.send(makeEvent("extension_ui_response", { id: event.id, cancelled: true }));
        }

        if (etype === "tool_execution_start" || etype === "tool_execution_end") {
          result.toolCalls.push({
            type: etype,
            tool: event.toolName || "unknown",
            toolCallId: event.toolCallId || "",
            error: event.isError || false,
          });
        }

        if (etype === "message_end") {
          result.turns++;
          const content = event.message?.content || [];
          for (const block of content) {
            if (block.type === "text") {
              result.finalText += block.text || "";
            }
          }
        }

        if (etype === "agent_end") {
          result.success = true;
          clearTimeout(timer);
          break;
        }

        if (result.error === "timeout") {
          clearTimeout(timer);
          break;
        }
      }

      clearTimeout(timer);
    } catch (e) {
      result.error = e.message;
    } finally {
      this.stop();
      result.duration = Date.now() - startTime;
    }

    return result;
  }
}

// ── Trial Runner ──────────────────────────────────────────────────────────────

async function runTrial(task, opts) {
  console.log(`\n[Task: ${task.name}] Starting...`);

  const rpc = new PiRPC(opts);
  const result = await rpc.runTask(task.prompt, { timeoutSec: opts.timeout });

  // Extract code from response
  result.code = extractCode(result.finalText);

  // Execute test if code was extracted
  if (result.code) {
    const execResult = await executeCode(result.code, task.test);
    result.codeOk = execResult.success;
    result.execStdout = execResult.stdout;
    result.execStderr = execResult.stderr;
    result.execExitCode = execResult.exitCode;
  } else {
    result.execStderr = "No code block found in response";
  }

  return result;
}

// ── CLI & Main ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    model: DEFAULT_MODEL,
    provider: DEFAULT_PROVIDER,
    extensions: PI_BRAID,
    noExtensions: false,
    trials: DEFAULT_TRIALS,
    timeout: DEFAULT_TIMEOUT,
    taskIds: [],
    outputDir: join(PI_BRAID, "evaluation", "results"),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--model":
        opts.model = args[++i];
        break;
      case "--provider":
        opts.provider = args[++i];
        break;
      case "--extensions":
        opts.extensions = args[++i];
        break;
      case "--no-extensions":
        opts.noExtensions = true;
        opts.extensions = null;
        break;
      case "--trials":
        opts.trials = parseInt(args[++i], 10) || DEFAULT_TRIALS;
        break;
      case "--timeout":
        opts.timeout = parseInt(args[++i], 10) || DEFAULT_TIMEOUT;
        break;
      case "--task":
        opts.taskIds.push(args[++i]);
        break;
      case "--output-dir":
        opts.outputDir = args[++i];
        break;
      case "--help":
      case "-h":
        console.log(`Usage: node test-harness.mjs [options]

Options:
  --model <model>          Model to use (default: ${DEFAULT_MODEL})
  --provider <provider>    Provider to use (default: ${DEFAULT_PROVIDER})
  --extensions <path>      Extension path (default: ${PI_BRAID})
  --no-extensions          Run without extensions (baseline)
  --trials <n>             Number of trials per task (default: ${DEFAULT_TRIALS})
  --timeout <sec>          Timeout per trial in seconds (default: ${DEFAULT_TIMEOUT})
  --task <id>              Run only this task (repeatable)
  --output-dir <path>      Where to write results
  -h, --help               Show this help

Tasks: ${TASKS.map(t => t.id).join(", ")}`);
        process.exit(0);
      default:
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
    }
  }

  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);

  const tasks = opts.taskIds.length > 0
    ? TASKS.filter(t => opts.taskIds.includes(t.id))
    : TASKS;

  if (tasks.length === 0) {
    console.error("No matching tasks found.");
    process.exit(1);
  }

  console.log(`\n=== pi-braid Test Harness ===`);
  console.log(`Model:    ${opts.model}`);
  console.log(`Provider: ${opts.provider}`);
  console.log(`Extensions: ${opts.noExtensions ? "none" : opts.extensions}`);
  console.log(`Trials:   ${opts.trials}`);
  console.log(`Timeout:  ${opts.timeout}s`);
  console.log(`Tasks:    ${tasks.map(t => t.id).join(", ")}\n`);

  const allResults = [];

  for (const task of tasks) {
    for (let trial = 0; trial < opts.trials; trial++) {
      const result = await runTrial(task, opts);
      allResults.push({
        taskId: task.id,
        trial,
        success: result.success,
        codeOk: result.codeOk,
        duration: result.duration,
        tokens: result.tokens,
        turns: result.turns,
        tools: result.toolCalls.map(t => t.tool),
        error: result.error || (result.codeOk ? null : result.execStderr),
        code: result.code,
      });

      const status = result.codeOk ? "✅ PASS" : result.error ? "⏱️ TIMEOUT" : "❌ FAIL";
      console.log(`  Trial ${trial + 1}/${opts.trials}: ${status} (${result.duration}ms, ${result.turns} turns)`);

      // Small delay between trials
      if (trial < opts.trials - 1) {
        await sleep(1000);
      }
    }
  }

  // Summary
  console.log(`\n=== Results ===`);
  for (const task of tasks) {
    const taskResults = allResults.filter(r => r.taskId === task.id);
    const passCount = taskResults.filter(r => r.codeOk).length;
    console.log(`${task.name}: ${passCount}/${opts.trials} passed`);
  }

  // Write results
  if (!existsSync(opts.outputDir)) {
    mkdirSync(opts.outputDir, { recursive: true });
  }
  const outFile = join(opts.outputDir, `js-test-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(outFile, JSON.stringify(allResults, null, 2));
  console.log(`\nResults written to: ${outFile}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
