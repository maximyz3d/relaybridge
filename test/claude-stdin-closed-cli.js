#!/usr/bin/env node
'use strict';

const fs = require('fs');

if (process.argv.includes('--version')) {
  process.stdout.write('claude-stdin-closed-fixture 1.0.0\n');
  process.exit(0);
}

// Close the provider input before emitting usage that asks RelayBridge for a
// finalization turn. This deterministically exercises asynchronous EPIPE.
process.stdin.destroy();
try { fs.closeSync(0); } catch {}

setTimeout(() => {
  process.stdout.write(`${JSON.stringify({
    type: 'assistant',
    message: {
      id: 'reserve-epipe-1',
      usage: {
        input_tokens: 100,
        output_tokens: 100,
        cache_read_input_tokens: 700,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: 'text', text: 'work after provider input closed' }],
    },
  })}\n`);
}, 200);

setTimeout(() => process.exit(2), 900);
