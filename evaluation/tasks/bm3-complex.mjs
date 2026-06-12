/**
 * BM3: Complex Multi-Step Tasks - harder problems where braid shines.
 *
 * Tasks require: planning, multi-file coordination, verification,
 * self-correction, and consistency checks.
 * Naked pi tends to make mistakes on these; braid's cognitive scaffolding helps.
 */

export const TASKS = [
  {
    id: 'refactor-spread',
    prompt: `Refactor /tmp/bm3-task1/utils.js - replace ALL spread operators (...obj) with Object.assign({}, obj) for Node.js 12 compatibility. Make the same change across all files in /tmp/bm3-task1/. Keep functionality identical.`,
    filename: 'utils.js',
    targetDir: '/tmp/bm3-task1',
    timeout: 180,
  },
  {
    id: 'consistent-types',
    prompt: `Fix type inconsistency in /tmp/bm3-task2/api.ts - the User type has 'email' but functions use 'username'. Make all code consistent. Verify with the existing test file.`,
    filename: 'api.ts',
    targetDir: '/tmp/bm3-task2',
    timeout: 180,
  },
  {
    id: 'race-condition',
    prompt: `Fix race condition in /tmp/bm3-task3/cache.js - the getOrSet() function has a race when two calls happen simultaneously. Add proper locking. Run tests to verify.`,
    filename: 'cache.js',
    targetDir: '/tmp/bm3-task3',
    timeout: 180,
  },
  {
    id: 'memory-leak',
    prompt: `Fix memory leak in /tmp/bm3-task4/event-bus.js - listeners accumulate and are never removed. Add cleanup() method and unsubscribe logic. Verify no regression.`,
    filename: 'event-bus.js',
    targetDir: '/tmp/bm3-task4',
    timeout: 180,
  },
  {
    id: 'circular-deps',
    prompt: `Fix circular dependency between /tmp/bm3-task5/a.js, b.js, c.js that causes "Cannot read property of undefined". Use lazy requires or dependency inversion.`,
    filename: 'a.js',
    targetDir: '/tmp/bm3-task5',
    timeout: 180,
  },
];
