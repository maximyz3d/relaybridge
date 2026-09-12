'use strict';
// Deterministic provider diagnostics fixtures; external requests are intercepted.
// Nothing executes on import. All generated files belong to a test tempdir.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const { startTestBridge, completeJsonLines } = require(path.join(ROOT, 'test/helpers/temporary-bridge'));

function makeHostedFixture(t, initial = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-catalog-contract-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const statePath = path.join(dir, 'state.json');
  const eventsPath = path.join(dir, 'events.jsonl');
  const preload = path.join(dir, 'preload.cjs');
  const state = { ids:['llama-3.1-8b-instant'], status:200, ...initial };
  const update = patch => { Object.assign(state, patch); fs.writeFileSync(statePath, JSON.stringify(state)); };
  update({});
  fs.writeFileSync(preload, `
    'use strict';
    const fs = require('node:fs');
    const originalFetch = global.fetch;
    const statePath = ${JSON.stringify(statePath)};
    const eventsPath = ${JSON.stringify(eventsPath)};
    global.fetch = async (input, options = {}) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      // Only fixture REST loopback may reach a real socket. Every hosted request
      // is intercepted and an unexpected external host fails closed.
      if (url.hostname === '127.0.0.1' || url.hostname === '[::1]') return originalFetch(input, options);
      if (url.hostname !== 'catalog.fixture.invalid') throw new Error('TEST_EXTERNAL_NETWORK_BLOCKED');
      const method = String(options.method || 'GET').toUpperCase();
      const headers = new Headers(options.headers);
      const auth = headers.get('authorization');
      const keySlot = auth === 'Bearer fixture-key-a' ? 'a' : auth === 'Bearer fixture-key-b' ? 'b' : 'other';
      fs.appendFileSync(eventsPath, JSON.stringify({ method, path:url.pathname,
        authenticated:!!auth, keySlot, redirect:options.redirect }) + '\\n');
      const captured = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (captured.releasePath) {
        await new Promise((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const timer = setInterval(() => {
            if (options.signal?.aborted || Date.now() > deadline) {
              clearInterval(timer); reject(Object.assign(new Error('fixture aborted'), {name:'AbortError'}));
            } else if (fs.existsSync(captured.releasePath)) { clearInterval(timer); resolve(); }
          }, 5);
        });
      }
      if (method === 'GET' && url.pathname === '/openai/v1/models') {
        const document = captured.document ?? { object:'list', data:captured.ids.map(id => ({ id, object:'model', active:true })) };
        return new Response(captured.raw ?? JSON.stringify(document), {
          status:captured.status,
          headers:{'content-type':'application/json', ...(captured.location ? {location:captured.location} : {})},
        });
      }
      if (method === 'POST' && url.pathname === '/openai/v1/chat/completions') {
        return Response.json({ model:'llama-3.1-8b-instant', choices:[{message:{role:'assistant',content:'Fixture response.'},finish_reason:'stop'}],
          usage:{prompt_tokens:1,completion_tokens:2,total_tokens:3} });
      }
      throw new Error('TEST_UNEXPECTED_HOSTED_REQUEST');
    };
  `);
  const production = JSON.parse(fs.readFileSync(path.join(ROOT, 'cli-config.json'), 'utf8')).groq_llama_fast;
  return {
    dir, update, events:() => completeJsonLines(eventsPath),
    async start(overrides = {}, env = {}) {
      return startTestBridge(t, () => ({ groq_llama_fast:{...production,
        api_base_url:'https://catalog.fixture.invalid/openai/v1/chat/completions',
        // Proposed explicit per-adapter catalog configuration. Rename only this
        // field if root chooses another config key; endpoint must stay same-origin.
        models_url:'https://catalog.fixture.invalid/openai/v1/models',
        api_key_env:'RB_FIXTURE_API_KEY_A', ...overrides,
      }}), {nodeArgs:['--require',preload], env:{
        RB_FIXTURE_API_KEY_A:'fixture-key-a', RB_FIXTURE_API_KEY_B:'fixture-key-b', ...env,
      }});
    },
  };
}

async function startAnswerFixture(t, { mode='ready', policy='read_only_enforced', credentialEnv=null } = {}) {
  let marker, statePath;
  const bridge = await startTestBridge(t, root => {
    marker = path.join(root, 'answer-events.jsonl');
    statePath = path.join(root, 'answer-state.json');
    fs.writeFileSync(statePath, JSON.stringify({mode}));
    const script = path.join(root, 'answer-provider.cjs');
    fs.writeFileSync(script, `
      const fs=require('node:fs');
      const [operation,marker,statePath]=process.argv.slice(2);
      const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
      const event={operation,pid:process.pid};
      fs.appendFileSync(marker,JSON.stringify(event)+'\\n');
      if(operation==='version'){process.stdout.write('fixture-pwm 1.0');process.exit(0);}
      if(operation==='auth'){process.stdout.write('subscription CLI authenticated');process.exit(0);}
      process.stdin.resume();
      process.stdin.on('end',()=>{
        if(state.mode==='hang'){setInterval(()=>{},1000);return;}
        if(state.mode==='sentinel'){process.stdout.write('No answer received\\nhttps://example.test/partial');return;}
        if(state.mode==='parse'){process.stdout.write('ResponseParsingError: failed to parse API response');return;}
        if(state.mode==='auth'){process.stderr.write('AuthenticationError: invalid authentication token');process.exitCode=1;return;}
        if(state.mode==='quota'){process.stderr.write('RateLimitError: HTTP 429 rate limit exceeded');process.exitCode=1;return;}
        process.stdout.write('RELAYBRIDGE_ANSWER_OK');
      });
    `);
    return {perplexity:{label:'Perplexity fixture', model:'auto',
      safe:[process.execPath], dangerous:[process.execPath],
      diagnostic_binary:process.execPath,
      probe:[process.execPath,script,'auth',marker,statePath],
      probe_expect:'authenticated',probe_auth_authoritative:true,
      version_probe:[process.execPath,script,'version',marker,statePath],
      oneshot_safe:[process.execPath,script,'answer',marker,statePath],
      oneshot_dangerous:[process.execPath,script,'answer',marker,statePath],
      oneshot_capabilities:{safe:['model_invocation','prompt_only'],dangerous:['model_invocation','prompt_only']},
      oneshot_safe_filesystem_policy:policy,
      strip_env:['PERPLEXITY_API_KEY','PPLX_API_KEY','PPLX_ALLOW_PAID_API_FALLBACK'],
      ...(credentialEnv ? {credential_env:credentialEnv} : {}),
    }};
  });
  return {...bridge,events:()=>completeJsonLines(marker),
    setMode:mode=>fs.writeFileSync(statePath,JSON.stringify({mode})),
    receipts:()=> {
      const dir=path.join(bridge.root,'data/receipts');
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name=>name.endsWith('.jsonl'))
        .flatMap(name=>completeJsonLines(path.join(dir,name))) : [];
    },
  };
}

module.exports = {ROOT,makeHostedFixture,startAnswerFixture};
