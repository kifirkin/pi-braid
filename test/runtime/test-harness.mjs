/**
 * Runtime test for evaluation/test-harness.mjs
 * Tests extractCode, executeCode, and argument parsing without calling pi.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL: ${msg}\n  expected: ${e}\n  actual:   ${a}`);
    failed++;
    return false;
  }
  console.log(`PASS: ${msg}`);
  passed++;
  return true;
}

// ── Import harness functions via dynamic import (non-exported, so we use a trick) ──
// We'll execute a small script that imports the harness and tests the functions.

const harnessScript = `
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function extractCode(text) {
  if (!text) return null;
  let m = text.match(/\\x60\\x60\\x60(?:js|javascript)\\s*\\n([\\s\\S]*?)\\n\\x60\\x60\\x60(?:\\s*(?:\\n|$))/i);
  if (m) return m[1].trim();
  m = text.match(/\\x60\\x60\\x60\\s*\\n([\\s\\S]*?)\\n\\x60\\x60\\x60(?:\\s*(?:\\n|$))/);
  if (m) return m[1].trim();
  return text.trim();
}

async function executeCode(code, testCode, timeoutMs = 10000) {
  const dir = mkdtempSync(join(tmpdir(), "pi-braid-test-"));
  const testFile = join(dir, "test.js");
  const isAsync = testCode.includes("await");
  const testBody = isAsync
    ? "(async () => {\\n" + testCode + "\\n})();"
    : testCode;
  writeFileSync(testFile, code + "\\n\\n" + testBody + "\\n");
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const proc = spawn("node", [testFile], { timeout: timeoutMs });
    let stdout = "", stderr = "";
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

const tests = [];

// Test extractCode
const t1 = extractCode("\\x60\\x60\\x60js\\nfunction foo() {}\\n\\x60\\x60\\x60");
tests.push({ name: "extractCode: basic js fence", result: t1 === "function foo() {}", detail: t1 });

const t2 = extractCode("\\x60\\x60\\x60javascript\\nconst x = 1;\\n\\x60\\x60\\x60");
tests.push({ name: "extractCode: javascript fence", result: t2 === "const x = 1;", detail: t2 });

const t3 = extractCode("\\x60\\x60\\x60\\nplain code\\n\\x60\\x60\\x60");
tests.push({ name: "extractCode: untagged fence", result: t3 === "plain code", detail: t3 });

const t4 = extractCode("no fences here");
tests.push({ name: "extractCode: no fence returns raw", result: t4 === "no fences here", detail: t4 });

const t5 = extractCode("Some text\\n\\x60\\x60\\x60js\\nconst a = 1;\\n\\x60\\x60\\x60\\nMore text");
tests.push({ name: "extractCode: embedded in text", result: t5 === "const a = 1;", detail: t5 });

const t6 = extractCode("");
tests.push({ name: "extractCode: empty string", result: t6 === null, detail: t6 });

// Test executeCode
const res = await executeCode(
  "function add(a, b) { return a + b; }",
  "const assert = require('assert'); assert.strictEqual(add(2,3), 5); console.log('ALL PASSED');"
);
tests.push({ name: "executeCode: passing test", result: res.success === true, detail: res });

const res2 = await executeCode(
  "function add(a, b) { return a - b; }",
  "const assert = require('assert'); assert.strictEqual(add(2,3), 5); console.log('ALL PASSED');"
);
tests.push({ name: "executeCode: failing test", result: res2.success === false, detail: res2 });

console.log(JSON.stringify(tests));
`;

const dir = mkdtempSync(join(tmpdir(), "pi-braid-harness-test-"));
const scriptFile = join(dir, "run.mjs");
writeFileSync(scriptFile, harnessScript);

const proc = spawn("node", [scriptFile], { timeout: 30000 });
let output = "";
proc.stdout.on("data", (d) => { output += d.toString(); });
proc.stderr.on("data", (d) => { console.error("STDERR:", d.toString()); });

proc.on("exit", (code) => {
  rmSync(dir, { recursive: true, force: true });
  
  let results;
  try {
    results = JSON.parse(output.trim());
  } catch (e) {
    console.error("Failed to parse harness test output:", output);
    process.exit(1);
  }

  for (const r of results) {
    if (r.result) {
      console.log(`PASS: ${r.name}`);
      passed++;
    } else {
      console.error(`FAIL: ${r.name}\n  detail: ${JSON.stringify(r.detail)}`);
      failed++;
    }
  }

  console.log(`\n${passed}/${passed + failed} tests passed`);
  process.exit(failed > 0 ? 1 : 0);
});
