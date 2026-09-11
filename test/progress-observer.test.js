'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { ProgressObserver } = require('../lib/progress-observer');
const { RunSupervisor } = require('../lib/run-supervisor');
const { resolveAttemptTiming } = require('../lib/cli-deadline');
const { parseCodexOutput } = require('../lib/codex-output');
test('productive default work survives 30, 45, 60 and 120 minutes; explicit deadline wins', () => {
  const supervisor = new RunSupervisor(resolveAttemptTiming({ startedAt: 0 }));
  for (let at = 60000; at <= 120 * 60000; at += 60000) {
    supervisor.recordOutput(`Completed work item ${at / 60000}\n`, at);
    assert.equal(supervisor.evaluate(at).action, 'continue');
  }
  assert.equal(supervisor.snapshot(7200000).hardCapRemainingMs, null);
  const bounded = new RunSupervisor(resolveAttemptTiming({ startedAt: 0, timeoutMs: 30000 }));
  bounded.recordOutput('New progress\n', 30000); assert.equal(bounded.evaluate(30000).reason, 'hard_cap');
  const operator = new RunSupervisor(resolveAttemptTiming({ startedAt: 0, entry: { supervisor: { hardCapMs: 2700000 } } }));
  assert.equal(operator.evaluate(2700000).reason, 'hard_cap');
  const disabled = new RunSupervisor(resolveAttemptTiming({ startedAt: 0, globals: { adaptive: false } }));
  disabled.recordOutput('Still progressing\n', 2700000); assert.equal(disabled.evaluate(2700000).reason, 'hard_cap');
});
test('private reasoning, command input/output, stderr and metadata do not become public progress', () => {
  const p = new ProgressObserver({ parser: 'codex_json', startedAt: 0 });
  const privateText = 'VERY_PRIVATE_REASONING_AND_TOOL_OUTPUT';
  p.record(JSON.stringify({ type: 'item.completed', item: { id: 'a', type: 'reasoning', text: privateText } }) + '\n', 1000);
  p.record(JSON.stringify({ type: 'item.completed', timestamp: 'changed', item: { id: 'b', type: 'command_execution',
    command: privateText, aggregated_output: privateText, exit_code: 0 } }) + '\n', 2000);
  p.record(privateText, 3000, 'stderr');
  assert.equal(JSON.stringify(p.snapshot()).includes(privateText), false);
  assert.equal(p.snapshot().counts.toolsCompleted, 1);
});
test('timestamp changes and split chunks cannot manufacture assistant novelty', () => {
  const p = new ProgressObserver({ parser: 'claude_json', startedAt: 0 });
  for (let i = 0; i < 15; i++) {
    const event = JSON.stringify({ type: 'assistant', uuid: `changing-${i}`, message: { id: `msg-${i}`,
      content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: `Retry at 2026-09-11T12:00:${String(i).padStart(2, '0')}Z` }] } }) + '\n';
    p.record(event.slice(0, 12), i * 1000); p.record(event.slice(12), i * 1000);
  }
  assert.equal(p.snapshot().counts.assistantUpdates, 1); assert.equal(p.snapshot().lastProgressAt, 0);
  assert.ok(p.snapshot().repeated >= 12);
});
test('unknown assessments cannot stop; current cited stuck evidence can, newer useful work invalidates it', () => {
  const p = new ProgressObserver({ parser: 'text', startedAt: 0, runId: 'run_one', attemptId: 'attempt1' });
  for (let i = 0; i < 13; i++) p.record('Repeated unchanged assistant checkpoint\n', i * 1000);
  const snap = p.snapshot(300000);
  const verdict = { runId: 'run_one', attemptId: 'attempt1', evidenceHash: snap.hash,
    verdict: 'unknown', evidenceIds: [snap.evidence[0].id], reason: 'Insufficient evidence' };
  assert.equal(p.acceptAssessment(verdict, snap, 300000), true); assert.equal(p.corroboratedStall(300000, 240000), false);
  p.record('Repeated unchanged assistant checkpoint\n', 301000);
  assert.equal(p.acceptAssessment({ ...verdict, verdict: 'stuck' }, snap, 302000), true);
  assert.equal(p.corroboratedStall(302000, 240000), true);
  p.record('Completed a new verified milestone\n', 303000);
  assert.equal(p.corroboratedStall(303000, 240000), false);
  assert.equal(p.acceptAssessment({ ...verdict, verdict: 'stuck' }, snap, 304000), false);
  assert.equal(p.acceptAssessment({ ...verdict, attemptId: 'old' }, p.snapshot(), 304000), false);
});
test('Codex JSONL final result requires terminal ordering and keeps cached usage included', () => {
  const lines = [ { type: 'item.completed', item: { type: 'reasoning', text: 'never expose' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Final public answer' } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20 } } ].map(JSON.stringify).join('\n');
  const good = parseCodexOutput(lines, { exitCode: 0 });
  assert.equal(good.output, 'Final public answer'); assert.equal(good.usage.total_tokens, 120);
  assert.equal(good.usage.cache_input_included, true);
  assert.equal(parseCodexOutput(lines, { exitCode: 0, ignoreTerminalResult: true }).output, '');
  const newer = lines + '\n' + JSON.stringify({ type: 'turn.started' });
  assert.equal(parseCodexOutput(newer, { exitCode: 0 }).output, '');
  assert.equal(JSON.stringify(good).includes('never expose'), false);
});
test('assessments cannot cite omitted evidence or survive a distinct operation start', () => {
  const p = new ProgressObserver({ parser: 'codex_json', startedAt: 0, runId: 'run_one', attemptId: 'a1' });
  for (let i = 0; i < 14; i++) p.record(JSON.stringify({ type: 'item.completed', item: { id: 'm'+i, type: 'agent_message', text: 'Repeated unchanged checkpoint' } })+'\n', i*1000);
  const snap = p.snapshot(300000); snap.evidence = snap.evidence.slice(-6);
  const verdict = { runId: 'run_one', attemptId: 'a1', evidenceHash: snap.hash, verdict: 'stuck', evidenceIds: ['e1'] };
  assert.equal(p.acceptAssessment(verdict, snap, 300000), false);
  verdict.evidenceIds = [snap.evidence[0].id]; assert.equal(p.acceptAssessment(verdict, snap, 300000), true);
  p.record(JSON.stringify({ type: 'item.started', item: { id: 'long-tool', type: 'command_execution' } })+'\n', 301000);
  assert.equal(p.corroboratedStall(900000, 240000), false);
  assert.equal(p.acceptAssessment(verdict, snap, 900000), false);
});
test('Codex refuses contradictory messages and work after a terminal, while preserving native error classification evidence', () => {
  const message = { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'A' } };
  const terminal = { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } };
  const parse = (events) => parseCodexOutput(events.map(JSON.stringify).join('\n'), { exitCode: 0 });
  assert.equal(parse([message, terminal, { type: 'item.started', item: { id: 'tool', type: 'command_execution' } }]).output, '');
  assert.equal(parse([message, { ...message, item: { ...message.item, text: 'B' } }, terminal]).output, '');
  const failed = parse([{ type: 'turn.failed', error: { message: 'You have hit your usage limit' } }]);
  assert.equal(failed.diagnosticIsProviderError, true); assert.match(failed.diagnostic, /usage limit/);
});
test('Claude completion is matched, deduplicated and private, and invalidates a prior stuck verdict', () => {
  const p = new ProgressObserver({ parser: 'claude_json', startedAt: 0, runId: 'run_one', attemptId: 'a1' });
  for (let i = 0; i < 13; i++) p.event({ type: 'assistant', message: { id: 'msg'+i, content: [{ type: 'text', text: 'Repeated checkpoint' }] } }, i * 1000);
  p.event({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'secret-tool-id', name: 'private-name', input: 'private-input' }] } }, 20000);
  const snap = p.snapshot(300000);
  p.acceptAssessment({ runId: 'run_one', attemptId: 'a1', evidenceHash: snap.hash, verdict: 'stuck', evidenceIds: [snap.evidence[0].id] }, snap, 300000);
  assert.equal(p.corroboratedStall(300000, 240000), true);
  const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'secret-tool-id', content: 'private-output' }] } };
  p.event(result, 301000); p.event(result, 302000);
  p.event({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'unmatched' }] } }, 303000);
  const current = p.snapshot(304000);
  assert.equal(current.counts.toolsCompleted, 1); assert.equal(current.lastProgressAt, 301000);
  assert.equal(current.lastToolActivityAt, 301000); assert.equal(p.corroboratedStall(304000, 240000), false);
  for (const secret of ['secret-tool-id', 'private-name', 'private-input', 'private-output', 'unmatched']) assert.equal(JSON.stringify(current).includes(secret), false);
  assert.equal(p.acceptAssessment({ runId: 'run_one', attemptId: 'a1', evidenceHash: snap.hash, verdict: 'stuck', evidenceIds: [snap.evidence[0].id] }, snap, 305000), false);
});
test('Claude failed completions do not invent useful progress and tool identity storage stays bounded', () => {
  const p = new ProgressObserver({ parser: 'claude_json', startedAt: 0 });
  for (let i = 0; i < 4200; i++) {
    p.event({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool'+i }] } }, i + 1);
    p.event({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool'+i, is_error: true }] } }, i + 2);
  }
  assert.equal(p.claudeTools.size, 4096); assert.equal(p.counts.toolsFailed, 4200); assert.equal(p.lastProgressAt, 0);
});
