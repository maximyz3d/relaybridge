#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

if (process.argv.includes('--version')) {
  process.stdout.write('claude-stream-fixture 1.0.0\n');
  process.exit(0);
}

const finalize = process.argv.includes('--finalize');
const healthy = process.argv.includes('--healthy');
const writerBudget = process.argv.includes('--writer-budget');
let messages = 0;

function assistant(id, text, usage) {
  process.stdout.write(`${JSON.stringify({
    type: 'assistant',
    message: {
      id,
      usage,
      content: [
        { type: 'thinking', thinking: 'STREAM_THINKING_MUST_NOT_ESCAPE' },
        { type: 'tool_use', name: 'Bash', input: { command: 'STREAM_TOOL_ARG_MUST_NOT_ESCAPE' } },
        { type: 'text', text },
      ],
    },
  })}\n`);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (!line.trim()) return;
  let event;
  try { event = JSON.parse(line); } catch { process.exit(3); }
  if (event?.type !== 'user' || event.message?.role !== 'user') process.exit(4);
  messages += 1;

  if (healthy && messages === 1) {
    assistant('healthy-1', 'healthy checkpoint', {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    process.stdout.write(`${JSON.stringify({
      type: 'result', is_error: false, subtype: 'success', result: 'HEALTHY_STREAM_OK',
      num_turns: 1,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    })}\n`);
    return;
  }

  if (writerBudget && messages === 1) {
    fs.writeFileSync(path.join(process.cwd(), 'writer-change.txt'), 'partial writer output\n', 'utf8');
    assistant('writer-budget-1', 'writer checkpoint api_key=must-not-leak', {
      input_tokens: 100,
      output_tokens: 100,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
    });
    setInterval(() => {}, 1000);
    return;
  }

  if (finalize && messages === 1) {
    assistant('reserve-1', 'work before reserve', {
      input_tokens: 100,
      output_tokens: 100,
      cache_read_input_tokens: 700,
      cache_creation_input_tokens: 0,
    });
    return;
  }

  if (finalize && messages === 2) {
    const requested = JSON.stringify(event).includes('final checkpoint');
    assistant('reserve-2', requested ? 'reserve request received' : 'reserve request missing', {
      input_tokens: 5,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    process.stdout.write(`${JSON.stringify({
      type: 'result', is_error: false, subtype: 'success', result: 'FINALIZED_OK',
      num_turns: 2,
      usage: {
        input_tokens: 105,
        output_tokens: 105,
        cache_read_input_tokens: 700,
        cache_creation_input_tokens: 0,
      },
    })}\n`);
  }
});

process.stdin.on('end', () => {
  if (finalize && messages >= 2) process.exit(0);
  if (healthy && messages >= 1) process.exit(0);
});
