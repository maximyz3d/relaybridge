'use strict';

const fs = require('fs');
const path = require('path');

const [, , client, ...args] = process.argv;
const home = process.env.USERPROFILE;

function ensureParent(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function read(file, fallback = '') { try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; } }
function write(file, text) { ensureParent(file); fs.writeFileSync(file, text, 'utf8'); }
function escapeRe(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function decodeQuoted(value) { try { return JSON.parse(`"${value}"`); } catch { return value; } }

function tomlBlocks(text) {
  const headers = [...text.matchAll(/^\[[^\]]+\]\s*$/gm)];
  if (!headers.length) return [{ header: '', text }];
  const blocks = [];
  if (headers[0].index) blocks.push({ header: '', text: text.slice(0, headers[0].index) });
  for (let index = 0; index < headers.length; index += 1) {
    const start = headers[index].index;
    const end = index + 1 < headers.length ? headers[index + 1].index : text.length;
    blocks.push({ header: headers[index][0].trim(), text: text.slice(start, end) });
  }
  return blocks;
}

function codexSection(text, name) {
  return tomlBlocks(text).find((block) => block.header === `[mcp_servers.${name}]`)?.text || '';
}

function removeCodexSections(text, name) {
  const prefix = `[mcp_servers.${name}`;
  return tomlBlocks(text)
    .filter((block) => !(block.header === `${prefix}]` || block.header.startsWith(`${prefix}.`)))
    .map((block) => block.text)
    .join('')
    .replace(/^\s+/, '');
}

if (client === 'codex') {
  const file = path.join(home, '.codex', 'config.toml');
  const action = args[1];
  const name = args[2];
  let text = read(file);
  if (action === 'get') {
    const section = codexSection(text, name);
    if (!section) process.exit(1);
    const targetMatch = section.match(/args\s*=\s*\[\s*"([^"]+)"\s*\]/);
    const target = targetMatch ? decodeQuoted(targetMatch[1]) : (/mcp[\\/]+server\.mjs/i.test(section) ? 'C:\\legacy\\RelayBridge\\mcp\\server.mjs' : 'C:\\other\\server.js');
    const env = Object.fromEntries([...section.matchAll(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"\s*$/gm)].map((match) => [match[1], decodeQuoted(match[2])]));
    process.stdout.write(JSON.stringify({
      name,
      transport: { type: 'stdio', command: process.execPath, args: [target], env },
    }));
    process.exit(0);
  }
  if (action === 'remove') {
    write(file, removeCodexSections(text, name));
    process.exit(0);
  }
  if (action === 'add') {
    text = removeCodexSections(text, name).trimEnd();
    const envLines = [];
    for (let index = 3; index < args.length; index += 1) {
      if (args[index] !== '--env') continue;
      const [key, ...valueParts] = String(args[index + 1] || '').split('=');
      envLines.push(`${key} = ${JSON.stringify(valueParts.join('='))}`);
      index += 1;
    }
    write(file, `${text}${text ? '\n\n' : ''}[mcp_servers.${name}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(args.at(-1))}]\n${envLines.join('\n')}\n`);
    process.exit(0);
  }
}

if (client === 'claude') {
  const file = path.join(home, '.claude.json');
  const json = JSON.parse(read(file, '{"mcpServers":{}}'));
  json.mcpServers ||= {};
  const action = args[1];
  const name = action === 'add' || action === 'remove' ? args[4] : args[2];
  if (action === 'get') {
    const entry = json.mcpServers[name];
    if (!entry) process.exit(1);
    process.stdout.write(JSON.stringify(entry));
    process.exit(0);
  }
  if (action === 'remove') {
    delete json.mcpServers[name];
    write(file, JSON.stringify(json, null, 2) + '\n');
    process.exit(0);
  }
  if (action === 'add') {
    if (process.env.RELAYBRIDGE_FAKE_MCP_FAIL === 'claude-add') process.exit(17);
    const delimiter = args.indexOf('--');
    const env = {};
    for (let index = 5; index < delimiter; index += 1) {
      if (args[index] !== '-e') continue;
      const [key, ...valueParts] = String(args[index + 1] || '').split('=');
      env[key] = valueParts.join('=');
      index += 1;
    }
    json.mcpServers[name] = {
      type: 'stdio',
      command: args[delimiter + 1],
      args: args.slice(delimiter + 2),
      env,
    };
    write(file, JSON.stringify(json, null, 2) + '\n');
    process.exit(0);
  }
}

process.exit(2);
