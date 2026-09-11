'use strict';

const crypto = require('node:crypto');
const { redactCheckpointSecrets } = require('./partial-checkpoint');
const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const semantic = (v) => String(v).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  .replace(/\b\d{4}-\d\d-\d\d[T ][\d:.+-]+Z?\b/g, '<time>')
  .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>').replace(/\s+/g, ' ').trim();
const TOOL_TYPES = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list']);

class ProgressObserver {
  constructor({ parser = 'text', startedAt = Date.now(), runId = null, attemptId = null } = {}) {
    Object.assign(this, { parser, startedAt, runId, attemptId, lastActivityAt: startedAt,
      lastProgressAt: startedAt, sequence: 0, summary: '', repeated: 0, failures: 0, retryUntil: 0,
      partial: '', evidence: [], seen: new Set(), completed: new Set(), messages: new Map(), assessment: null,
      lastToolActivityAt: startedAt, materialGeneration: 0 });
    this.counts = { assistantUpdates: 0, toolsStarted: 0, toolsCompleted: 0, toolsFailed: 0, retries: 0 };
  }
  assistant(id, text, now) {
    if (typeof id === 'string') {
      const key = hash(id), old = this.messages.get(key);
      if (old === null || old === text || old?.startsWith(text)) return;
      if (old && !text.startsWith(old)) { this.messages.set(key, null); return; }
      if (this.messages.size >= 1024) this.messages.delete(this.messages.keys().next().value);
      this.messages.set(key, text);
    }
    this.add('assistant', text, text, now, { useful: true });
  }
  add(category, text, key, now, { useful = false, failure = false } = {}) {
    const fingerprint = hash(`${category}:${semantic(key)}`);
    const duplicate = this.seen.has(fingerprint);
    if (!duplicate) { if (this.seen.size >= 4096) this.seen.delete(this.seen.values().next().value); this.seen.add(fingerprint); }
    if (category === 'assistant') {
      this.repeated = duplicate ? this.repeated + 1 : 0;
      this.summary = redactCheckpointSecrets(text, 1600);
      if (!duplicate) this.counts.assistantUpdates++;
    }
    if (failure) this.failures++;
    if (useful && !duplicate && !failure) { this.lastProgressAt = now; this.failures = 0; this.materialGeneration++; }
    this.sequence++;
    this.evidence.push({ id: `e${this.sequence}`, category, at: now, duplicate, failure,
      text: category === 'assistant' ? this.summary.slice(-600) : text });
    this.evidence = this.evidence.slice(-24);
  }
  event(value, now) {
    if (this.parser === 'claude_json') {
      if (value.type === 'assistant' && Array.isArray(value.message?.content)) {
        const text = value.message.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
        if (text) this.assistant(value.message.id, text, now);
        // Operation identity is hashed privately. Names alone do not prove a loop.
        for (const b of value.message.content.filter((b) => b?.type === 'tool_use')) {
          const key = hash(JSON.stringify({ id: b.id, name: b.name }));
          if (this.completed.has(key)) continue; this.completed.add(key);
          this.counts.toolsStarted++;
          this.lastToolActivityAt = now; this.materialGeneration++;
          this.add('tool', 'Tool started; completion not yet observed', key, now);
        }
      } else if (value.type === 'system' && value.subtype === 'api_retry') {
        const delay = Math.max(0, Math.min(Number(value.retry_delay_ms) || 0, 900000));
        this.retryUntil = Math.max(this.retryUntil, now + delay);
        this.counts.retries++;
        this.add('retry', 'Provider retry reported', `${value.attempt}:${value.error_status}`, now, { failure: true });
      }
    } else if (this.parser === 'codex_json') {
      const item = value.item;
      if (value.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
        this.assistant(item.id, item.text, now);
      } else if (TOOL_TYPES.has(item?.type) && ['item.started', 'item.completed'].includes(value.type)) {
        const eventKey = hash(`${item.id}:${value.type}`);
        if (this.completed.has(eventKey)) return;
        if (this.completed.size >= 4096) this.completed.delete(this.completed.values().next().value);
        this.completed.add(eventKey);
        const complete = value.type === 'item.completed';
        const failure = complete && (item.status === 'failed' || Number.isInteger(item.exit_code) && item.exit_code !== 0);
        this.counts[complete ? 'toolsCompleted' : 'toolsStarted']++;
        this.lastToolActivityAt = now; this.materialGeneration++;
        if (failure) this.counts.toolsFailed++;
        // Nothing from command, args, aggregated_output, file contents or reasoning
        // crosses into the public projection or assessor input.
        this.add('tool', `${item.type} ${complete ? failure ? 'failed' : 'completed' : 'started'}`,
          eventKey, now, { useful: complete && !failure, failure });
      }
    }
  }
  record(chunk, now = Date.now(), channel = 'stdout') {
    this.lastActivityAt = now;
    if (channel !== 'stdout') return;
    this.partial += String(chunk || '');
    if (this.partial.length > 262144) { this.partial = ''; return; }
    let newline;
    while ((newline = this.partial.indexOf('\n')) >= 0) {
      const line = this.partial.slice(0, newline); this.partial = this.partial.slice(newline + 1);
      if (this.parser === 'claude_json' || this.parser === 'codex_json') {
        try { this.event(JSON.parse(line), now); } catch { /* unsupported or incomplete evidence remains unknown */ }
      } else if (this.parser === 'text' && line.trim() && !line.trim().startsWith('{')) {
        this.add('assistant', line, line, now, { useful: true });
      }
    }
  }
  snapshot(now = Date.now()) {
    const evidence = this.evidence.map((e) => ({ ...e }));
    const identity = { runId: this.runId, attemptId: this.attemptId, sequence: this.sequence };
    return { ...identity, hash: hash(JSON.stringify({ ...identity, evidence })),
      materialGeneration: this.materialGeneration,
      observability: ['claude_json', 'codex_json'].includes(this.parser) ? 'structured' : 'partial',
      lastActivityAt: this.lastActivityAt, lastProgressAt: this.lastProgressAt, lastToolActivityAt: this.lastToolActivityAt,
      staleProgressMs: now - this.lastProgressAt, summary: this.summary, counts: { ...this.counts },
      repeated: this.repeated, failureStreak: this.failures, retryUntil: this.retryUntil, evidence };
  }
  acceptAssessment(value, snapshot, now = Date.now()) {
    const current = this.snapshot(now);
    if (!value || value.runId !== current.runId || value.attemptId !== current.attemptId
      || value.evidenceHash !== snapshot.hash || current.materialGeneration !== snapshot.materialGeneration
      || !['productive', 'stuck', 'off_scope', 'unknown'].includes(value.verdict)
      || !Array.isArray(value.evidenceIds) || value.evidenceIds.length > 8
      || value.evidenceIds.some((id) => !snapshot.evidence.some((e) => e.id === id))
      || ['stuck', 'off_scope'].includes(value.verdict) && !value.evidenceIds.length) return false;
    this.assessment = { verdict: value.verdict, evidenceHash: snapshot.hash, evidenceIds: value.evidenceIds,
      lastProgressAt: current.lastProgressAt, materialGeneration: current.materialGeneration,
      at: now, reason: redactCheckpointSecrets(value.reason || '', 800) };
    return true;
  }
  corroboratedStall(now, idleMs) {
    const value = this.snapshot(now);
    return now >= this.retryUntil && value.staleProgressMs >= idleMs
      && now - this.lastToolActivityAt >= idleMs
      && (this.repeated >= 12 || this.failures >= 5)
      && this.assessment?.materialGeneration === value.materialGeneration
      && ['stuck', 'off_scope'].includes(this.assessment?.verdict);
  }
}
module.exports = { ProgressObserver, semantic };
