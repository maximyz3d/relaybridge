'use strict';

const { toolCount } = require('./http-provider-terminal');

const LIMITS = Object.freeze({ maxWireBytes: 12582912, maxFrameBytes: 1048576, maxOutputBytes: 12582912, maxFrames: 100000, maxChunks: 65536 });

function streamError(code, message) {
  return Object.assign(new Error(message), { code, failureClass: code === 'http_output_limit' ? 'output_cap' : 'provider_protocol_error' });
}

function bounds(options) {
  const limits = {};
  for (const [key, fallback] of Object.entries(LIMITS)) {
    const value = options[key] === undefined ? fallback : options[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > fallback) throw new TypeError(`invalid HTTP stream limit: ${key}`);
    limits[key] = value;
  }
  return limits;
}

function createOllamaStreamParser(options = {}) {
  const limits = bounds(options);
  let wireBytes = 0, frameBytes = 0, outputBytes = 0, frames = 0;
  let fragments = [], output = [], terminal = null, finished = false;
  let failure = null, chunks = 0, observedTools = 0;

  function assertContinuing(accepted = true) {
    if (options.signal?.aborted) throw Object.assign(new Error('Provider transport aborted.'), { name: 'AbortError' });
    if (accepted === false) throw streamError('http_semantic_stopped', 'Provider semantic acceptance stopped.');
  }

  function acceptFrame(text) {
    assertContinuing();
    if (!text.trim()) return;
    if (++frames > limits.maxFrames) throw streamError('http_frame_limit', 'Provider stream exceeded its frame limit.');
    if (terminal) throw streamError('http_conflicting_terminal', 'Provider sent another frame after its terminal result.');
    let frame;
    try { frame = JSON.parse(text); } catch { throw streamError('http_invalid_json', 'Provider stream contains malformed JSON.'); }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw streamError('http_invalid_frame', 'Provider stream frame must be an object.');
    if (Object.hasOwn(frame, 'error')) {
      if (typeof frame.error !== 'string' || !frame.error) throw streamError('http_invalid_frame', 'Provider error envelope is malformed.');
      // Do not put untrusted provider prose into a thrown diagnostic or log.
      throw Object.assign(streamError('http_provider_error', 'Provider emitted an error frame.'), { failureClass: 'provider_error' });
    }
    if (frame.done !== true && frame.done !== false) throw streamError('http_invalid_frame', 'Provider stream frame needs a boolean done field.');
    if (Object.hasOwn(frame, 'response') && typeof frame.response !== 'string') throw streamError('http_invalid_frame', 'Provider output delta must be text.');
    if (Object.hasOwn(frame, 'message') && (!frame.message || typeof frame.message !== 'object' || Array.isArray(frame.message)
      || typeof frame.message.content !== 'string' || (frame.message.role !== undefined && frame.message.role !== 'assistant'))) throw streamError('http_invalid_frame', 'Provider message envelope is malformed.');
    if (Object.hasOwn(frame, 'response') && Object.hasOwn(frame, 'message') && frame.response !== frame.message.content) {
      throw streamError('http_invalid_frame', 'Provider output envelopes disagree.');
    }
    const delta = frame.response ?? frame.message?.content ?? '';
    const tools = toolCount(frame.tool_calls) + toolCount(frame.message?.tool_calls);
    if (frame.thinking !== undefined && typeof frame.thinking !== 'string') throw streamError('http_invalid_frame', 'Provider thinking envelope is malformed.');
    if (frame.model !== undefined && (typeof frame.model !== 'string' || !frame.model || frame.model.length > 160)) {
      throw streamError('http_invalid_frame', 'Provider model identity is malformed.');
    }
    let acceptedTerminal = null;
    if (frame.done === true) {
      acceptedTerminal = { model: frame.model || null, done_reason: null, toolCount: Math.min(128, observedTools + tools),
        prompt_eval_count: null, eval_count: null, total_duration: null, load_duration: null };
      for (const field of ['prompt_eval_count', 'prompt_eval_cached_count', 'eval_count', 'total_duration', 'load_duration', 'prompt_eval_duration', 'eval_duration']) {
        if (frame[field] !== undefined && (!Number.isSafeInteger(frame[field]) || frame[field] < 0)) {
          throw streamError('http_invalid_usage', 'Provider terminal usage or duration is malformed.');
        }
        acceptedTerminal[field] = frame[field] ?? null;
      }
      if (frame.done_reason !== undefined && (typeof frame.done_reason !== 'string' || !frame.done_reason || frame.done_reason.length > 64)) {
        throw streamError('http_invalid_frame', 'Provider terminal reason is malformed.');
      }
      acceptedTerminal.done_reason = frame.done_reason || null;
      acceptedTerminal.compatibility = frame.done_reason === undefined ? 'ollama_done_without_reason_v1' : null;
      if (acceptedTerminal.prompt_eval_cached_count !== null && (acceptedTerminal.prompt_eval_count === null
        || acceptedTerminal.prompt_eval_cached_count > acceptedTerminal.prompt_eval_count)) {
        throw streamError('http_invalid_usage', 'Provider cached tokens exceed total input tokens.');
      }
      if (acceptedTerminal.prompt_eval_count !== null && acceptedTerminal.eval_count !== null
        && !Number.isSafeInteger(acceptedTerminal.prompt_eval_count + acceptedTerminal.eval_count)) {
        throw streamError('http_invalid_usage', 'Provider token totals exceed numeric bounds.');
      }
    }
    const bytes = Buffer.byteLength(delta, 'utf8');
    if (outputBytes + bytes > limits.maxOutputBytes) throw streamError('http_output_limit', 'Provider semantic output exceeded its byte limit.');
    // A frame is validated in full before any callback observes its content or
    // usage. The caller may latch a budget stop from the terminal callback.
    observedTools = Math.min(128, observedTools + tools);
    if (acceptedTerminal) {
      terminal = acceptedTerminal;
      assertContinuing(options.onTerminal?.({ ...terminal }));
    }
    if (delta) {
      outputBytes += bytes;
      output.push(delta);
      assertContinuing(options.onDelta?.(delta));
    }
    // Seal only after the fully validated final frame's usage AND text have
    // passed semantic acceptance/budget checks. Physical EOF may arrive later.
    if (acceptedTerminal) assertContinuing(options.onTerminalAccepted?.({ ...terminal }));
  }

  function finishFrame() {
    const bytes = Buffer.concat(fragments, frameBytes); fragments = []; frameBytes = 0;
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw streamError('http_invalid_utf8', 'Provider frame contains invalid UTF-8.'); }
    acceptFrame(text);
  }

  function consume(bytes) {
    // Frame raw bytes before fatal decoding. Invalid UTF-8 after a complete
    // terminal must not erase that terminal only because TCP coalesced them.
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const end = newline < 0 ? bytes.length : newline;
      const part = bytes.subarray(offset, end);
      frameBytes += part.length;
      if (frameBytes > limits.maxFrameBytes || fragments.length >= 65536) {
        throw streamError('http_frame_limit', 'Provider stream exceeded its bounded frame storage.');
      }
      if (part.length) fragments.push(part);
      if (newline >= 0) finishFrame();
      offset = end + 1;
    }
  }

  function push(bytes) {
    if (finished) throw streamError('http_stream_finished', 'Provider stream already finished.');
    if (!(bytes instanceof Uint8Array)) throw new TypeError('HTTP stream requires byte chunks');
    if (++chunks > limits.maxChunks) throw streamError('http_chunk_limit', 'Provider stream exceeded its chunk limit.');
    const remaining = Math.max(0, limits.maxWireBytes - wireBytes);
    wireBytes += bytes.byteLength;
    options.onWireBytes?.(bytes.byteLength);
    consume(Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, remaining)));
    if (wireBytes > limits.maxWireBytes) throw streamError('http_wire_limit', 'Provider response exceeded its wire byte limit.');
  }

  function finish() {
    if (finished) throw streamError('http_stream_finished', 'Provider stream already finished.');
    finished = true;
    if (fragments.length) finishFrame();
    if (!terminal) throw streamError('http_missing_terminal', 'Provider stream ended without a terminal done result.');
    return { ...terminal, response: output.join(''), done: true,
      transport: { wireBytes, outputBytes, frames, limits: { ...limits } } };
  }
  const guarded = (operation) => (...args) => {
    if (failure) throw failure;
    try { return operation(...args); } catch (error) { failure = error; throw error; }
  };
  return { push: guarded(push), finish: guarded(finish) };
}

async function consumeResponseBody(response, { signal, onChunk, maxChunks = LIMITS.maxChunks }) {
  if (!Number.isSafeInteger(maxChunks) || maxChunks <= 0 || maxChunks > LIMITS.maxChunks) throw new TypeError('invalid HTTP chunk limit');
  const reader = response.body?.getReader();
  if (!reader) throw streamError('http_missing_body', 'Provider response has no body.');
  let cancellation = null, complete = false, chunks = 0;
  const cancel = () => {
    if (!cancellation) cancellation = Promise.resolve().then(() => reader.cancel()).catch(() => {});
    return cancellation;
  };
  const abort = () => { cancel(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw Object.assign(new Error('Provider transport aborted.'), { name: 'AbortError' });
      const { value, done } = await reader.read();
      if (signal?.aborted) throw Object.assign(new Error('Provider transport aborted.'), { name: 'AbortError' });
      if (done) { complete = true; break; }
      if (++chunks > maxChunks) throw streamError('http_chunk_limit', 'Provider response exceeded its chunk limit.');
      onChunk(value);
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!complete || cancellation) await cancel();
    reader.releaseLock();
  }
}

async function readOllamaStream(response, options = {}) {
  const parser = createOllamaStreamParser(options);
  await consumeResponseBody(response, { signal: options.signal, onChunk: parser.push, maxChunks: options.maxChunks });
  return parser.finish();
}

async function readProviderBody(response, { signal, maxBytes = LIMITS.maxWireBytes, maxChunks, onWireBytes } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > LIMITS.maxWireBytes) throw new TypeError('invalid HTTP body byte limit');
  const storage = Buffer.allocUnsafe(maxBytes);
  let size = 0;
  await consumeResponseBody(response, { signal, maxChunks, onChunk: (bytes) => {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('HTTP stream requires byte chunks');
    if (!bytes.byteLength) return;
    size += bytes.byteLength;
    if (size > maxBytes) throw streamError('http_wire_limit', 'Provider response exceeded its wire byte limit.');
    storage.set(bytes, size - bytes.byteLength); onWireBytes?.(bytes.byteLength);
  } });
  try { return new TextDecoder('utf-8', { fatal: true }).decode(storage.subarray(0, size)); }
  catch { throw streamError('http_invalid_utf8', 'Provider body contains invalid UTF-8.'); }
}

module.exports = { createOllamaStreamParser, readOllamaStream, readProviderBody, LIMITS };
