'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { guardProviderInput } = require('../lib/provider-input-guard');

test('asynchronous provider stdin errors are consumed and routed to failure state', () => {
  const stream = new EventEmitter();
  let reason = null;
  assert.equal(guardProviderInput(stream, () => { reason = 'provider_input_write_failed'; }), true);
  assert.doesNotThrow(() => stream.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' })));
  assert.equal(reason, 'provider_input_write_failed');
});
