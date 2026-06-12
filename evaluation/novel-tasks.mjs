/**
 * Tier 3 Novel Tasks - pi-braid Benchmark
 *
 * VAR-MATH-inspired: genuinely unseen problems that require novel
 * tool combinations and cross-file understanding.
 *
 * These tasks CANNOT be solved by memorization - they test:
 * - Cross-file dependency inference
 * - Novel tool combinations
 * - Hidden constraint discovery
 * - Reverse engineering from outputs
 */

import { mkdirSync, writeFileSync } from "fs";

// ── Helpers ────────────────────────────────────────────────────────────────

function setup(task) {
  const dir = task.setup.file.replace(/\/[^/]+$/, "");
  mkdirSync(dir, { recursive: true });
  for (const entry of task.setup.files || []) {
    mkdirSync(entry.file.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(entry.file, entry.content);
  }
}

// ── Task 1: Cross-File Dependency Repair ──────────────────────────────────

const TASK1 = {
  id: "t3-cross-file-deps",
  name: "Cross-File Dependency Repair",
  difficulty: "hard",
  setup: {
    file: "/tmp/bm1-task-t3/deps/main.ts",
    files: [
      {
        file: "/tmp/bm1-task-t3/deps/main.ts",
        content: `import { processItem } from "./utils/helpers";
import { Config } from "./config";
import { writeReport } from "./report/writer";

const config: Config = { threshold: 0.5 };
const items = config.items?.length ? config.items : [1, 2, 3];
const results = items.map(processItem);
writeReport(results);
console.log("Done");
`,
      },
      {
        file: "/tmp/bm1-task-t3/deps/utils/helpers.ts",
        content: `export function processItem(n: number): number {
  if (n < 0) throw new Error("negative");
  return n * 2;
}

export function chacheResult(key: string, val: unknown): void {
  // Should be "cache" - but this file isn't the bug
  localStorage.setItem(key, JSON.stringify(val));
}
`,
      },
      {
        file: "/tmp/bm1-task-t3/deps/config.ts",
        content: `export interface Config {
  threshold: number;
  items?: number[];
}

// TODO: enable items when ready
`,
      },
      {
        file: "/tmp/bm1-task-t3/deps/report/writer.ts",
        content: `import { Config } from "../config";

export function writeReport(data: number[]): void {
  console.log(\`Report: \${data.length} items processed\`);
  if (data.length === 0) console.log("WARNING: empty report");
}

export function formatHeader(): string {
  return "=".repeat(40);
}
`,
      },
    ],
  },
  prompt: `Fix the cross-file dependency bug in /tmp/bm1-task-t3/deps/main.ts.

The program compiles but produces no output. The bug is NOT a syntax error - it's a logic error spread across multiple files. One file has a missing export, another has an incomplete configuration.

Diagnosis approach:
1. Read all files in the deps/ directory
2. Trace the execution flow: main.ts → helpers.ts → config.ts → report/writer.ts
3. Find why no items are processed
4. Fix the root cause (not the symptoms)

Verify with: "node --loader ts-node/esm /tmp/bm1-task-t3/deps/main.ts" prints "Done" with output.

IMPORTANT: Don't add features. Don't rewrite files that aren't broken. Fix only the root cause.`,
  verify: (toolCalls, text) => {
    const fixedMain = toolCalls.some(t => /main\.ts/.test(t.args?.path || ""));
    const fixedConfig = toolCalls.some(t => /config\.ts/.test(t.args?.path || ""));
    const mentioned = /export|config|import|items|threshold|cross.*file|depend|inter-file/i.test(text);
    const wrote = toolCalls.filter(t => ["write", "edit"].includes(t.tool));
    return {
      fixedMain, fixedConfig, mentioned,
      // Penalize if they modified files that weren't broken
      overModified: wrote.length > 2,
      score: (fixedConfig ? 50 : 0) + (mentioned ? 30 : 0) + (fixedMain ? 20 : 0),
    };
  },
};

// ── Task 2: Hidden Constraint Discovery ──────────────────────────────────

const TASK2 = {
  id: "t3-hidden-constraint",
  name: "Hidden Constraint Discovery",
  difficulty: "hard",
  setup: {
    file: "/tmp/bm1-task-t3/constraints/validate.ts",
    files: [
      {
        file: "/tmp/bm1-task-t3/constraints/validate.ts",
        content: `// Input validation pipeline
// Each function returns { valid: boolean, error?: string }

function validateLength(input: string): { valid: boolean; error?: string } {
  if (input.length < 3) return { valid: false, error: "too short" };
  if (input.length > 100) return { valid: false, error: "too long" };
  return { valid: true };
}

function validateChars(input: string): { valid: boolean; error?: string } {
  if (!/^[a-zA-Z0-9_]+$/.test(input)) return { valid: false, error: "invalid chars" };
  return { valid: true };
}

function validateUniqueness(input: string, history: string[]): { valid: boolean; error?: string } {
  if (history.includes(input)) return { valid: false, error: "duplicate" };
  return { valid: true };
}

function checkReserved(input: string): { valid: boolean; error?: string } {
  const reserved = ["admin", "root", "system"];
  if (reserved.includes(input.toLowerCase())) {
    return { valid: false, error: "reserved name" };
  }
  return { valid: true };
}

// BUG: This function is missing a check
// The system has an undocumented constraint:
// Inputs with even length that start with a vowel MUST be rejected
//   (see /tmp/bm1-task-t3/constraints/docs/spec.md)
export function validate(input: string, history: string[] = []): { valid: boolean; error?: string } {
  const checks = [validateLength, validateChars, checkReserved];
  if (history.length > 0) checks.push((s: string) => validateUniqueness(s, history));
  for (const check of checks) {
    const result = check(input);
    if (!result.valid) return result;
  }
  return { valid: true };
}
`,
      },
      {
        file: "/tmp/bm1-task-t3/constraints/docs/spec.md",
        content: `# Validation Spec (v2.1)

## Documented Rules
- Length: 3-100 characters
- Characters: alphanumeric + underscore only
- No duplicates
- No reserved names

## Undocumented Rule (Section 4.3 - recently added)
Inputs that start with a vowel AND have an even length must be rejected
with error "format violation". This was agreed in the last sprint review.
`,
      },
      {
        file: "/tmp/bm1-task-t3/constraints/test.ts",
        content: `import { validate } from "./validate";

const tests = [
  { input: "abc", expect: true },
  { input: "ab", expect: false },  // too short
  { input: "Admin", expect: false }, // reversed
  { input: "hello", expect: true },
  { input: "ae", expect: false },  // vowel + even length → undocumented rule
  { input: "evenlength", expect: false }, // starts with vowel, even length
  { input: "oddlen", expect: true }, // starts with vowel but odd length
];

for (const t of tests) {
  const result = validate(t.input);
  const pass = result.valid === t.expect;
  console.log(\`\${pass ? "PASS" : "FAIL"}: "\${t.input}" → \${result.valid} (expected \${t.expect})\${result.error ? ": " + result.error : ""}\`);
}
`,
      },
    ],
  },
  prompt: `Fix the bug in /tmp/bm1-task-t3/constraints/validate.ts.

The test suite at /tmp/bm1-task-t3/constraints/test.ts reveals a misssing validation rule. One of the test cases fails because the validate() function doesn't enforce a recently-added constraint.

Steps:
1. Read the specc document in /tmp/bm1-task-t3/constraints/docs/spec.md to find the undocumented rule
2. Read validate.ts to understand the existing validation pipeline
3. Add the missing check to the validate function
4. Run "node /tmp/bm1-task-t3/constraints/test.ts" to verify all tests pass

IMPORTANT: Find the hidden constraint FIRST by reading the spec. Don't guess.`,
  verify: (toolCalls, text) => {
    const readSpec = toolCalls.some(t => t.tool === "read" && /spec\.md/.test(t.args?.path || ""));
    const fixed = toolCalls.some(t => ["write", "edit"].includes(t.tool) && /validate\.ts/.test(t.args?.path || ""));
    const mentioned = /vowel|even.*length|format.*violation|undocumented|hidden|spec/i.test(text);
    const ranTest = toolCalls.some(t => t.tool === "bash" && /test\.ts/.test(t.args?.command || ""));
    return {
      readSpec, fixed, mentioned, ranTest,
      score: (readSpec ? 25 : 0) + (fixed ? 35 : 0) + (mentioned ? 25 : 0) + (ranTest ? 15 : 0),
    };
  },
};

// ── Task 3: Reverse Engineering From Output ─────────────────────────────

const TASK3 = {
  id: "t3-reverse-engineer",
  name: "Reverse Engineer Output Format",
  difficulty: "medium",
  setup: {
    file: "/tmp/bm1-task-t3/reverse/format.ts",
    files: [
      {
        file: "/tmp/bm1-task-t3/reverse/format.ts",
        content: `// Output formatter
// BUG: The format is wrong. Expected output is:
//   [DATA] name=Alice,age=30,email=alice@test.com
//   [DATA] name=Bob,age=25,email=bob@test.com
//
// Current (wrong) output:
//   [DATA] Alice, 30, alice@test.com
//   [DATA] Bob, 25, bob@test.com

interface User {
  name: string;
  age: number;
  email: string;
}

function formatUser(user: User): string {
  return \`\${user.name}, \${user.age}, \${user.email}\`;
}

export function formatUsers(users: User[]): string[] {
  return users.map(u => "[DATA] " + formatUser(u));
}
`,
      },
      {
        file: "/tmp/bm1-task-t3/reverse/expected.txt",
        content: `[DATA] name=Alice,age=30,email=alice@test.com
[DATA] name=Bob,age=25,email=bob@test.com
`,
      },
      {
        file: "/tmp/bm1-task-t3/reverse/runner.ts",
        content: `import { formatUsers } from "./format";

const users = [
  { name: "Alice", age: 30, email: "alice@test.com" },
  { name: "Bob", age: 25, email: "bob@test.com" },
];

const result = formatUsers(users);
console.log(result.join("\\n"));

// Verify
const expected = "[DATA] name=Alice,age=30,email=alice@test.com\\n[DATA] name=Bob,age=25,email=bob@test.com";
const actual = result.join("\\n");
process.exit(actual === expected ? 0 : 1);
`,
      },
    ],
  },
  prompt: `Fix the output format in /tmp/bm1-task-t3/reverse/format.ts.

The expected output format is documented in /tmp/bm1-task-t3/reverse/expected.txt.
The current output does NOT match. Fix the formatUser function to produce
the correct key=value format.

Run "node /tmp/bm1-task-t3/reverse/runner.ts" to verify exit code 0.`,
  verify: (toolCalls, text) => {
    const fixed = toolCalls.some(t => ["write", "edit"].includes(t.tool) && /format\.ts/.test(t.args?.path || ""));
    const readExpected = toolCalls.some(t => t.tool === "read" && /expected\.txt/.test(t.args?.path || ""));
    const ranRunner = toolCalls.some(t => t.tool === "bash" && /runner\.ts/.test(t.args?.command || ""));
    const mentioned = /key=value|format|name=|email=|expected|field/i.test(text);
    return {
      fixed, readExpected, ranRunner, mentioned,
      score: (fixed ? 40 : 0) + (readExpected ? 20 : 0) + (ranRunner ? 20 : 0) + (mentioned ? 20 : 0),
    };
  },
};

// ── Export ────────────────────────────────────────────────────────────────

export const NOVEL_TASKS = [TASK1, TASK2, TASK3];

export function getNovelTasks() {
  return NOVEL_TASKS;
}

export function setupNovelTask(task) {
  setup(task);
}

export { setup };
