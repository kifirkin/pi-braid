/**
 * BM2: Code Quality — task definitions only.
 *
 * Each task: agent writes a JS module from scratch.
 * Scoring: 50% code quality (style, idioms, docs), 50% tests passing.
 */

export const TASKS = [
  {
    id: 'debounce-fn',
    prompt: 'Write a JavaScript debounce function to /tmp/bm2-task1/debounce.js. It should: (1) accept func, wait, and options (leading/trailing), (2) return a debounced function with .cancel(), (3) handle edge cases (null func, zero wait). Write clean, well-documented code.',
    filename: 'debounce.js',
    timeout: 60,
  },
  {
    id: 'deep-clone',
    prompt: 'Write a JavaScript deepClone function in /tmp/bm2-task2/clone.js. It should: (1) handle primitives, arrays, plain objects, Date, RegExp, (2) handle circular references, (3) NOT use JSON.parse(JSON.stringify()). Write clean, well-documented code.',
    filename: 'clone.js',
    timeout: 60,
  },
  {
    id: 'event-emitter',
    prompt: 'Write a JavaScript EventEmitter class in /tmp/bm2-task3/emitter.js. It should implement: on(event, fn), off(event, fn), once(event, fn), emit(event, ...args). Use ES6 class syntax. Write clean, well-documented code.',
    filename: 'emitter.js',
    timeout: 60,
  },
];
