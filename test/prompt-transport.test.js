'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { promptTransportLimits, preparePrompt, renderPromptSlot } = require('../lib/prompt-transport');
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');

test('prompt limits reflect the actual declared transport and do not impose argv caps on stdin/file', () => {
  assert.equal(promptTransportLimits({}, ['cli', '{prompt}']).maxChars, 6000);
  assert.equal(promptTransportLimits({ oneshot_adapter: 'openai_chat_api' }).maxChars, 12000);
  assert.equal(promptTransportLimits({ oneshot_adapter: 'ollama_api' }).maxChars, 24000);
  for (const slot of [['cli', '{prompt_file}'], ['cli', '-']]) {
    assert.equal(promptTransportLimits({ prompt_max_chars: 12 }, slot).maxChars, null);
  }
  assert.throws(() => promptTransportLimits({}, ['cli', '{prompt}', '{prompt_file}']), { code: 'invalid_prompt_transport' });
});

test('argument boundary accepts every character at the limit and rejects +1 without leaking prompt text', () => {
  const limits = promptTransportLimits({ prompt_max_chars: 24000 }, ['cli', '{prompt}']);
  const prompt = 'first constraint\n' + 'x'.repeat(23957) + '\nsecret final instruction!';
  assert.equal(prompt.length, 24000);
  const accepted = preparePrompt(prompt, limits);
  assert.equal(accepted.text, prompt);
  assert.equal(accepted.evidence.originalHash, hash(prompt));
  assert.equal(accepted.evidence.effectiveHash, hash(prompt));
  assert.equal(accepted.evidence.truncated, false);
  assert.throws(() => preparePrompt(prompt + '!', limits), (error) => {
    assert.equal(error.code, 'prompt_too_large');
    assert.equal(error.validation.field, 'prompt');
    assert.equal(error.validation.inputChars, 24001);
    assert.equal(error.validation.maxChars, 24000);
    assert.equal(error.validation.inputHash, hash(prompt + '!'));
    assert.equal(error.validation.inputTruncated, false);
    assert.doesNotMatch(JSON.stringify(error), /secret final instruction/);
    assert.doesNotMatch(error.message, /secret final instruction/);
    return true;
  });
});

test('hosted and local HTTP prompt boundaries preserve exact middle and final constraints', () => {
  for (const oneshot_adapter of ['openai_chat_api', 'ollama_api']) {
    const limits = promptTransportLimits({ oneshot_adapter, prompt_max_chars: 100 });
    const prompt = 'HEAD' + 'x'.repeat(41) + 'MIDDLE' + 'x'.repeat(45) + 'TAIL';
    assert.equal(prompt.length, 100);
    assert.equal(preparePrompt(prompt, limits).text, prompt);
    assert.throws(() => preparePrompt(prompt + '.', limits), { code: 'prompt_too_large' });
  }
});

test('policy allowance is separate, bounded and fully reflected in effective transport hashes', () => {
  const prompt = 'x'.repeat(24000);
  const policyPrefix = 'READ ONLY';
  const accepted = preparePrompt(prompt, { transport: 'argument', maxChars: 24000, policyPrefix });
  assert.equal(accepted.text, `${policyPrefix}\n\nUser request:\n${prompt}`);
  assert.equal(accepted.evidence.originalChars, 24000);
  assert.equal(accepted.evidence.effectiveChars, accepted.text.length);
  assert.equal(accepted.evidence.effectiveHash, hash(accepted.text));
  assert.throws(() => preparePrompt(prompt, { transport: 'argument', maxChars: 24000, policyPrefix: 'p'.repeat(4097) }), { code: 'invalid_prompt_policy' });
});

test('long Unicode stdin/file input is preserved byte-for-byte', () => {
  const prompt = 'first constraint\n' + '世界🌍'.repeat(60000) + '\nlast constraint';
  for (const transport of ['stdin', 'file']) {
    const accepted = preparePrompt(prompt, { transport, maxChars: null });
    assert.equal(accepted.text, prompt);
    assert.equal(accepted.evidence.originalHash, hash(prompt));
    assert.equal(accepted.evidence.originalChars, prompt.length);
  }
});

test('invalid inputs and malformed provider limits fail closed', () => {
  for (const prompt of ['', '   ', null, {}, 42]) {
    assert.throws(() => preparePrompt(prompt, { transport: 'stdin', maxChars: null }), { code: 'invalid_prompt' });
  }
  for (const prompt_max_chars of [0, -1, Infinity, 1.5, '6000', 1048577]) {
    assert.throws(() => promptTransportLimits({ prompt_max_chars }, ['cli', '{prompt}']), { code: 'invalid_prompt_limit' });
  }
  assert.throws(() => preparePrompt('request', { transport: 'unknown', maxChars: null }), { code: 'invalid_prompt_transport' });
});

test('slot replacement preserves literal dollar metasyntax and never rescans inserted placeholders', () => {
  const prompt = "$& $$ $` $' {cwd} {prompt_file} {prompt} 世界";
  const cwd = '/tmp/{prompt}';
  assert.deepEqual(renderPromptSlot(['cli', 'prefix:{prompt}:suffix', '{cwd}', '{prompt_file}', '{prompt}/{prompt}'],
    { prompt, cwd, prompt_file: '/tmp/{cwd}' }),
  ['cli', `prefix:${prompt}:suffix`, cwd, '/tmp/{cwd}', `${prompt}/${prompt}`]);
});

test('downstream semantic limits include the full policy envelope even for stdin wrappers', () => {
  const limits = promptTransportLimits({ prompt_input_max_chars: 12000 }, ['node', 'wrapper.js']);
  assert.equal(limits.transport, 'stdin');
  assert.equal(preparePrompt('x'.repeat(12000), limits).text.length, 12000);
  assert.throws(() => preparePrompt('x'.repeat(12000), { ...limits, policyPrefix: 'READ ONLY' }), (error) => {
    assert.equal(error.code, 'prompt_too_large');
    assert.equal(error.validation.effectiveChars, 12025);
    return true;
  });
});
