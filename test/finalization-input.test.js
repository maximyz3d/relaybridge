'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the production callback, not a second implementation of its state
// transitions. Provider processes/network are replaced with a controlled pipe.
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = source.indexOf('  const requestGracefulFinalization = (verdict) => {');
const end = source.indexOf('  const collectWriterDiffSummary =', start);
assert.ok(start >= 0 && end > start);
const callbackSource = source.slice(start, end);

function fixture({ supported = true, throws = false } = {}) {
  let writeCallback;
  let writes = 0;
  let acknowledgements = 0;
  const context = {
    gracefulFinalization: { requested: false, sent: false, reason: null },
    supportsClaudeStreamFinalization: supported,
    providerInputClosed: false, providerInputWriteError: false, settled: false,
    supervisor: { acknowledgeFinalization() { acknowledgements += 1; } },
    claudeStreamUserMessage: (text) => JSON.stringify({ text }),
    proc: { stdin: { destroyed: false, writableEnded: false, write(_frame, callback) {
      writes += 1;
      if (throws) throw new Error('synthetic write failure');
      writeCallback = callback;
      return false; // backpressure is not a failed write or delivery proof
    } } },
  };
  vm.runInNewContext(callbackSource + '\nthis.request = requestGracefulFinalization;', context);
  return { context, request: context.request, complete(error) { writeCallback(error); },
    writes: () => writes, acknowledgements: () => acknowledgements };
}

test('finalization sent is false until the successful write callback, even under backpressure', () => {
  const f = fixture();
  f.request({ reserve: { threshold: 900 } });
  assert.equal(f.context.gracefulFinalization.requested, true);
  assert.equal(f.context.gracefulFinalization.sent, false);
  assert.equal(f.acknowledgements(), 1);
  f.request({ reserve: { threshold: 900 } });
  assert.equal(f.writes(), 1);
  f.complete(null);
  assert.equal(f.context.gracefulFinalization.sent, true);
});

test('delayed write failure and synchronous throw never claim successful delivery', () => {
  const delayed = fixture();
  delayed.request({ reserve: {} });
  delayed.complete(new Error('synthetic EPIPE'));
  assert.equal(delayed.context.gracefulFinalization.sent, false);
  assert.equal(delayed.context.gracefulFinalization.reason, 'provider_input_write_failed');
  const immediate = fixture({ throws: true });
  assert.doesNotThrow(() => immediate.request({ reserve: {} }));
  assert.equal(immediate.context.gracefulFinalization.sent, false);
  assert.equal(immediate.context.providerInputWriteError, true);
});

test('late write callbacks cannot mutate settled finalization evidence', () => {
  const f = fixture();
  f.request({ reserve: {} });
  f.context.settled = true;
  f.complete(null);
  assert.equal(f.context.gracefulFinalization.sent, false);
});

test('unsupported or already-closed input never receives a finalization frame', () => {
  for (const state of ['unsupported', 'closed']) {
    const f = fixture({ supported: state !== 'unsupported' });
    if (state === 'closed') f.context.providerInputClosed = true;
    f.request({ reserve: {} });
    assert.equal(f.writes(), 0);
    assert.equal(f.context.gracefulFinalization.sent, false);
  }
});
