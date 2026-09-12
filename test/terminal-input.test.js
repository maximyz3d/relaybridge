'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { queueTerminalInput, MAX_PENDING_BYTES } = require('../lib/terminal-input');

test('bulk semantic prompts refuse before touching a terminal; keystrokes remain unverified', () => {
  let writes = 0;
  const proc = { write() { writes++; } };
  const refused = queueTerminalInput(proc, 'pty', 'Review everything', { mode: 'prompt' });
  assert.equal(refused.errorCode, 'bulk_prompt_transport_unsupported'); assert.equal(writes, 0);
  const input = queueTerminalInput(proc, 'pty', 'help\r');
  assert.equal(writes, 1); assert.equal(input.status, 'queued'); assert.equal(input.deliveryVerified, false);
  assert.equal(input.modelConsumption, 'unverified');
});

test('pipe acceptance, backpressure and asynchronous failure are distinct from model delivery', () => {
  let callback; const updates = [];
  const proc = { stdin: { writableLength: 0, write(data, cb) { callback = cb; return false; } } };
  const result = queueTerminalInput(proc, 'pipe', 'x', { onUpdate: update => updates.push(update) });
  assert.equal(result.ok, true); assert.equal(result.backpressure, true); assert.equal(result.status, 'queued');
  callback(new Error('EPIPE'));
  assert.equal(updates[0].status, 'failed'); assert.equal(updates[0].inputId, result.inputId);
  assert.equal(updates[0].deliveryVerified, false);
  proc.stdin.writableLength = MAX_PENDING_BYTES;
  assert.equal(queueTerminalInput(proc, 'pipe', 'x').errorCode, 'terminal_input_backpressure');
  assert.equal(queueTerminalInput(proc, 'pipe', {}, {}).errorCode, 'invalid_terminal_input');
});
