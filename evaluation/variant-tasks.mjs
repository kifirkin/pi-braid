/**
 * pi-braid Variant Task Generator - Tier 2 Benchmark
 *
 * VAR-MATH-inspired variant tasks: same skill, different surface form.
 * Used to measure true generalization vs contamination.
 *
 * Run: node evaluation/run-variants.mjs [--model ...] [--trials 3]
 */

// ── Variant Task Definitions ────────────────────────────────────────────────

export const VARIANT_TASKS = {};

// JS Syntax Fix variants
VARIANT_TASKS['js-syntax-fix'] = [
  {
    id: 'js-syntax-fix-v1',
    name: 'JS Syntax Fix (missing closing brace)',
    setup: {
      file: '/tmp/bm1-task1v/syntax-bug.js',
      content: 'function greet(name) {\n  if (name) {\n    return "Hello, " + name;\n  // missing closing brace\n}\n\nconsole.log(greet("World"));\n',
    },
    prompt: 'Fix the syntax error in /tmp/bm1-task1v/syntax-bug.js. There is a missing closing brace. Verify with "node --check /tmp/bm1-task1v/syntax-bug.js".',
  },
  {
    id: 'js-syntax-fix-v2',
    name: 'JS Syntax Fix (typo in async keyword)',
    setup: {
      file: '/tmp/bm1-task1v/async-bug.js',
      content: 'asyc function fetch() {\n  return await Promise.resolve(42);\n}\n\nfetch().then(console.log);\n',
    },
    prompt: 'Fix the typo in /tmp/bm1-task1v/async-bug.js. There is a JavaScript keyword typo. Verify with "node --check /tmp/bm1-task1v/async-bug.js".',
  },
  {
    id: 'js-syntax-fix-v3',
    name: 'JS Syntax Fix (arrow function parens)',
    setup: {
      file: '/tmp/bm1-task1v/arrow-bug.js',
      content: 'const double = x => {\n  return x => x * 2;\n};\n\nconsole.log(double(2)(5));\n',
    },
    prompt: 'Fix the syntax in /tmp/bm1-task1v/arrow-bug.js. The arrow function has a parameter parsing ambiguity. Add parentheses to fix it. Verify with "node --check /tmp/bm1-task1v/arrow-bug.js".',
  },
];

// Python Import Fix variants
VARIANT_TASKS['py-import-fix'] = [
  {
    id: 'py-import-fix-v1',
    name: 'Python Import Fix (wrong module name)',
    setup: {
      file: '/tmp/bm1-task2v/app.py',
      content: 'from collections import ordereddict\nimport math as mth\n\nresult = ordereddict()\nprint(mth.sqrt(4))\n',
    },
    prompt: 'Fix the import errors in /tmp/bm1-task2v/app.py. Two imports are wrong. Fix them and verify with "python3 -c \'import ast; ast.parse(open(\'/tmp/bm1-task2v/app.py\').read()); print(\'OK\')\'".',
  },
  {
    id: 'py-import-fix-v2',
    name: 'Python Import Fix (relative import)',
    setup: {
      file: '/tmp/bm1-task2v/module.py',
      content: 'from .nonexistent import helper\nfrom ..config import settings\n\nresult = helper.process(settings)\n',
    },
    prompt: 'Fix the relative import error in /tmp/bm1-task2v/module.py. The imports reference incorrect paths. Check if the imports make sense and fix them.',
  },
];

// JSON Trailing Comma variants
VARIANT_TASKS['json-trailing-comma'] = [
  {
    id: 'json-trailing-comma-v1',
    name: 'JSON fix (single quotes + trailing comma)',
    setup: {
      file: '/tmp/bm1-task3v/config.json',
      content: "{\n  'name': 'my-app',\n  'version': '1.0.0',\n  'services': {\n    'api': 'http://localhost:3000',\n  }\n}\n",
    },
    prompt: 'Fix the JSON in /tmp/bm1-task3v/config.json. It uses single quotes (invalid JSON) and has a trailing comma. Fix both issues. Verify with "node -e \'JSON.parse(require(\'fs\').readFileSync(\'/tmp/bm1-task3v/config.json\')); console.log(\'valid\')\'".',
  },
  {
    id: 'json-trailing-comma-v2',
    name: 'JSON fix (multiple nesting)',
    setup: {
      file: '/tmp/bm1-task3v/deep-config.json',
      content: '{\n  "name": "my-app",\n  "config": {\n    "env": {\n      "debug": true,\n      "port": 3000,\n    },\n    "features": ["a", "b",],\n  }\n}\n',
    },
    prompt: 'Fix the JSON in /tmp/bm1-task3v/deep-config.json. Has trailing commas in multiple nested objects and arrays. Fix all and verify with "node -e \'JSON.parse(require(\'fs\').readFileSync(\'/tmp/bm1-task3v/deep-config.json\')); console.log(\'valid\')\'".',
  },
];

// TS Type Error variants
VARIANT_TASKS['ts-type-error'] = [
  {
    id: 'ts-type-error-v1',
    name: 'TS Error (missing return type + bad param type)',
    setup: {
      file: '/tmp/bm1-task4v/calc.ts',
      content: 'function add(a: number, b: number) {\n  return a + b;\n}\n\nfunction divide(a: number, b: string) {\n  return a / Number(b);\n}\n\nconsole.log(add(1, 2));\nconsole.log(divide(10, "2"));\n',
    },
    prompt: 'Fix the TypeScript errors in /tmp/bm1-task4v/calc.ts. Parameter types are wrong. Run "npx tsc --noEmit --strict /tmp/bm1-task4v/calc.ts" to verify.',
  },
  {
    id: 'ts-type-error-v2',
    name: 'TS Error (interface property)',
    setup: {
      file: '/tmp/bm1-task4v/data.ts',
      content: 'interface Item {\n  id: number;\n  name: string;\n}\n\nfunction process(items: string[]) {\n  return items.map(i => i.id);\n}\n\nconsole.log(process([1, 2, 3]));\n',
    },
    prompt: 'Fix the TypeScript error in /tmp/bm1-task4v/data.ts. The function signature doesn\'t match how it\'s used. Fix the type annotation. Run "npx tsc --noEmit --strict /tmp/bm1-task4v/data.ts" to verify.',
  },
];

// Race Condition variants
VARIANT_TASKS['race-condition'] = [
  {
    id: 'race-condition-v1',
    name: 'Race fix (shared counter, parameterized)',
    setup: {
      file: '/tmp/bm1-task5v/shared-counter.js',
      content: 'let counter = { value: 0 };\n\nasync function incrementCounter(amount) {\n  const cur = counter.value;\n  await new Promise(r => setTimeout(r, 5));\n  counter.value = cur + amount;\n}\n\nasync function main() {\n  await Promise.all([1,1,1,1,1].map(n => incrementCounter(n)));\n  console.log(counter.value);\n  process.exit(counter.value === 5 ? 0 : 1);\n}\nmain();\n',
    },
    prompt: 'Fix the race condition in /tmp/bm1-task5v/shared-counter.js. Multiple concurrent increments on a shared counter object. Verify with "node /tmp/bm1-task5v/shared-counter.js".',
  },
  {
    id: 'race-condition-v2',
    name: 'Race fix (file append)',
    setup: {
      file: '/tmp/bm1-task5v/file-logger.js',
      content: 'const fs = require("fs");\n\nconst logFile = "/tmp/bm1-task5v/app.log";\n\nasync function logMessage(msg) {\n  const current = fs.readFileSync(logFile, "utf-8");\n  await new Promise(r => setTimeout(r, 5));\n  fs.writeFileSync(logFile, current + msg + "\\n");\n}\n\nasync function main() {\n  fs.writeFileSync(logFile, "");\n  const writers = ["a","b","c","d","e"].map(m => logMessage(m));\n  await Promise.all(writers);\n  const result = fs.readFileSync(logFile, "utf-8");\n  const lines = result.trim().split("\\n");\n  console.log("Lines:", lines.length);\n  process.exit(lines.length === 5 ? 0 : 1);\n}\nmain();\n',
    },
    prompt: 'Fix the race condition in /tmp/bm1-task5v/file-logger.js. Concurrent file writes lose data due to read-then-write race. Verify with "node /tmp/bm1-task5v/file-logger.js".',
  },
];

/**
 * Get all variant tasks as a flat array.
 */
export function getAllVariantTasks() {
  const all = [];
  for (const baseId of Object.keys(VARIANT_TASKS)) {
    for (const variant of VARIANT_TASKS[baseId]) {
      all.push(variant);
    }
  }
  return all;
}

/**
 * Count all variant tasks.
 */
export function getVariantCount() {
  return getAllVariantTasks().length;
}
