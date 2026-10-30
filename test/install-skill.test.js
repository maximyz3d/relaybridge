'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

test('skill installation discovers RelayBridge and its slash entry, preserves user files, and is repeatable', {
  skip: process.platform === 'win32',
}, (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-skills-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const promptDir = path.join(profile, '.codex/prompts'); fs.mkdirSync(promptDir, { recursive: true });
  const prompt = path.join(promptDir, 'relaybridge.md'); fs.writeFileSync(prompt, 'user prompt');
  const install = (extra = {}) => execFileSync('sh', [path.join(ROOT, 'install-skill.sh')], {
    cwd: profile, encoding: 'utf8', env: { ...process.env, HOME: profile, CODEX_HOME: '', ...extra },
  });
  assert.match(install(), /\/prompts:relaybridge/);
  for (const relative of ['.agents/skills/relaybridge', '.codex/skills/relaybridge', '.claude/skills/relaybridge']) {
    assert.equal(fs.realpathSync(path.join(profile, relative)), path.join(ROOT, 'skills/relaybridge'));
    assert.ok(fs.existsSync(path.join(profile, relative, 'agents/openai.yaml')));
  }
  assert.equal(fs.realpathSync(prompt), path.join(ROOT, 'skills/relaybridge/codex-prompts/relaybridge.md'));
  const backups = () => fs.readdirSync(promptDir).filter((name) => name.startsWith('relaybridge.md.backup.'));
  assert.equal(backups().length, 1); assert.equal(fs.readFileSync(path.join(promptDir, backups()[0]), 'utf8'), 'user prompt');
  assert.match(install(), /verified/); assert.equal(backups().length, 1);
  const customCodex = path.join(profile, 'custom-codex'); install({ CODEX_HOME: customCodex });
  assert.equal(fs.realpathSync(path.join(customCodex, 'prompts/relaybridge.md')), fs.realpathSync(prompt));
  assert.equal(fs.realpathSync(path.join(customCodex, 'skills/relaybridge')), path.join(ROOT, 'skills/relaybridge'));
});
