/**
 * BM2 Test Templates — test files that validate agent-written code.
 *
 * Each test: requires the agent's module, runs assertions,
 * prints "passed"/"failed" for each test.
 */

export const TESTS = {
  'debounce-fn': `
const debounce = require('./debounce.js');
const assert = require('assert');

// Test 1: basic debounce
let count = 0;
const fn = debounce(() => count++, 50);
fn(); fn(); fn();
setTimeout(() => {
  assert.strictEqual(count, 1, 'Should debounce multiple calls');
  console.log('Test 1 passed');
}, 100);

// Test 2: cancel
let count2 = 0;
const fn2 = debounce(() => count2++, 50);
fn2();
fn2.cancel();
setTimeout(() => {
  assert.strictEqual(count2, 0, 'Cancel should prevent execution');
  console.log('Test 2 passed');
}, 100);

// Test 3: leading edge
let count3 = 0;
const fn3 = debounce(() => count3++, 50, { leading: true });
fn3();
assert.strictEqual(count3, 1, 'Leading edge should fire immediately');
console.log('Test 3 passed');
`.trim(),

  'deep-clone': `
const { deepClone } = require('./clone.js');
const assert = require('assert');

// Test 1: primitives
assert.strictEqual(deepClone(42), 42);
assert.strictEqual(deepClone('hello'), 'hello');
assert.strictEqual(deepClone(null), null);
console.log('Test 1 passed');

// Test 2: objects
const obj = { a: 1, b: { c: 2 } };
const cloned = deepClone(obj);
assert.deepStrictEqual(cloned, obj);
cloned.b.c = 99;
assert.strictEqual(obj.b.c, 2, 'Clone should be independent');
console.log('Test 2 passed');

// Test 3: arrays
const arr = [1, [2, 3], { a: 4 }];
const arrCloned = deepClone(arr);
assert.deepStrictEqual(arrCloned, arr);
arrCloned[1][0] = 99;
assert.strictEqual(arr[1][0], 2, 'Array clone should be independent');
console.log('Test 3 passed');

// Test 4: Date
const d = new Date('2024-01-01');
const dCloned = deepClone(d);
assert.strictEqual(dCloned.getTime(), d.getTime());
assert(dCloned !== d, 'Date should be a new instance');
console.log('Test 4 passed');

// Test 5: circular reference (should not throw)
const circ = { a: 1 };
circ.self = circ;
try {
  deepClone(circ);
  console.log('Test 5 passed (no crash)');
} catch (e) {
  console.log('Test 5: circular handled with error:', e.message);
}
`.trim(),

  'event-emitter': `
const EventEmitter = require('./emitter.js');
const assert = require('assert');

// Test 1: on + emit
const e = new EventEmitter();
let called = 0;
e.on('test', () => called++);
e.emit('test');
e.emit('test');
assert.strictEqual(called, 2, 'on/emit should work');
console.log('Test 1 passed');

// Test 2: once
const e2 = new EventEmitter();
let onceCount = 0;
e2.once('x', () => onceCount++);
e2.emit('x');
e2.emit('x');
assert.strictEqual(onceCount, 1, 'once should fire only once');
console.log('Test 2 passed');

// Test 3: off
const e3 = new EventEmitter();
let offCount = 0;
const handler = () => offCount++;
e3.on('y', handler);
e3.emit('y');
e3.off('y', handler);
e3.emit('y');
assert.strictEqual(offCount, 1, 'off should remove listener');
console.log('Test 3 passed');

// Test 4: emit with args
const e4 = new EventEmitter();
let received = null;
e4.on('data', (a, b) => { received = [a, b]; });
e4.emit('data', 'hello', 42);
assert.deepStrictEqual(received, ['hello', 42]);
console.log('Test 4 passed');
`.trim(),
};
