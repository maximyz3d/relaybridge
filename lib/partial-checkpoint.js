'use strict';

const crypto = require('crypto');

const DEFAULT_MAX_BYTES = 12000;

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
function redactCheckpointSecrets(value) {
  let text = cleanCheckpointText(value);
  text = text.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '[REDACTED_PRIVATE_KEY]',
  );
  text = text.replace(
    /(\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi,
    '$1[REDACTED]',
  );
  text = text.replace(
    /(\b(?:x-relaybridge-token|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    '$1[REDACTED]',
  );
  text = text.replace(/\b(?:sk-ant-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[opusr]_[A-Za-z0-9]{20,})\b/g, '[REDACTED_TOKEN]');
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]');
  return cleanCheckpointText(text);
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
  for (const event of Array.isArray(events) ? events : []) {
    index += 1;
    if (event?.type !== 'assistant' || !event.message || typeof event.message !== 'object') continue;
    const id = typeof event.message.id === 'string' ? event.message.id.trim() : '';
    if (!id || !Array.isArray(event.message.content)) continue;
    const text = event.message.content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
    const sanitized = redactCheckpointSecrets(text);
    if (!sanitized) continue;
    const prior = messages.get(id);
    if (!prior) {
      messages.set(id, { text: sanitized, lastIndex: index, conflicted: false });
      continue;
    }
    if (prior.conflicted) continue;
    if (sanitized === prior.text || (sanitized.length > prior.text.length && sanitized.startsWith(prior.text))) {
      prior.text = sanitized;
      prior.lastIndex = index;
    } else if (!prior.text.startsWith(sanitized)) {
      prior.conflicted = true;
    }
  }

  const latest = [...messages.entries()]
    .filter(([, state]) => !state.conflicted && state.text)
    .sort((left, right) => right[1].lastIndex - left[1].lastIndex)[0];
  if (!latest) {
    return {
      text: '', eventType: null, bytes: 0, originalBytes: 0,
      truncated: false, sha256: null, messageIdHash: null,
      unavailableReason: 'no_complete_assistant_text',
    };
  }
  const [messageId, state] = latest;
  const bounded = truncateUtf8Tail(state.text, maxBytes);
  return {
    ...bounded,
    eventType: 'assistant',
    sha256: crypto.createHash('sha256').update(bounded.text).digest('hex'),
    messageIdHash: crypto.createHash('sha256').update(messageId).digest('hex'),
    unavailableReason: null,
  };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  cleanCheckpointText,
  redactCheckpointSecrets,
  truncateUtf8Tail,
  extractClaudeAssistantCheckpoint,
};
