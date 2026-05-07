/**
 * BM1: Multi-Turn Debugging — task definitions only.
 *
 * Each task: setup script + buggy file → agent reads, diagnoses, fixes.
 * Scoring: did the agent successfully fix the bug? (0/20/100)
 */

export const TASKS = [
  {
    id: 'js-syntax-fix',
    prompt: 'Read the file test/runtime/test-retry-command.mjs and identify any JavaScript syntax errors. If found, fix them.',
    timeout: 180,
    setup: null, // agent reads the existing file
  },
  {
    id: 'py-import-fix',
    prompt: 'Find and fix the Python import error in evaluation/benchmark_helpers/fix_import_error.py. The file has a broken import.',
    timeout: 180,
    setup: null,
  },
  {
    id: 'json-trailing-comma',
    prompt: 'Fix the trailing comma in evaluation/benchmark_helpers/broken.json so it parses correctly.',
    timeout: 180,
    setup: null,
  },
  {
    id: 'ts-type-error',
    prompt: 'Find and fix the TypeScript type error in evaluation/benchmark_helpers/fix-type-error.ts. The file has a type mismatch that prevents compilation.',
    timeout: 180,
    setup: null,
  },
  {
    id: 'race-condition',
    prompt: 'Analyze and fix the race condition in evaluation/benchmark_helpers/race-condition.js. The async code has a timing bug where callbacks fire in wrong order.',
    timeout: 180,
    setup: null,
  },
];
