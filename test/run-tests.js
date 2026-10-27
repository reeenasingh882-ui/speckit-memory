'use strict';

/*
 * speckit-memory core test suite (zero dependencies).
 * Covers: init, add (law/history/feature), immutability, list, index cache,
 * resolve, synthesis word budgeting, and the CLI end to end.
 * Run: node test/run-tests.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const PKG_DIR = path.resolve(__dirname, '..');
const CLI = path.join(PKG_DIR, 'bin', 'cli.js');
const { MemoryStore, ImmutableLawError, MemoryError } = require(path.join(PKG_DIR, 'lib', 'memory-store'));
const { synthesize, DEFAULT_TARGET_WORDS } = require(path.join(PKG_DIR, 'lib', 'synthesizer'));
const u = require(path.join(PKG_DIR, 'lib', 'fs-utils'));

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speckit-test-'));
  let store = null;
  try {
    store = fn(new MemoryStore(dir), dir) || null;
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.error(`FAIL - ${name}`);
    console.error(`      ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n      ') : err}`);
  } finally {
    try {
      if (store && store.close) store.close();
    } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`assertion failed: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Deterministic filler text of ~n words. */
function filler(n, topic) {
  const sentence =
    `${topic} behavior was reviewed end to end and every edge case in this ` +
    'area matters because regressions here were observed in staging and in production.';
  const words = [];
  while (words.length < n) words.push(...sentence.split(' '));
  return words.slice(0, n).join(' ');
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: options.cwd || PKG_DIR,
    input: options.input || '',
  });
}

// ---------------------------------------------------------------------------

test('init creates the three memory trees and READMEs', (store, dir) => {
  const res = store.init();
  assert(fs.existsSync(path.join(dir, '.specify', 'memory', 'laws')), 'laws dir');
  assert(fs.existsSync(path.join(dir, 'docs', 'memory', 'decisions')), 'decisions dir');
  assert(fs.existsSync(path.join(dir, 'docs', 'memory', 'worklogs')), 'worklogs dir');
  assert(fs.existsSync(path.join(dir, 'docs', 'memory', 'bug-preventions')), 'bug-preventions dir');
  assert(fs.existsSync(path.join(dir, 'specs')), 'specs dir');
  assert(fs.existsSync(path.join(dir, '.speckit-memory')), 'cache dir');
  assert(fs.existsSync(path.join(dir, '.specify', 'memory', 'README.md')), 'law README');
  assert(fs.existsSync(path.join(dir, 'docs', 'memory', 'README.md')), 'history README');
  assert(fs.existsSync(path.join(dir, 'specs', 'README.md')), 'specs README');
  const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert(gi.includes('.speckit-memory/'), '.gitignore mentions cache dir');
  assert(res.created.length > 0, 'init reports created dirs');
  // idempotent
  const again = store.init();
  assertEqual(again.created.length, 0, 'second init creates nothing');
});

test('frontmatter round trip (scalars, arrays, quoting)', () => {
  const fm = {
    id: 'LAW-0001',
    title: 'Never: store "plaintext" keys [prod]',
    tags: ['security', 'keys'],
    count: 3,
    immutable: true,
    empty: [],
    note: null,
  };
  const text = u.toMarkdownDocument(fm, '# body\n\ncontent');
  const round = u.parseFrontmatterText(text);
  assertEqual(round.frontmatter.id, 'LAW-0001', 'id round trips');
  assertEqual(round.frontmatter.title, fm.title, 'title round trips');
  assertEqual(round.frontmatter.count, 3, 'number round trips');
  assertEqual(round.frontmatter.immutable, true, 'boolean round trips');
  assertEqual(round.frontmatter.note, null, 'null round trips');
  assertEqual(round.frontmatter.tags.length, 2, 'array round trips');
  assertEqual(round.frontmatter.tags[0], 'security', 'array items round trip');
  assertEqual(round.frontmatter.empty.length, 0, 'empty array round trips');
  assert(round.body.trim().startsWith('# body'), 'body preserved');
});

test('add law creates immutable LAW-0001 with frontmatter', (store, dir) => {
  store.init();
  const e = store.add({ type: 'law', content: 'Never store plaintext private keys on disk.', title: 'Key storage rule', tags: ['Security'] });
  assertEqual(e.id, 'LAW-0001', 'first law id');
  assertEqual(e.type, 'law', 'type');
  assert(/^\.specify\/memory\/laws\/LAW-0001-/.test(e.filePath), `file path: ${e.filePath}`);
  const abs = path.join(dir, e.filePath);
  const doc = u.readMarkdownFile(abs);
  assertEqual(doc.frontmatter.immutable, true, 'immutable flag');
  assertEqual(doc.frontmatter.type, 'law', 'frontmatter type');
  assertEqual(doc.frontmatter.tags[0], 'security', 'tags normalized lowercase');
  assert(doc.body.includes('Never store plaintext'), 'content stored');
});

test('law ids increment and laws are immutable', (store) => {
  store.init();
  store.add({ type: 'law', content: 'First law.' });
  const second = store.add({ type: 'law', content: 'Second law.' });
  assertEqual(second.id, 'LAW-0002', 'law sequence increments');
  let updateThrew = false;
  try {
    store.update('LAW-0001', { content: 'rewrite' });
  } catch (err) {
    updateThrew = err instanceof ImmutableLawError;
  }
  assert(updateThrew, 'update(law) throws ImmutableLawError');
  let removeThrew = false;
  try {
    store.remove('LAW-0001');
  } catch (err) {
    removeThrew = err instanceof ImmutableLawError;
  }
  assert(removeThrew, 'remove(law) throws ImmutableLawError');
  assertEqual(store.list({ type: 'law' }).length, 2, 'both laws listed');
});

test('history categories, aliases and id prefixes', (store, dir) => {
  store.init();
  const dec = store.add({ type: 'history', content: 'Chose argon2id.', category: 'decision' });
  const bug = store.add({ type: 'history', content: 'Off-by-one fixed.', category: 'bug-prevention' });
  const log = store.add({ type: 'history', content: 'Session log.', category: 'worklog' });
  const dflt = store.add({ type: 'history', content: 'Default category entry.' });
  assertEqual(dec.id, 'DEC-0001', 'decisions prefix');
  assertEqual(bug.id, 'BUG-0001', 'bug-preventions prefix');
  assertEqual(log.id, 'LOG-0001', 'worklogs prefix');
  assertEqual(dflt.id, 'LOG-0002', 'default category is worklogs, sequence continues');
  assert(dec.filePath.startsWith('docs/memory/decisions/'), `decision path: ${dec.filePath}`);
  assert(bug.filePath.startsWith('docs/memory/bug-preventions/'), 'bug path');
  assert(log.filePath.startsWith('docs/memory/worklogs/'), 'worklog path');
  assert(fs.existsSync(path.join(dir, dec.filePath)), 'decision file on disk');
});

test('feature entries: watchpoints and open questions', (store) => {
  store.init();
  const wp1 = store.add({ type: 'feature', content: 'Token expiry drifts under load.', feature: 'User Auth', kind: 'watchpoint' });
  const wp2 = store.add({ type: 'feature', content: 'Rate limiter is per-pod, not global.', feature: 'user-auth' });
  const oq1 = store.add({ type: 'feature', content: 'Which redirect flow for mobile clients?', feature: 'user-auth', kind: 'open-question' });
  assertEqual(wp1.id, 'WP-USER-AUTH-0001', 'first watchpoint id');
  assertEqual(wp1.feature, 'user-auth', 'feature name slugified');
  assertEqual(wp2.id, 'WP-USER-AUTH-0002', 'watchpoint sequence');
  assertEqual(oq1.id, 'OQ-USER-AUTH-0001', 'open question id');
  assertEqual(wp1.filePath, 'specs/user-auth/watchpoints.md', 'watchpoint file');
  assertEqual(oq1.filePath, 'specs/user-auth/open-questions.md', 'open question file');
  const feats = store.list({ type: 'feature', feature: 'User Auth' });
  assertEqual(feats.length, 3, 'all three feature entries listed');
  assertEqual(feats.find((e) => e.id === 'WP-USER-AUTH-0001').wordCount > 0, true, 'word count computed');
});

test('list filters by tag and type', (store) => {
  store.init();
  store.add({ type: 'law', content: 'Gate signing keys behind review.', tags: ['api', 'security'] });
  store.add({ type: 'law', content: 'No plaintext secrets in logs.', tags: ['logging'] });
  store.add({ type: 'history', content: 'Shipped v2 API.', category: 'decision' });
  assertEqual(store.list({ type: 'law' }).length, 2, 'type filter');
  assertEqual(store.list({ tag: 'security' }).length, 1, 'tag filter');
  assertEqual(store.list({ tag: 'security' })[0].id, 'LAW-0001', 'tag filter hits right entry');
  assertEqual(store.list({ type: 'history' })[0].id, 'DEC-0001', 'history filter');
});

test('index cache tracks the filesystem (sqlite or json)', (store, dir) => {
  store.init();
  store.add({ type: 'law', content: 'Law one.' });
  const h = store.add({ type: 'history', content: 'Decision one.', category: 'decision' });
  store.add({ type: 'feature', content: 'Watch A.', feature: 'auth' });
  store.add({ type: 'feature', content: 'Question A?', feature: 'auth', kind: 'open-question' });
  store.scan();
  assert(['sqlite', 'json'].includes(store.cache.kind), `cache kind: ${store.cache.kind}`);
  assertEqual(store.cache.count(), 4, 'cache count matches scan');
  const byFeature = store.cache.query({ feature: 'auth' });
  assertEqual(byFeature.length, 2, 'cache query by feature');
  // deleting a file on disk shrinks the index on rescan
  fs.unlinkSync(path.join(dir, h.filePath));
  store.scan();
  assertEqual(store.cache.count(), 3, 'stale rows removed after rescan');
});

test('resolve marks feature entries and list can filter by status', (store) => {
  store.init();
  store.add({ type: 'feature', content: 'Which DB driver?', feature: 'auth', kind: 'open-question' });
  const resolved = store.resolve('OQ-AUTH-0001');
  assertEqual(resolved.status, 'resolved', 'status resolved after resolve()');
  assert(resolved.content.includes('[RESOLVED'), 'resolution marker appended');
  assertEqual(store.list({ status: 'resolved' }).length, 1, 'status filter finds it');
  assertEqual(store.list({ status: 'open' }).length, 0, 'no open questions left');
});

test('history update rewrites content and bumps updated', (store) => {
  store.init();
  const e = store.add({ type: 'history', content: 'Original text.', category: 'decision', title: 'First decision' });
  const before = e.updated;
  const updated = store.update(e.id, { content: 'Revised text with more detail.' });
  assertEqual(updated.content, 'Revised text with more detail.', 'content rewritten');
  assert(updated.updated >= before, 'updated timestamp bumped');
  assertEqual(updated.title, 'First decision', 'title preserved');
});

test('synthesize hits the 900-word budget with rich sources', (store, dir) => {
  store.init();
  for (let i = 1; i <= 5; i++) {
    store.add({ type: 'law', content: filler(120, `Law ${i}`), title: `Law ${i}` });
  }
  for (let i = 1; i <= 8; i++) {
    store.add({
      type: 'history',
      content: filler(150, `History ${i} auth token`),
      title: `History ${i}`,
      category: 'decision',
      feature: i <= 4 ? 'auth' : null,
    });
  }
  for (let i = 1; i <= 10; i++) {
    store.add({ type: 'feature', content: filler(110, `Watchpoint ${i}`), feature: 'auth', kind: 'watchpoint', title: `Watchpoint ${i}` });
  }
  for (let i = 1; i <= 4; i++) {
    store.add({ type: 'feature', content: filler(80, `Question ${i}`), feature: 'auth', kind: 'open-question', title: `Question ${i}` });
  }
  const result = synthesize(store, 'auth');
  assert(
    result.wordCount >= DEFAULT_TARGET_WORDS - 60 && result.wordCount <= DEFAULT_TARGET_WORDS + 60,
    `word count within tolerance: ${result.wordCount}`
  );
  assertEqual(result.feature, 'auth', 'feature slug');
  assertEqual(result.sources.watchpoints, 10, 'watchpoint count');
  assert(fs.existsSync(path.join(dir, 'specs', 'auth', 'memory.md')), 'memory.md written');
  const doc = u.readMarkdownFile(path.join(dir, 'specs', 'auth', 'memory.md'));
  assertEqual(doc.frontmatter.word_count, result.wordCount, 'frontmatter word count matches');
  assert(doc.body.includes('## Active Watchpoints'), 'watchpoints section present');
  assert(doc.body.includes('## Governance Law Digest'), 'law digest section present');
  assert(doc.body.includes('## Synthesis Notes'), 'synthesis notes present');
  // regenerate stays within budget
  const again = synthesize(store, 'auth');
  assert(
    again.wordCount >= DEFAULT_TARGET_WORDS - 60 && again.wordCount <= DEFAULT_TARGET_WORDS + 60,
    `regenerated word count within tolerance: ${again.wordCount}`
  );
});

test('synthesize with sparse sources stays honest (no padding)', (store, dir) => {
  store.init();
  store.add({ type: 'law', content: 'Only one law exists.' });
  const result = synthesize(store, 'brand-new-feature');
  assert(result.wordCount > 0, 'document produced');
  assert(result.wordCount < 400, `sparse doc is short (${result.wordCount} words), not padded`);
  assert(fs.existsSync(path.join(dir, 'specs', 'brand-new-feature', 'memory.md')), 'written');
});

test('CLI end to end: init, add, list, show, synthesize', (store, dir) => {
  const r0 = runCli(['init', '--root', dir]);
  assertEqual(r0.status, 0, `init exit code (stderr: ${r0.stderr})`);
  assert(r0.stdout.includes('.specify/memory'), 'init output mentions trees');

  const r1 = runCli(['add', 'law', 'Always gate signing keys behind review', '--title', 'Review gate', '--tag', 'security', '--root', dir]);
  assertEqual(r1.status, 0, `add law exit (stderr: ${r1.stderr})`);
  assert(r1.stdout.includes('LAW-0001'), 'add law reports LAW-0001');

  const r2 = runCli(['add', 'feature', 'Watch token expiry drift', '--feature', 'auth', '--kind', 'watchpoint', '--root', dir]);
  assertEqual(r2.status, 0, 'add feature exit');
  assert(r2.stdout.includes('WP-AUTH-0001'), 'add feature reports WP-AUTH-0001');

  const r3 = runCli(['add', 'history', 'Chose argon2 for password hashing', '--category', 'decision', '--feature', 'auth', '--root', dir]);
  assertEqual(r3.status, 0, 'add history exit');
  assert(r3.stdout.includes('DEC-0001'), 'add history reports DEC-0001');

  const r4 = runCli(['list', '--json', '--root', dir]);
  assertEqual(r4.status, 0, 'list --json exit');
  const parsed = JSON.parse(r4.stdout);
  assertEqual(parsed.length, 3, 'list --json returns 3 entries');
  const ids = parsed.map((e) => e.id).sort();
  assertEqual(ids.join(','), 'DEC-0001,LAW-0001,WP-AUTH-0001', 'all ids present');

  const r5 = runCli(['list', '--type', 'law', '--root', dir]);
  assertEqual(r5.status, 0, 'list table exit');
  assert(r5.stdout.includes('LAW-0001'), 'table shows LAW-0001');
  assert(!r5.stdout.includes('DEC-0001'), 'table filtered');

  const r6 = runCli(['show', 'LAW-0001', '--root', dir]);
  assertEqual(r6.status, 0, 'show exit');
  assert(r6.stdout.includes('Always gate signing keys'), 'show prints stored law');

  const r7 = runCli(['synthesize', 'auth', '--root', dir]);
  assertEqual(r7.status, 0, `synthesize exit (stderr: ${r7.stderr})`);
  assert(r7.stdout.includes('specs/auth/memory.md'), 'synthesize reports output path');
  assert(fs.existsSync(path.join(dir, 'specs', 'auth', 'memory.md')), 'synthesis file exists');

  const r8 = runCli(['synthesize', 'auth', '--stdout', '--root', dir]);
  assertEqual(r8.status, 0, 'synthesize --stdout exit');
  assert(r8.stdout.startsWith('---'), 'stdout mode emits frontmatter document');
});

test('CLI usage and domain errors', (store, dir) => {
  const bad = runCli(['frobnicate']);
  assertEqual(bad.status, 2, 'unknown command exits 2');
  const badType = runCli(['add', 'bogus', 'x']);
  assertEqual(badType.status, 2, 'unknown add type exits 2');
  const missing = runCli(['add', 'law']);
  assertEqual(missing.status, 2, 'missing content exits 2');
  assertEqual(runCli(['init', '--root', dir]).status, 0, 'init for domain checks');
  const badCat = runCli(['add', 'history', 'text', '--category', 'nonsense', '--root', dir]);
  assertEqual(badCat.status, 1, 'bad category is a domain error (exit 1)');
  assert(badCat.stderr.includes('Unknown history category'), 'bad category message');
  const notInit = runCli(['list', '--root', '/tmp']);
  assertEqual(notInit.status, 1, 'list on uninitialized root exits 1');
});

function writeLegacyDuplicate(root) {
  for (const feature of ['auth', 'payments']) {
    const dir = path.join(root, 'specs', feature);
    fs.mkdirSync(dir, { recursive: true });
    const body = feature === 'auth' ? 'AUTH-DUPLICATE-SENTINEL' : 'PAYMENTS-DUPLICATE-SENTINEL';
    fs.writeFileSync(path.join(dir, 'watchpoints.md'), `---\nfeature: ${feature}\nkind: watchpoints\nupdated: 2026-10-27T00:00:00.000Z\n---\n\n# ${feature} - watchpoints\n\n## WP-0001: Legacy duplicate (2026-10-27)\n\n${body}\n`);
  }
}

test('composite key preserves legacy duplicate ids across features', (store, dir) => {
  store.init();
  writeLegacyDuplicate(dir);
  const entries = store.scan();
  assertEqual(entries.length, 2, 'both duplicate source entries scanned');
  assertEqual(store.cache.count(), 2, 'both duplicate entries indexed');
  assertEqual(store.cache.query({ feature: 'auth' }).length, 1, 'auth row retained');
  assertEqual(store.cache.query({ feature: 'payments' }).length, 1, 'payments row retained');
});

test('constructor migrates id-only database to composite key', (store, dir) => {
  store.init();
  writeLegacyDuplicate(dir);
  const dbPath = path.join(dir, '.speckit-memory', 'index.db');
  const raw = new DatabaseSync(dbPath);
  raw.exec(`CREATE TABLE memories (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, category TEXT, feature TEXT, title TEXT,
    file_path TEXT NOT NULL, created TEXT, updated TEXT, tags TEXT NOT NULL DEFAULT '[]',
    content_hash TEXT, word_count INTEGER NOT NULL DEFAULT 0, indexed_at TEXT
  )`);
  raw.prepare(`INSERT INTO memories
    (id, type, category, feature, title, file_path, created, updated, tags, content_hash, word_count, indexed_at)
    VALUES ('WP-0001', 'feature', 'watchpoint', 'auth', 'Legacy existing', 'specs/auth/watchpoints.md',
      '2026-10-27', '2026-10-27', '[]', 'legacy-hash', 1, '2026-10-27T00:00:00.000Z')`).run();
  raw.close();
  assertEqual(store.cache.count(), 1, 'existing row survives migration');
  const pkColumns = store.cache.db.prepare('PRAGMA table_info(memories)').all()
    .filter((row) => Number(row.pk) > 0).sort((a, b) => a.pk - b.pk).map((row) => row.name);
  assertEqual(pkColumns.join(','), 'id,feature', 'composite primary key after migration');
  assertEqual(store.cache.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version').value, '2', 'schema version 2');
  const entries = store.scan();
  assertEqual(entries.length, 2, 'both source entries scanned after migration');
  assertEqual(store.cache.count(), 2, 'both rows present after rescan');
  assertEqual(store.cache.query({ feature: 'auth' }).length, 1, 'auth row retained after rescan');
  assertEqual(store.cache.query({ feature: 'payments' }).length, 1, 'payments row retained after rescan');
});

test('feature ids use feature prefixes and a global sequence', (store) => {
  store.init();
  const auth = store.add({ type: 'feature', feature: 'auth', content: 'Auth watchpoint.' });
  const payments = store.add({ type: 'feature', feature: 'payments', content: 'Payments watchpoint.' });
  assertEqual(auth.id, 'WP-AUTH-0001', 'auth prefixed id');
  assertEqual(payments.id, 'WP-PAYMENTS-0002', 'payments id uses global sequence');
  assertEqual(store.scan().length, 2, 'both features coexist in the index');
});

test('feature update and resolve affect only the requested id', (store) => {
  store.init();
  const first = store.add({ type: 'feature', feature: 'auth', content: 'First original.' });
  const second = store.add({ type: 'feature', feature: 'auth', content: 'Second original.' });
  store.update(first.id, { content: 'ONLY_FIRST_CHANGED' });
  let entries = store.list({ type: 'feature', feature: 'auth' });
  assert(entries.find((e) => e.id === first.id).content.includes('ONLY_FIRST_CHANGED'), 'target updated');
  assert(entries.find((e) => e.id === second.id).content.includes('Second original'), 'sibling unchanged');
  store.resolve(first.id);
  entries = store.list({ type: 'feature', feature: 'auth' });
  assertEqual(entries.find((e) => e.id === first.id).status, 'resolved', 'target resolved');
  assertEqual(entries.find((e) => e.id === second.id).status, 'open', 'sibling remains open');
});

test('CLI tag filter, resolve, first init output and missing file errors', (store, dir) => {
  const initialized = runCli(['init', '--root', dir]);
  assertEqual(initialized.status, 0, 'init succeeds');
  assert(!initialized.stdout.includes('Created: nothing'), 'first init reports created trees');
  runCli(['add', 'law', 'Security law', '--tag', 'security', '--root', dir]);
  runCli(['add', 'law', 'Other law', '--root', dir]);
  const tagged = runCli(['list', '--tag', 'security', '--json', '--root', dir]);
  const taggedRows = JSON.parse(tagged.stdout);
  assertEqual(taggedRows.length, 1, 'CLI tag filter returns one law');
  assertEqual(taggedRows[0].tags[0], 'security', 'correct tagged law');
  runCli(['add', 'feature', 'Question?', '--feature', 'auth', '--kind', 'open-question', '--root', dir]);
  const resolved = runCli(['resolve', 'OQ-AUTH-0001', '--root', dir]);
  assertEqual(resolved.status, 0, `resolve succeeds (${resolved.stderr})`);
  const resolvedRows = JSON.parse(runCli(['list', '--status', 'resolved', '--json', '--root', dir]).stdout);
  assertEqual(resolvedRows.length, 1, 'resolved entry visible through CLI');
  const missing = runCli(['add', 'history', '--file', path.join(dir, 'does-not-exist.txt'), '--root', dir]);
  assertEqual(missing.status, 1, 'missing --file exits with domain error');
  assert(missing.stderr.includes('Content file not found'), 'missing --file has concise error');
  assert(!missing.stderr.includes('at Object.'), 'missing --file does not dump a stack');
});

test('engine adapter satisfies the MCP contract (file-structure engine)', () => {
  const enginePath = path.join(PKG_DIR, 'lib', 'engine.js');
  if (!fs.existsSync(enginePath)) {
    console.log('  (no lib/engine.js in this tree — adapter test skipped)');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speckit-engine-'));
  try {
    process.env.SPECKIT_MEMORY_ROOT = dir;
    delete require.cache[require.resolve(enginePath)];
    const engine = require(enginePath);
    if (!Array.isArray(engine.MEMORY_TYPES) || !engine.MEMORY_TYPES.includes('law')) {
      // The canonical lib/engine.js in this tree is the sqlite-backed engine
      // (decision/watchpoint/...); its contract is covered by
      // test/engine-contract.js. Only assert the universal shape here.
      assertEqual(typeof engine.addMemory, 'function', 'addMemory exported');
      assertEqual(typeof engine.listMemories, 'function', 'listMemories exported');
      assertEqual(typeof engine.searchMemories, 'function', 'searchMemories exported');
      assertEqual(typeof engine.synthesize, 'function', 'synthesize exported');
      console.log('  (file-structure engine not canonical here — adapter specifics skipped)');
      return;
    }
    for (const required of ['law', 'history', 'feature', 'decision', 'watchpoint', 'open-question']) {
      assert(engine.MEMORY_TYPES.includes(required), `MEMORY_TYPES includes ${required}`);
    }
    const rec = engine.addMemory({ type: 'law', content: 'Engine law.', tags: ['x'] });
    assert(rec.id && rec.id.startsWith('LAW-'), `engine add id: ${rec.id}`);
    assertEqual(typeof rec.totalCount, 'number', 'totalCount present');
    engine.addMemory({ type: 'decision', content: 'Engine decision.', feature: 'auth' });
    engine.addMemory({ type: 'watchpoint', content: 'Engine watchpoint.', feature: 'auth' });
    engine.addMemory({ type: 'open-question', content: 'Engine question?', feature: 'auth' });
    const listed = engine.listMemories({ feature: 'auth' });
    assertEqual(listed.length, 3, 'listMemories by feature');
    assertEqual(listed[0].createdAt >= listed[listed.length - 1].createdAt, true, 'newest first');
    const hits = engine.searchMemories({ query: 'engine decision' });
    assert(hits.length >= 1 && hits[0].id.startsWith('DEC-'), 'searchMemories ranks the decision');
    const syn = engine.synthesize({ feature: 'auth' });
    assert(typeof syn.markdown === 'string' && syn.markdown.length > 0, 'synthesize returns markdown');
    assertEqual(typeof syn.words, 'number', 'synthesize returns words');
    let threw = false;
    try {
      engine.addMemory({ type: 'feature', content: 'no feature name' });
    } catch (err) {
      threw = err.domain === true;
    }
    assert(threw, 'feature without name raises a domain error');
  } finally {
    delete process.env.SPECKIT_MEMORY_ROOT;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) {
    console.error(`\n--- ${f.name} ---\n${f.err && f.err.stack ? f.err.stack : f.err}`);
  }
  process.exit(1);
}
process.exit(0);

