import { createLogger, getBuffer, setConsoleLogLevel, setGlobalLogLevel } from './dist/lib/logger.js';

setConsoleLogLevel('warn');
setGlobalLogLevel('info');

const log = createLogger('test');

console.log('--- Test: info should NOT go to raw console ---');
log.info('this is info');

console.log('--- Test: warn SHOULD go to raw console ---');
log.warn('this is warn');

console.log('--- Test: error SHOULD go to raw console ---');
log.error('this is error');

log.debug('this is debug');

const buf = getBuffer();
console.log('--- Buffer entries count:', buf.length);
const infoCount = buf.filter(e => e.level === 'info').length;
const warnCount = buf.filter(e => e.level === 'warn').length;
const errCount  = buf.filter(e => e.level === 'error').length;
const debugCount= buf.filter(e => e.level === 'debug').length;
console.log('info:', infoCount, 'warn:', warnCount, 'error:', errCount, 'debug:', debugCount);

let pass = true;
if (infoCount < 1)  { console.log('FAIL: info missing from buffer'); pass = false; }
if (warnCount < 1)  { console.log('FAIL: warn missing from buffer'); pass = false; }
if (errCount < 1)   { console.log('FAIL: error missing from buffer'); pass = false; }
if (debugCount < 1) { console.log('FAIL: debug missing from buffer'); pass = false; }
if (pass) console.log('PASS: all levels present in buffer');
