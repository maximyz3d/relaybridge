'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOllamaStreamParser, readOllamaStream, readProviderBody } = require('../lib/http-provider-stream');

test('arbitrary byte splits preserve UTF-8, semantic deltas and terminal usage without newline', () => {
  const deltas = [], terminals = [];
  const parser = createOllamaStreamParser({ onDelta: (text) => deltas.push(text), onTerminal: (value) => terminals.push(value) });
  const wire = Buffer.from(JSON.stringify({ response: '雪π', done: false }) + '\r\n'
    + JSON.stringify({ response: ' finished.', model: 'fixture:1', done: true, prompt_eval_count: 12, eval_count: 6 }));
  for (const byte of wire) parser.push(Buffer.from([byte]));
  const result = parser.finish();
  assert.equal(result.response, '雪π finished.'); assert.equal(result.transport.wireBytes, wire.length);
  assert.deepEqual(deltas, ['雪π', ' finished.']); assert.equal(terminals.length, 1);
  assert.equal(result.prompt_eval_count, 12); assert.equal(result.transport.frames, 2);
});

test('malformed frames, usage, missing and conflicting terminals fail closed', () => {
  for (const [wire, code] of [
    ['bad\n', 'http_invalid_json'], ['[]\n', 'http_invalid_frame'],
    ['{"response":"not done"}\n', 'http_invalid_frame'],
    ['{"response":"pending","done":false}', 'http_missing_terminal'],
    ['{"done":true,"eval_count":"4"}\n', 'http_invalid_usage'],
    ['{"done":true}\n{"done":true}\n', 'http_conflicting_terminal'],
    ['{"done":true}\n{"response":"late","done":false}\n', 'http_conflicting_terminal'],
    ['{"error":"private provider detail"}\n', 'http_provider_error'],
  ]) {
    const parser = createOllamaStreamParser();
    assert.throws(() => { parser.push(Buffer.from(wire)); parser.finish(); }, (error) => error.code === code && !error.message.includes('private'), wire);
  }
});

test('wire, frame and semantic byte caps reject before excessive retention', () => {
  for (const [options, wire, code] of [
    [{ maxWireBytes: 8 }, '123456789', 'http_wire_limit'],
    [{ maxFrameBytes: 8 }, '123456789', 'http_frame_limit'],
    [{ maxOutputBytes: 2 }, '{"done":true,"response":"雪"}', 'http_output_limit'],
    [{ maxFrames: 1 }, '{"done":false}\n{"done":true}', 'http_frame_limit'],
  ]) {
    const parser = createOllamaStreamParser(options);
    assert.throws(() => { parser.push(Buffer.from(wire)); parser.finish(); }, { code });
  }
});

test('malformed UTF-8 is rejected, including incomplete final multibyte characters', () => {
  const parser = createOllamaStreamParser();
  assert.throws(() => parser.push(Buffer.from([255, 10])), { code: 'http_invalid_utf8' });
  const partial = createOllamaStreamParser(); partial.push(Buffer.from([0xe9]));
  assert.throws(() => partial.finish(), { code: 'http_invalid_utf8' });
});

test('terminal callback occurs only after full frame validation and before its text', () => {
  const events = [];
  const parser = createOllamaStreamParser({ onTerminal: () => events.push('usage'), onDelta: () => events.push('text') });
  parser.push(Buffer.from('{"done":true,"response":"done","eval_count":3}\n')); parser.finish();
  assert.deepEqual(events, ['usage', 'text']);
  const malformed = createOllamaStreamParser({ onTerminal: () => events.push('invalid'), onDelta: () => events.push('invalid') });
  assert.throws(() => malformed.push(Buffer.from('{"done":true,"response":"x","eval_count":-1}\n')));
  assert.deepEqual(events, ['usage', 'text']);
});

test('terminal budget cutoff prevents its output and all later same-chunk frames', async () => {
  const controller = new AbortController(), events = [];
  const body = new Response('{"done":true,"response":"budget tail","eval_count":42}\n'
    + '{"done":false,"response":"late"}\n');
  await assert.rejects(readOllamaStream(body, { signal: controller.signal,
    onTerminal: () => { events.push('terminal'); controller.abort(); }, onDelta: (delta) => events.push(delta) }), { name: 'AbortError' });
  assert.deepEqual(events, ['terminal']);
  const parser = createOllamaStreamParser({ onTerminal: () => false, onDelta: () => assert.fail('no semantic tail') });
  assert.throws(() => parser.push(Buffer.from('{"done":true,"response":"tail"}\n')), { code: 'http_semantic_stopped' });
});

test('reader holds its promise through asynchronous abort drainage and releases the lock', async () => {
  let releaseDrain, readRequested;
  const reading = new Promise((resolve) => { readRequested = resolve; });
  const drain = new Promise((resolve) => { releaseDrain = resolve; });
  const stream = new ReadableStream({ pull() { readRequested(); }, cancel() { return drain; } });
  const controller = new AbortController();
  let settled = false;
  const read = readProviderBody({ body: stream }, { signal: controller.signal });
  const rejected = assert.rejects(read, { name: 'AbortError' });
  read.finally(() => { settled = true; }).catch(() => {});
  await reading; controller.abort(); await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false); assert.equal(stream.locked, true);
  releaseDrain(); await rejected; assert.equal(stream.locked, false);
});

test('successful terminal data still waits for local EOF, not just terminal JSON', async () => {
  let handle;
  const stream = new ReadableStream({ start(controller) { handle = controller; controller.enqueue(Buffer.from('{"done":true,"response":"done"}\n')); } });
  let settled = false;
  const read = readOllamaStream({ body: stream }); read.then(() => { settled = true; });
  await Promise.resolve(); await Promise.resolve(); assert.equal(settled, false);
  handle.close(); assert.equal((await read).response, 'done'); assert.equal(stream.locked, false);
});

test('oversized bodies cancel once and await cleanup without exposing diagnostic content', async () => {
  let cancels = 0;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('private error text')); }, cancel() { cancels++; } });
  await assert.rejects(readProviderBody({ body: stream }, { maxBytes: 4 }), { code: 'http_wire_limit' });
  assert.equal(cancels, 1); assert.equal(stream.locked, false);
});

test('every present known envelope is validated before terminal or text callbacks', () => {
  for (const frame of [
    { done: true, error: { message: 'failure' } }, { done: true, error: 400 },
    { done: true, response: 'valid', message: { content: 4 } },
    { done: true, response: 'valid', message: { content: 'different' } },
    { done: true, response: null, message: { content: 'fallback' } },
    { done: true, message: { role: 'user', content: 'fallback' } },
  ]) {
    const parser = createOllamaStreamParser({ onTerminal: () => assert.fail('no terminal'), onDelta: () => assert.fail('no delta') });
    assert.throws(() => parser.push(Buffer.from(JSON.stringify(frame) + '\n')), { code: 'http_invalid_frame' });
  }
});

test('parser failures and semantic stops remain sticky through subsequent push and finish', () => {
  for (const [options, wire, code] of [
    [{ onTerminal: () => false }, '{"done":true,"eval_count":99}\n', 'http_semantic_stopped'],
    [{}, '{"done":true}\n{"done":true}\n', 'http_conflicting_terminal'],
  ]) {
    const parser = createOllamaStreamParser(options);
    assert.throws(() => parser.push(Buffer.from(wire)), { code });
    assert.throws(() => parser.finish(), { code });
    assert.throws(() => parser.push(Buffer.alloc(0)), { code });
  }
});

test('raw body uses bounded storage for empty/one-byte chunks and rejects excessive chunk counts', async () => {
  let n = 0;
  const stream = new ReadableStream({ pull(controller) {
    if (n++ < 1000) controller.enqueue(new Uint8Array(0));
    else if (n < 1005) controller.enqueue(Buffer.from('x'));
    else controller.close();
  } });
  assert.equal(await readProviderBody({ body: stream }, { maxBytes: 4 }), 'xxxx');
  const runaway = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(0)); } });
  await assert.rejects(readProviderBody({ body: runaway }, { maxBytes: 1, maxChunks: 20 }), { code: 'http_chunk_limit' });
  assert.equal(runaway.locked, false);
});

test('raw semantic body rejects invalid and unfinished UTF-8 without replacement', async () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xe9])]) {
    await assert.rejects(readProviderBody(new Response(bytes)), { code: 'http_invalid_utf8' });
  }
});

test('late invalid UTF-8 cannot erase a complete terminal based on wire chunk boundaries', () => {
  const prefix = Buffer.from('{"done":false,"response":"prefix"}\n{"done":true,"done_reason":"stop","response":"answer"}\n');
  for (const chunks of [[Buffer.concat([prefix, Buffer.from([255, 10])])], [prefix, Buffer.from([255, 10])]]) {
    const events = [];
    const parser = createOllamaStreamParser({ onDelta: (value) => events.push(value), onTerminalAccepted: () => events.push('sealed') });
    assert.throws(() => { for (const chunk of chunks) parser.push(chunk); parser.finish(); }, { code: 'http_invalid_utf8' });
    assert.deepEqual(events, ['prefix', 'answer', 'sealed']);
  }
});

test('late wire-limit failure cannot erase a complete terminal based on coalescing', () => {
  const prefix = Buffer.from('{"done":true,"done_reason":"stop","response":"answer"}\n');
  for (const chunks of [[Buffer.concat([prefix, Buffer.from(' ')])], [prefix, Buffer.from(' ')]]) {
    const events = [];
    const parser = createOllamaStreamParser({ maxWireBytes: prefix.length, onTerminalAccepted: () => events.push('sealed') });
    assert.throws(() => { for (const chunk of chunks) parser.push(chunk); }, { code: 'http_wire_limit' });
    assert.deepEqual(events, ['sealed']);
  }
});
