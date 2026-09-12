'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalQuotaObserver } = require('../lib/terminal-quota');
const diagnostics = {
  copilot: 'You have exceeded your monthly quota (Request ID: ABC:123)',
  cursor: "ActionRequiredError: You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more.",
  grok: "2026-08-24T04:20:30Z ERROR responses API error status=429 Too Many Requests\nerror_message=subscription:free-usage-exhausted: You've used all the included free usage for model grok-4.6 for now.\nUsage resets over a rolling 24-hour window — tokens (actual/limit): 552,305/500,000.\nUpgrade to a Grok subscription for higher limits: https://grok.com/supergrok model_id=grok-4.6",
};
test('standalone native PTY quota diagnostics remain scoped and do not invent headroom', () => {
  for (const [provider, diagnostic] of Object.entries(diagnostics)) {
    const text = '\x1b[31m' + diagnostic.replace(/\n/g, '\r\n') + '\x1b[0m\r\n';
    const observer = createTerminalQuotaObserver(provider);
    for (let n = 0; n < text.length; n += 3) observer.output(text.slice(n, n + 3));
    const quota = observer.finish(1);
    assert.equal(quota.provider, provider);
    assert.equal(quota.scope, provider === 'grok' ? 'model' : 'account');
    assert.equal(quota.percentRemaining, provider === 'grok' ? 0 : null);
    assert.equal(observer.finish(0), null);
    assert.equal(observer.finish(1, 'operator_cancelled'), null);
    const example = createTerminalQuotaObserver(provider); example.output('Example: ' + text); assert.equal(example.finish(1), null);
    const echoed = createTerminalQuotaObserver(provider); echoed.input(diagnostic); echoed.output(text); assert.equal(echoed.finish(1), null);
    const wrong = createTerminalQuotaObserver('powershell'); wrong.output(text); assert.equal(wrong.finish(1), null);
  }
});
