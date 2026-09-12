'use strict';
const crypto = require('node:crypto');
const { validationError } = require('./validation-contract');
const DENIAL = 'Permission denied and could not request permission from user';
const FLAGS = ['--allow-all-tools', '--disallow-temp-dir', '--no-ask-user', '--no-custom-instructions',
  '--no-auto-update', '--no-bash-env', '--disable-builtin-mcps'];
function writerPermissionArgs(help, args, explicit) {
  const fail = reason => { throw validationError('permission_policy_unavailable', 'dangerous', reason); };
  if (explicit !== true) fail('Copilot noninteractive tool approval requires explicit dangerous=true.');
  if (typeof help !== 'string' || help.length >= 32768 || FLAGS.some(flag => !new RegExp(`(^|\\s)${flag}(?=\\s|[=,]|$)`, 'm').test(help))) {
    fail('Installed Copilot help does not qualify the required noninteractive writer controls. Upgrade or configure a supported native CLI.');
  }
  const forbidden = ['--allow-all', '--yolo', '--allow-all-paths', '--allow-all-urls'];
  const options = [];
  const valued = new Set(['--prompt', '-p', '--model', '-m', '--effort', '--log-level', '--log-dir', '--output-format', '--available-tools', '--agent', '--share']);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--') break;
    if (!args[index].startsWith('-')) continue;
    options.push(args[index]);
    if (valued.has(args[index])) index++;
  }
  if (options.some(arg => forbidden.some(flag => arg === flag || arg.startsWith(flag + '=')))) fail('Broad Copilot permission overrides conflict with this writer policy.');
  // Insert before prompt data and the argument delimiter; never reinterpret it.
  const at = args.findIndex(arg => ['--prompt', '-p', '--'].includes(arg));
  const out = [...args]; out.splice(at < 0 ? out.length : at, 0, ...FLAGS.filter(flag => !options.includes(flag)));
  return out;
}
function createCopilotDenialObserver(kind) {
  let line = '', overlong = false, observed = false;
  const inspect = () => {
    const clean = line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trim();
    if (!overlong && /^(?:Error:\s*)?Permission denied and could not request permission from user[.!]?$/.test(clean)) observed = true;
    line = ''; overlong = false;
  };
  return {
    record(chunk) {
      if (kind !== 'copilot' || observed) return observed;
      for (const char of String(chunk)) {
        if (char === '\n') inspect();
        else if (line.length < 4096) line += char;
        else overlong = true;
      }
      return observed;
    },
    flush() { if (kind === 'copilot') inspect(); return observed; },
    summary() { return { count: observed ? 1 : 0, observed: observed ? 1 : 0, invalid: 0, truncated: false,
      byTool: {}, retained: [], source: 'copilot_cli_stderr', diagnosticHash: observed ? crypto.createHash('sha256').update(DENIAL).digest('hex') : null }; },
  };
}
module.exports = { writerPermissionArgs, createCopilotDenialObserver, FLAGS };
