import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireSingleInstance } from './singleInstance.js';

function fakeApp({ lockResult = true, throwOnLock = false } = {}) {
  const handlers = {};
  return {
    handlers,
    requestSingleInstanceLock() {
      if (throwOnLock) throw new Error('lock api exploded');
      return lockResult;
    },
    on(event, listener) { handlers[event] = listener; },
  };
}

test('lock granted: registers second-instance handler and reports single', () => {
  const app = fakeApp();
  let focused = 0;
  const single = acquireSingleInstance(app, { onSecondInstance: () => { focused += 1; } });
  assert.equal(single, true);
  assert.equal(typeof app.handlers['second-instance'], 'function');
  app.handlers['second-instance']();
  assert.equal(focused, 1);
});

test('lock denied: caller must quit, no listener registered', () => {
  const app = fakeApp({ lockResult: false });
  const single = acquireSingleInstance(app);
  assert.equal(single, false);
  assert.equal(app.handlers['second-instance'], undefined);
});

test('lock api throwing degrades to lock-denied instead of crashing boot', () => {
  const app = fakeApp({ throwOnLock: true });
  const warnings = [];
  const single = acquireSingleInstance(app, { log: { warn: message => warnings.push(message) } });
  assert.equal(single, false);
  assert.equal(warnings.length, 1);
});

test('second-instance handler errors are contained and logged', () => {
  const app = fakeApp();
  const warnings = [];
  acquireSingleInstance(app, {
    onSecondInstance: () => { throw new Error('focus failed'); },
    log: { warn: message => warnings.push(message) },
  });
  assert.doesNotThrow(() => app.handlers['second-instance']());
  assert.equal(warnings.length, 1);
});
