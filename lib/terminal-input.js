'use strict';
const crypto = require('node:crypto');

const MAX_INPUT_BYTES = 65536;
const MAX_PENDING_BYTES = 262144;

function queueTerminalInput(proc, transport, data, { mode = 'keystrokes', exited = false, onUpdate = () => {} } = {}) {
  const base = { inputId: `input_${crypto.randomBytes(12).toString('hex')}`, mode,
    deliveryVerified: false, modelConsumption: 'unverified' };
  const reject = (code) => ({ ...base, ok: false, status: 'rejected', errorCode: code, acceptedBytes: 0 });
  // A PTY cannot prove that a model consumed a pasted prompt. Keep semantic
  // requests on the hash-verified one-shot/file transport.
  if (mode === 'prompt') return reject('bulk_prompt_transport_unsupported');
  if (mode !== 'keystrokes' || typeof data !== 'string') return reject('invalid_terminal_input');
  const bytes = Buffer.byteLength(data);
  if (bytes > MAX_INPUT_BYTES) return reject('terminal_input_too_large');
  if (exited || !proc) return reject('terminal_closed');
  const result = { ...base, ok: true, status: 'queued', acceptedBytes: bytes,
    sha256: crypto.createHash('sha256').update(data).digest('hex'), backpressure: null };
  try {
    // Intentional terminal authority: authenticated session routes deliver
    // exact operator keystrokes to an existing process, including shell input.
    // Escaping would change those commands and control keys. Every caller must
    // enforce capability/Origin/Host checks; remote MCP excludes terminal tools.
    if (transport === 'pty') proc.write(data);
    else {
      const stream = proc.stdin;
      if (!stream || stream.destroyed || stream.writableEnded) return reject('terminal_closed');
      if (stream.writableLength + bytes > MAX_PENDING_BYTES) return reject('terminal_input_backpressure');
      result.backpressure = !stream.write(data, (error) => onUpdate({ ...result,
        ok: !error, status: error ? 'failed' : 'transmitted',
        ...(error ? { errorCode: 'terminal_input_failed' } : { transmittedBytes: bytes }) }));
    }
  } catch { return reject('terminal_input_failed'); }
  return result;
}

module.exports = { queueTerminalInput, MAX_INPUT_BYTES, MAX_PENDING_BYTES };
