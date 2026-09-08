'use strict';

const crypto = require('crypto');

const DEFAULT_MAX_BYTES = 12000;
const DEFAULT_MAX_REDACTION_INPUT_BYTES = 48000;
const MAX_REDACTION_SOURCE_BYTES = 2 * 1024 * 1024;

function cleanCheckpointText(value) {
  let text = String(value || '');
  text = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  text = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return text.replace(/\r(?!\n)/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

// A checkpoint is caller-visible advisory text, never raw transport. Claude
// tool inputs and thinking blocks are excluded before this function runs; the
// patterns below are a second boundary for credentials accidentally repeated
// in an ordinary text block.
function boundRedactionInput(value, maxBytes = DEFAULT_MAX_REDACTION_INPUT_BYTES) {
  const source = String(value || '');
  const originalBytes = Buffer.byteLength(source, 'utf8');
  const bound = Number.isSafeInteger(maxBytes) && maxBytes > 0
    ? maxBytes : DEFAULT_MAX_REDACTION_INPUT_BYTES;
  if (originalBytes <= bound) return { text: source, originalBytes, truncated: false };
  // First bound by UTF-16 code units so truncateUtf8Tail never repeatedly scans
  // a multi-megabyte model block. It then enforces the exact UTF-8 byte cap.
  let tail = source.slice(-bound);
  if (tail && /[\uDC00-\uDFFF]/.test(tail[0])) tail = tail.slice(1);
  const bounded = truncateUtf8Tail(tail, bound);
  return { text: bounded.text, originalBytes, truncated: true };
}

function sanitizeCheckpointSecrets(value, maxInputBytes = DEFAULT_MAX_REDACTION_INPUT_BYTES) {
  const source = String(value || '');
  const originalBytes = Buffer.byteLength(source, 'utf8');
  // Never cut an unsanitized credential in half. Bound the complete source
  // admitted to redaction; oversized sources fail closed instead of leaking a
  // suffix whose identifying key/authorization label has been discarded.
  if (originalBytes > MAX_REDACTION_SOURCE_BYTES) {
    return { text: '', originalBytes, preTruncated: true, unavailableReason: 'redaction_input_limit' };
  }
  let text = cleanCheckpointText(source);
  // Monotonic scanning avoids quadratic rescans of repeated BEGIN markers
  // when an adversarial source never supplies a matching END.
  const begin = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;
  const end = /-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
  const pieces = [];
  let cursor = 0;
  let match;
  while ((match = begin.exec(text))) {
    pieces.push(text.slice(cursor, match.index), '[REDACTED_PRIVATE_KEY]');
    end.lastIndex = begin.lastIndex;
    const closing = end.exec(text);
    cursor = closing ? end.lastIndex : text.length;
    begin.lastIndex = cursor;
    if (!closing) break;
  }
  pieces.push(text.slice(cursor));
  text = pieces.join('');
  text = text.replace(
    /(\b(?:authorization|proxy-authorization)["']?\s*:\s*["']?(?:bearer|basic)\s+)[^\s,;"']+/gi,
    '$1[REDACTED]',
  );
  text = text.replace(
    /(\b(?:RELAYBRIDGE_TOKEN|PS_BRIDGE_TOKEN|[A-Z][A-Z0-9_]{0,100}_API_KEY)\b["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*(?:"|$)|'(?:[^'\\]|\\.)*(?:'|$)|[^\s,;]+)/gi,
    '$1[REDACTED]',
  );
  text = text.replace(
    /(\b(?:x-relaybridge-token|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|password)\b["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*(?:"|$)|'(?:[^'\\]|\\.)*(?:'|$)|[^\s,;]+)/gi,
    '$1[REDACTED]',
  );
  text = text.replace(/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[opusr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[0-9A-Za-z_-]{20,})\b/g, '[REDACTED_TOKEN]');
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]');
  const bounded = boundRedactionInput(cleanCheckpointText(text), maxInputBytes);
  return { text: bounded.text, originalBytes,
    preTruncated: bounded.truncated, unavailableReason: null };
}

function redactCheckpointSecrets(value, maxInputBytes = DEFAULT_MAX_REDACTION_INPUT_BYTES) {
  return sanitizeCheckpointSecrets(value, maxInputBytes).text;
}

function truncateUtf8Tail(value, maxBytes = DEFAULT_MAX_BYTES) {
  const text = String(value || '');
  const bound = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= bound) return { text, bytes: originalBytes, originalBytes, truncated: false };

  // Binary-search a UTF-16 index, then avoid starting on a low surrogate. The
  // retained tail is the latest part of the checkpoint and always valid UTF-8.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (Buffer.byteLength(text.slice(mid), 'utf8') > bound) low = mid + 1;
    else high = mid;
  }
  let start = low;
  if (start < text.length && /[\uDC00-\uDFFF]/.test(text[start])) start += 1;
  const retained = text.slice(start);
  return {
    text: retained,
    bytes: Buffer.byteLength(retained, 'utf8'),
    originalBytes,
    truncated: true,
  };
}

function extractClaudeAssistantCheckpoint(events, maxBytes = DEFAULT_MAX_BYTES) {
  const messages = new Map();
  let index = 0;
  let newestAssistantIndex = 0;
  for (const event of Array.isArray(events) ? events : []) {
    index += 1;
    if (event?.type !== 'assistant' || !event.message || typeof event.message !== 'object') continue;
    const id = typeof event.message.id === 'string' ? event.message.id.trim() : '';
    if (!id || !Array.isArray(event.message.content)) continue;
    newestAssistantIndex = index;
    const text = event.message.content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
    const sanitized = sanitizeCheckpointSecrets(text, Math.max(maxBytes * 4, DEFAULT_MAX_REDACTION_INPUT_BYTES));
    if (!sanitized.text) {
      if (sanitized.unavailableReason) messages.set(id, { text: '', lastIndex: index,
        sourceOriginalBytes: sanitized.originalBytes, unavailableReason: sanitized.unavailableReason });
      continue;
    }
    const prior = messages.get(id);
    if (!prior) {
      messages.set(id, {
        text: sanitized.text,
        sourceOriginalBytes: sanitized.originalBytes,
        preTruncated: sanitized.preTruncated,
        lastIndex: index,
        conflicted: false,
      });
      continue;
    }
    if (prior.conflicted) continue;
    if (sanitized.text === prior.text
      || (sanitized.text.length > prior.text.length && sanitized.text.startsWith(prior.text))) {
      prior.text = sanitized.text;
      prior.sourceOriginalBytes = sanitized.originalBytes;
      prior.preTruncated = sanitized.preTruncated;
      delete prior.unavailableReason;
      prior.lastIndex = index;
    } else if (!prior.text.startsWith(sanitized.text)) {
      prior.conflicted = true;
      prior.lastIndex = index;
    }
  }

  const latest = [...messages.entries()]
    .filter(([, state]) => !state.conflicted && state.text)
    .sort((left, right) => right[1].lastIndex - left[1].lastIndex)[0];
  if (!latest) {
    const omitted = [...messages.values()].find((state) => state.unavailableReason);
    return {
      text: '', eventType: null, bytes: 0, originalBytes: omitted?.sourceOriginalBytes || 0,
      truncated: !!omitted, sha256: null, messageIdHash: null,
      unavailableReason: omitted?.unavailableReason || 'no_complete_assistant_text', selectionReason: null,
    };
  }
  const [messageId, state] = latest;
  const bounded = truncateUtf8Tail(state.text, maxBytes);
  const newerConflicted = [...messages.values()]
    .some((candidate) => candidate.conflicted && candidate.lastIndex > state.lastIndex);
  return {
    ...bounded,
    originalBytes: Math.max(bounded.originalBytes, state.sourceOriginalBytes || 0),
    truncated: bounded.truncated || state.preTruncated === true,
    eventType: 'assistant',
    sha256: crypto.createHash('sha256').update(bounded.text).digest('hex'),
    messageIdHash: crypto.createHash('sha256').update(messageId).digest('hex'),
    unavailableReason: null,
    selectionReason: newerConflicted && newestAssistantIndex > state.lastIndex
      ? 'latest_assistant_conflicted_using_previous'
      : [...messages.values()].some((candidate) => candidate.unavailableReason && candidate.lastIndex > state.lastIndex)
        ? 'latest_assistant_unavailable_using_previous' : null,
  };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDACTION_INPUT_BYTES,
  MAX_REDACTION_SOURCE_BYTES,
  cleanCheckpointText,
  redactCheckpointSecrets,
  truncateUtf8Tail,
  extractClaudeAssistantCheckpoint,
};
