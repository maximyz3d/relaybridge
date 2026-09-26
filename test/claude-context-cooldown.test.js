'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestBridge, completeJsonLines } = require('./helpers/temporary-bridge');

test('Claude context failures ignore transcript decoys and retain genuine terminal quota evidence', async (t) => {
  const fixture = await startTestBridge(t, (root) => {
    const script = path.join(root, 'provider.js');
    fs.writeFileSync(script, `let mode=''; process.stdin.on('data', x=>mode+=x); process.stdin.on('end',()=>{
      const error=mode.includes('diagnostic'); const status=mode.includes('status');
      console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'rate limit 429 retry-after: 14400 budget exceeded'}]}}));
      console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',content:'quota exceeded too many requests'}]}}));
      console.error('MCP auxiliary noise: 429 rate limit exceeded usd budget');
      console.log(JSON.stringify({type:'result',subtype:'success',is_error:true,result:'',terminal_reason:'rapid_refill_breaker',
        api_error_status:status?429:null,errors:error?["You've hit your weekly limit"]:[],num_turns:1,
        usage:{input_tokens:1,output_tokens:1}}));process.exitCode=1;
    });`);
    const provider = (seat) => ({ label: 'Context fixture', transport: 'subscription:anthropic', quota_seat: seat,
      oneshot_output_parser: 'claude_json', oneshot_safe: [process.execPath, script], oneshot_safe_filesystem_policy: 'read_only_enforced' });
    return { claude: provider('subscription:anthropic:default'), claude_fable: provider('subscription:anthropic:other') };
  });
  const context = await fixture.request('/api/oneshot', { kind: 'claude', prompt: 'context', dangerous: false });
  assert.equal(context.status, 200);
  assert.equal(context.body.failureClass, 'context_refill_breaker');
  assert.equal(context.body.rate_limited, false);
  assert.equal(context.body.budget_exceeded, false);
  assert.equal(context.body.dropped_out, true);
  assert.equal(context.body.stdout, '');
  assert.equal(context.body.result_schema_disagreement, true);
  const file = path.join(fixture.root, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl');
  const receipt = completeJsonLines(file).find((r) => r.receiptId === context.body.receiptId);
  assert.equal(receipt.cooldown, null);
  assert.equal(receipt.failureClass, 'context_refill_breaker');
  const quotas = await fixture.request('/api/cooldowns');
  assert.equal(quotas.body.cooling.length, 0);
  const diagnostic = await fixture.request('/api/oneshot', { kind: 'claude', prompt: 'diagnostic', dangerous: false });
  assert.equal(diagnostic.body.rate_limited, true);
  assert.equal(diagnostic.body.cooldown.reason, 'rate_limited');
  const status = await fixture.request('/api/oneshot', { kind: 'claude_fable', prompt: 'status', dangerous: false });
  assert.equal(status.body.rate_limited, true);
  assert.equal(status.body.provider_api_error_status, 429);
  assert.equal(status.body.cooldown.reason, 'rate_limited');
});
