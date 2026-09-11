'use strict';

const fs = require('node:fs');
const path = require('node:path');

const NOT_FILES = new Set(['node.js', 'next.js', 'vue.js', 'three.js', 'd3.js', 'express.js',
  'react.js', 'angular.js', 'jquery.js', 'chart.js', 'ember.js', 'backbone.js']);
const EXTENSION = /\.(?:[A-Za-z0-9]{1,8})(?::\d+(?::\d+)?)?(?:#L?\d+(?:[-:]L?\d+)?)?$/;
const BARE_SOURCE = /^[\w.-]+\.(?:js|mjs|cjs|jsx|ts|tsx|py|go|rs|java|rb|php|c|h|cpp|hpp|cs|json|ya?ml|toml|md|sh|ps1|sql|html|css|scss|vue|swift|kt)(?::\d+(?::\d+)?)?(?:#L?\d+(?:[-:]L?\d+)?)?$/i;

// Consume complete links before examining free text: a Markdown label is not
// a second filename. Bound text, individual tokens and retained citations.
function extractReferencedPaths(text, limit = 60) {
  const out = new Set();
  const cap = Math.min(60, Math.max(0, Number.isInteger(limit) ? limit : 60));
  let source = String(text || '').slice(0, 120000);
  const add = (raw, explicit = false) => {
    let value = raw.trim();
    if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1);
    if (out.size >= cap || !value || value.length > 2048 || /^https?:/i.test(value)
      || /^node_modules[\\/]/.test(value) || NOT_FILES.has(value.toLowerCase())) return;
    let decoded;
    try { decoded = decodeURIComponent(value); } catch { decoded = value; }
    if (/^file:/i.test(value) || ((explicit || /[\\/]/.test(decoded) || BARE_SOURCE.test(decoded)) && EXTENSION.test(decoded))) out.add(value);
  };
  const definitions = new Map();
  source = source.replace(/^ {0,3}\[([^\]\r\n]{1,512})\]:\s*(<[^>\r\n]{1,2048}>|\S{1,2048})[^\r\n]*$/gm,
    (span, label, target) => { if (definitions.size < 256) definitions.set(label.trim().toLowerCase(), target); return ' '.repeat(span.length); });
  const balancedEnd = (start, open, close, bound) => {
    let depth = 0;
    for (let index = start; index < Math.min(source.length, start + bound); index++) {
      if (source[index] === '\n' || source[index] === '\r') break;
      if (source[index] === '\\') { index++; continue; }
      if (source[index] === open) depth++;
      if (source[index] === close && --depth === 0) return index;
    }
    return -1;
  };
  // A bounded delimiter walk supports nested labels and parentheses without
  // backtracking regexes. Mask complete spans, including unresolved references.
  const spans = [];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '`' || source[index] === '<') {
      const end = source.indexOf(source[index] === '`' ? '`' : '>', index + 1);
      if (end > index && end - index <= 2048 && !/[\r\n]/.test(source.slice(index, end))) { index = end; continue; }
    }
    if (source[index] !== '[') continue;
    const labelEnd = balancedEnd(index, '[', ']', 1024);
    if (labelEnd < 0) continue;
    const label = source.slice(index + 1, labelEnd), next = labelEnd + 1;
    let end = labelEnd;
    if (source[next] === '(') {
      end = balancedEnd(next, '(', ')', 2048);
      if (end < 0) end = labelEnd;
      else add(source.slice(next + 1, end).replace(/\s+["'][^"']*["']$/, ''), true);
    } else if (source[next] === '[') {
      end = balancedEnd(next, '[', ']', 1024);
      if (end < 0) end = labelEnd;
      else { const target = definitions.get((source.slice(next + 1, end) || label).trim().toLowerCase()); if (target) add(target, true); }
    } else { const target = definitions.get(label.trim().toLowerCase()); if (target) add(target, true); }
    spans.push([index, end + 1]); index = end;
  }
  let previous = 0, masked = '';
  for (const [start, end] of spans) { masked += source.slice(previous, start) + ' '.repeat(end - start); previous = end; }
  source = masked + source.slice(previous);
  source = source.replace(/`([^`\r\n]{1,2048})`|<([^<>\r\n]{1,2048})>/g,
    (span, code, angle) => { add(code || angle); return ' '.repeat(span.length); });
  for (const match of source.matchAll(/[^\s`"'<>()[\]{},;!?]{1,2048}/g)) add(match[0].replace(/[.]+$/, ''));
  return [...out];
}

function normalizedCitation(raw) {
  let value = raw.replace(/(?::\d+(?::\d+)?|#L?\d+(?:[-:]L?\d+)?)$/, '');
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'file:' || (url.hostname && url.hostname.toLowerCase() !== 'localhost') || url.search || url.hash) return { status: 'invalid_uri' };
      value = decodeURIComponent(/^file:\/\/[A-Za-z]:(?=\/)/i.test(value)
        ? value.replace(/^file:\/\//i, '') : value.replace(/^file:(?:\/\/[^/]*)?/i, ''));
      if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1);
    } catch { return { status: 'invalid_uri' }; }
  } else {
    try { value = decodeURIComponent(value); } catch { return { status: 'invalid_uri' }; }
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) return { status: 'invalid_uri' };
  if (process.platform !== 'win32' && (/^[A-Za-z]:/.test(value) || value.startsWith('\\\\')))
    return { status: 'foreign_platform' };
  if (process.platform !== 'win32') value = value.replace(/\\/g, '/');
  if (/^[A-Za-z]:(?![\\/])/.test(value)) return { status: 'unverifiable' };
  if (process.platform === 'win32' && value.startsWith('/') && !value.startsWith('//')) return { status: 'foreign_platform' };
  return { value };
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function ambiguousParentTraversal(root, value) {
  const pathRoot = path.isAbsolute(value) ? path.parse(value).root : '';
  const parts = value.slice(pathRoot.length).split(/[\\/]/);
  if (!parts.includes('..')) return false;
  let cursor = pathRoot || root;
  for (let index = 0; index < parts.length; index++) {
    if (!parts[index]) continue;
    cursor = path.join(cursor, parts[index]);
    try { if (fs.lstatSync(cursor).isSymbolicLink() && parts.slice(index + 1).includes('..')) return true; }
    catch {}
  }
  return false;
}

// Follow existing ancestors even for a missing leaf. A symlink to an outside
// directory cannot turn an outside citation into an in-repo "present" or
// "missing" result. Metadata only; no file contents or network probes.
function canonicalTarget(target) {
  const suffix = []; let cursor = target;
  for (let depth = 0; depth < 256; depth++) {
    try { return { target: path.join(fs.realpathSync(cursor), ...suffix.reverse()), exists: suffix.length === 0 }; }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
      // A dangling symlink is not an ordinary absent file with a known scope.
      try { if (fs.lstatSync(cursor).isSymbolicLink()) return null; } catch {}
      const parent = path.dirname(cursor);
      if (parent === cursor) return null;
      suffix.push(path.basename(cursor)); cursor = parent;
    }
  }
  return null;
}

function basenameIndex(root, { maxEntries = 10000, maxDirectories = 1000 } = {}) {
  const names = new Map(), pending = [root];
  let entries = 0, directories = 0, complete = true;
  while (pending.length) {
    const directory = pending.pop();
    if (++directories > maxDirectories) { complete = false; break; }
    let children;
    try { children = fs.readdirSync(directory, { withFileTypes: true }); }
    catch { complete = false; continue; }
    for (const child of children) {
      if (++entries > maxEntries) { complete = false; break; }
      if (child.name === '.git' || child.name === 'node_modules') continue;
      const target = path.join(directory, child.name);
      if (child.isDirectory()) pending.push(target);
      else if (child.isFile() || child.isSymbolicLink()) {
        const canonical = canonicalTarget(target);
        if (!canonical || !inside(root, canonical.target)) continue;
        try { if (!fs.statSync(canonical.target).isFile()) { complete = false; continue; } }
        catch { continue; }
        const key = process.platform === 'win32' ? child.name.toLowerCase() : child.name;
        if (!names.has(key)) names.set(key, new Set());
        names.get(key).add(canonical.target);
      }
    }
    if (entries > maxEntries) break;
  }
  return { names, complete, entries, directories, excludedDirectories: ['.git', 'node_modules'] };
}

function verifyReferencedPaths(output, cwd, { minPaths = 1, maxEntries, maxDirectories } = {}) {
  let root;
  try { if (!cwd || !fs.statSync(cwd).isDirectory()) throw new Error(); root = fs.realpathSync(cwd); }
  catch { return { checked: false, reason: 'no readable cwd to verify against' }; }
  const referenced = extractReferencedPaths(output);
  const present = [], missing = [], citations = [], seen = new Set();
  let index = null;
  if (referenced.length >= minPaths) for (const raw of referenced) {
    const normalized = normalizedCitation(raw);
    if (normalized.status) { citations.push({ reference: raw, status: normalized.status }); continue; }
    if (ambiguousParentTraversal(root, normalized.value)) { citations.push({ reference: raw, status: 'unverifiable' }); continue; }
    let absolute = path.resolve(root, normalized.value);
    let canonical;
    if (!/[\\/]/.test(normalized.value) && !path.isAbsolute(normalized.value)) {
      index ||= basenameIndex(root, { maxEntries, maxDirectories });
      const name = process.platform === 'win32' ? normalized.value.toLowerCase() : normalized.value;
      const matches = [...(index.names.get(name) || [])];
      if (matches.length > 1) { citations.push({ reference: raw, status: 'ambiguous', matches: matches.slice(0, 10).map(p => path.relative(root, p)) }); continue; }
      if (!index.complete) { citations.push({ reference: raw, status: 'unverifiable', reason: 'basename_scan_incomplete' }); continue; }
      if (matches.length === 1) canonical = { target: matches[0], exists: true };
    }
    canonical ||= inside(root, absolute) ? canonicalTarget(absolute) : { target: absolute };
    const status = !canonical ? 'unverifiable' : !inside(root, canonical.target) ? 'outside_workspace'
      : canonical.exists ? 'present' : 'missing';
    const key = canonical && (process.platform === 'win32' ? canonical.target.toLowerCase() : canonical.target);
    const duplicate = key && seen.has(key);
    citations.push({ reference: raw, status, ...(['present', 'missing'].includes(status)
      ? { relativePath: path.relative(root, canonical.target), duplicate: !!duplicate } : {}) });
    if (!duplicate && status === 'present') present.push(raw);
    else if (!duplicate && status === 'missing') missing.push(raw);
    if (key) seen.add(key);
  }
  const total = present.length + missing.length;
  const uncertain = citations.some(c => !['present', 'missing'].includes(c.status));
  const confidence = !total ? (uncertain ? 'unverifiable' : 'no-paths-cited') : !present.length
    ? (uncertain ? 'unverifiable' : 'likely-fabricated')
    : missing.length > present.length ? 'suspect' : missing.length ? 'partial' : uncertain ? 'partial' : 'ok';
  return { checked: true, referenced, present, missing, citations, confidence,
    ...(index ? { basenameScan: { complete: index.complete, entries: index.entries, directories: index.directories,
      excludedDirectories: index.excludedDirectories } } : {}),
    note: confidence === 'likely-fabricated' ? 'every checkable file path cited in this answer is absent from the workspace — treat the result as ungrounded'
      : confidence === 'suspect' ? 'most checkable cited paths are absent from the workspace' : null };
}

module.exports = { extractReferencedPaths, verifyReferencedPaths };
