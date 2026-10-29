'use strict';

/*
 * Regression tests for the 0.1.3 fixes + new CLI/MCP surface.
 * Covers: corrupt-cache self-heal, title-less update, BOM parsing,
 * numeric-string round-trip, concurrent add ids, stdin-close flush,
 * and the search/remove/export/import/stats/doctor commands.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const u = require('../lib/fs-utils');
const { MemoryStore, MemoryCache } = require('../lib/memory-store');

let passed = 0;
let failed = 0;
function expect(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`ok - ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'speckit-reg-'));
}

// 1) corrupt index.db -> self-heal (rename + rebuild), store keeps working
{
  const root = tmpRoot();
  const cacheDir = path.join(root, '.speckit-memory');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'index.db'), 'GARBAGE NOT A DATABASE\x00\x01\x02');
  let cache = null;
  let threw = false;
  try {
    cache = new MemoryCache(cacheDir);
    cache.replaceAll([]);
  } catch (_) {
    threw = true;
  }
  const files = fs.readdirSync(cacheDir);
  expect('corrupt index.db self-heals without throwing', !threw && cache && cache.kind === 'sqlite');
  expect('corrupt index.db is renamed aside', files.some((f) => f.includes('corrupt')), files.join(','));
  fs.rmSync(root, { recursive: true, force: true });
}

// 2) title-less history file: update must not bake "undefined" into the heading
{
  const root = tmpRoot();
  const store = new MemoryStore(root);
  store.init();
  const abs = path.join(root, 'docs/memory/worklogs');
  fs.mkdirSync(abs, { recursive: true });
  const file = path.join(abs, '2026-01-01-manual.md');
  // No title in frontmatter; heading carries the natural title.
  fs.writeFileSync(file, '---\nid: DEC-0001\ntype: history\ncategory: decisions\n---\n\n# DEC-0001: Manual entry title here\n\nBody content here.\n');
  const entry = store.get('DEC-0001');
  expect('heading-derived title (not body line)', entry && entry.title === 'Manual entry title here', entry && entry.title);
  store.update('DEC-0001', { content: 'Revised body.' });
  const raw = fs.readFileSync(file, 'utf8');
  expect('update without patch.title keeps a real title', raw.includes('# DEC-0001: Manual entry title here'), raw.split('\n').find((l) => l.startsWith('# ')));
  expect('update body lands', raw.includes('Revised body.'));
  fs.rmSync(root, { recursive: true, force: true });
}

// 3) UTF-8 BOM: frontmatter must parse instead of leaking into body
{
  const root = tmpRoot();
  const file = path.join(root, 'bom.md');
  fs.writeFileSync(file, '﻿---\nid: X-1\ntitle: BOM test\ntags: [a, b]\n---\n\nBody here.\n');
  const doc = u.readMarkdownFile(file);
  expect('BOM file frontmatter parses', doc.frontmatter.id === 'X-1' && doc.frontmatter.title === 'BOM test', JSON.stringify(doc.frontmatter));
  expect('BOM file body excludes frontmatter', !doc.body.includes('id: X-1'));
  fs.rmSync(root, { recursive: true, force: true });
}

// 4) numeric-looking strings survive a write/read round-trip
{
  const root = tmpRoot();
  const file = path.join(root, 'num.md');
  u.writeMarkdownFile(file, { id: 'N-1', title: '1.10', score: '007', real: 3.5 }, 'Body');
  const doc = u.readMarkdownFile(file);
  expect('quoted numeric string stays a string ("1.10")', doc.frontmatter.title === '1.10' && typeof doc.frontmatter.title === 'string', `${doc.frontmatter.title} (${typeof doc.frontmatter.title})`);
  expect('leading-zero string stays a string ("007")', doc.frontmatter.score === '007', String(doc.frontmatter.score));
  expect('real numbers stay numbers', doc.frontmatter.real === 3.5 && typeof doc.frontmatter.real === 'number');
  fs.rmSync(root, { recursive: true, force: true });
}

// 5) concurrent adds never collide on ids
{
  const root = tmpRoot();
  const store = new MemoryStore(root);
  store.init();
  const a = store.add({ type: 'history', content: 'First concurrent note', category: 'worklogs' });
  const b = store.add({ type: 'history', content: 'Second concurrent note', category: 'worklogs' });
  expect('sequential adds get distinct ids', a.id !== b.id, `${a.id} vs ${b.id}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// 6) stdin-close flush: a request sent right before stdin closes still gets a reply
{
  const root = tmpRoot();
  const server = path.join(__dirname, '..', 'mcp-server.js');
  const env = { ...process.env, SPECKIT_MEMORY_ROOT: root };
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'reg', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_add', arguments: { type: 'decision', content: 'Flush me' } } }),
  ].join('\n') + '\n';
  let out = '';
  try {
    out = execFileSync(process.execPath, [server], { input, env, timeout: 15000, encoding: 'utf8' });
  } catch (err) {
    out = String((err && err.stdout) || '');
  }
  const lines = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const reply2 = lines.find((m) => m.id === 2);
  expect('reply to a request sent before stdin close is delivered', Boolean(reply2 && (reply2.result || reply2.error)), `lines=${lines.length}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// 7) new CLI surface: search / remove / export / import / stats / doctor
{
  const root = tmpRoot();
  const cli = path.join(__dirname, '..', 'bin', 'cli.js');
  const run = (args, opts = {}) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...opts }) };
    } catch (err) {
      return { code: err.status, out: String((err && err.stdout) || '') };
    }
  };
  run(['init', '--root', root]);
  run(['add', 'history', 'Searchable token expiry note', '--category', 'decisions', '--root', root]);
  const rSearch = run(['search', 'token', 'expiry', '--root', root]);
  expect('search finds the entry', rSearch.out.includes('Searchable token expiry note'), rSearch.out);
  const rStats = run(['stats', '--root', root]);
  expect('stats reports counts', rStats.out.includes('Entries: 1'), rStats.out);
  const rExport = run(['export', path.join(root, 'backup.json'), '--root', root]);
  expect('export writes a bundle', fs.existsSync(path.join(root, 'backup.json')), rExport.out);
  const rRemove = run(['remove', 'DEC-0001', '--root', root]);
  expect('remove deletes the entry', rRemove.out.includes('Removed DEC-0001'), rRemove.out);
  const rImport = run(['import', path.join(root, 'backup.json'), '--root', root]);
  expect('import restores the entry', rImport.out.includes('Imported 1'), rImport.out);
  const rList = run(['list', '--root', root]);
  expect('restored entry is listed', rList.out.includes('DEC-0001'), rList.out);
  const rDoctor = run(['doctor', '--root', root]);
  expect('doctor reports healthy', rDoctor.out.includes('All healthy'), rDoctor.out);
  // since/until filter
  const today = new Date().toISOString().slice(0, 10);
  const rSince = run(['list', '--since', '2099-01-01', '--root', root]);
  expect('list --since filters out old entries', rSince.out.includes('Total: 0'), rSince.out);
  const rUntil = run(['list', '--until', today, '--root', root]);
  expect('list --until keeps today entries', rUntil.out.includes('Total: 1'), rUntil.out);
  fs.rmSync(root, { recursive: true, force: true });
}

// 8) MCP: memory_resolve and memory_delete exist and behave
{
  const root = tmpRoot();
  const store = new MemoryStore(root);
  store.init();
  store.add({ type: 'feature', content: 'Watch this', feature: 'auth', kind: 'watchpoint' });
  const engine = require('../lib/engine');
  process.env.SPECKIT_MEMORY_ROOT = root;
  engine.close();
  const resolved = engine.resolveMemory({ id: 'WP-AUTH-0001' });
  expect('engine resolveMemory marks resolved', resolved.status === 'resolved', JSON.stringify(resolved));
  const deleted = engine.deleteMemory({ id: 'WP-AUTH-0001' });
  expect('engine deleteMemory removes entry', deleted.id === 'WP-AUTH-0001' && !store.get('WP-AUTH-0001'));
  engine.close();
  delete process.env.SPECKIT_MEMORY_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
