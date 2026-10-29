'use strict';
/* Contract tests for the canonical MemoryStore-backed MCP engine. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const PKG = process.env.PKG_DIR || path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'speckit-contract-'));
const PROJECT = path.join(TMP, 'project');
process.env.SPECKIT_MEMORY_ROOT = PROJECT;
delete process.env.SPECKIT_MEMORY_PATH;
delete process.env.SPECKIT_MEMORY_DB;

let passed = 0, failed = 0;
function ok(name, condition, detail) {
  if (condition) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function section(name) { console.log('\n== ' + name + ' =='); }
// The engine is explicit-init since 0.1.3: initialize the project tree
// up front instead of relying on the old implicit auto-init.
new (require(path.join(PKG, 'lib', 'memory-store.js')).MemoryStore)(PROJECT).init();
const enginePath = path.join(PKG, 'lib', 'engine.js');
let engine = require(enginePath);

section('1. addMemory and metadata');
ok('project root from SPECKIT_MEMORY_ROOT', engine.projectRoot() === PROJECT);
const r1 = engine.addMemory({ type: 'decision', content: 'Use SQLite WAL mode for all local caches.' });
ok('decision id and total count', r1.id === 'DEC-0001' && r1.totalCount === 1, JSON.stringify(r1));
ok('feature null by default', r1.feature === null);
const r2 = engine.addMemory({
  type: 'watchpoint', feature: 'auth',
  content: 'Token revocation list is in-memory only; pod restart blanks it for ~60s.',
  tags: ['auth', 'tokens'], metadata: { source: 'incident-42' },
});
ok('watchpoint feature-prefixed id', r2.id === 'WP-AUTH-0001', r2.id);
ok('tags roundtrip', r2.tags.join(',') === 'auth,tokens');
ok('metadata roundtrip', r2.metadata && r2.metadata.source === 'incident-42');
const r3 = engine.addMemory({ type: 'open-question', feature: 'auth', content: 'Do we need WebAuthn step-up before the custody release?' });
ok('open-question id', r3.id === 'OQ-AUTH-0001', r3.id);
let threw = null;
try { engine.addMemory({ type: 'decision', content: '' }); } catch (err) { threw = err; }
ok('empty content is a domain error', threw && threw.domain === true);
threw = null;
try { engine.addMemory({ type: 'watchpoint', content: 'missing feature' }); } catch (err) { threw = err; }
ok('feature name is required', threw && threw.domain === true);

section('2. listMemories');
let all = engine.listMemories({});
ok('lists all three', all.length === 3, 'n=' + all.length);
ok('newest first', all[0].createdAt >= all[all.length - 1].createdAt);
ok('feature filter', engine.listMemories({ feature: 'auth' }).length === 2);
ok('type filter', engine.listMemories({ type: 'decision' }).length === 1);
ok('limit honored', engine.listMemories({ limit: 2 }).length === 2);
ok('tags persist in list', engine.listMemories({ feature: 'auth' }).some((m) => m.tags.length === 2));

section('3. searchMemories');
let hits = engine.searchMemories({ query: 'revocation' });
ok('single keyword match', hits.length === 1 && hits[0].feature === 'auth');
hits = engine.searchMemories({ query: 'webauthn sqlite' });
ok('OR keyword semantics', hits.length === 2, 'n=' + hits.length);
ok('snippet attached', hits.every((hit) => typeof hit.snippet === 'string'));
threw = null;
try { engine.searchMemories({ query: '' }); } catch (err) { threw = err; }
ok('empty query is a domain error', threw && threw.domain === true);

section('4. synthesize');
let brief = engine.synthesize({ feature: 'auth' });
ok('contract shape', brief.feature === 'auth' && typeof brief.words === 'number' && typeof brief.markdown === 'string');
ok('source content included', brief.markdown.includes('revocation') && brief.words > 10);
ok('MCP-compatible heading', brief.markdown.startsWith('# Feature synthesis'));
threw = null;
try { engine.synthesize({}); } catch (err) { threw = err; }
ok('missing feature is a domain error', threw && threw.domain === true);
threw = null;
try { engine.synthesize({ feature: 'nope' }); } catch (err) { threw = err; }
ok('unknown feature is a domain error', threw && /No memories found/.test(threw.message));

section('5. persistence and CLI sharing');
engine.close();
delete require.cache[require.resolve(enginePath)];
engine = require(enginePath);
ok('memories survive reopen', engine.listMemories({}).length === 3);
ok('metadata survives reopen', engine.listMemories({ feature: 'auth' }).some((m) => m.metadata && m.metadata.source === 'incident-42'));
let cli = spawnSync(process.execPath, [path.join(PKG, 'bin', 'cli.js'), 'list', '--feature', 'auth', '--json', '--root', PROJECT], { encoding: 'utf8' });
let rows = JSON.parse(cli.stdout);
ok('CLI sees MCP memories', rows.length === 2 && rows.some((row) => row.content.includes('Token revocation')), cli.stderr);
cli = spawnSync(process.execPath, [path.join(PKG, 'bin', 'cli.js'), 'add', 'feature', 'CLI shared watchpoint', '--feature', 'auth', '--root', PROJECT], { encoding: 'utf8' });
ok('CLI add succeeds', cli.status === 0, cli.stderr);
ok('MCP sees CLI memories', engine.listMemories({ feature: 'auth' }).some((m) => m.content === 'CLI shared watchpoint'));
ok('CLI feature keeps friendly MCP type', engine.listMemories({ feature: 'auth' }).find((m) => m.content === 'CLI shared watchpoint').type === 'watchpoint');

section('6. long-line synthesis');
for (let i = 0; i < 250; i++) {
  engine.addMemory({
    type: 'watchpoint', feature: 'stress',
    content: `- We MUST retain decision ${i} because the distributed cache configuration changes require coordinated validation across every deployment environment before production release and all service owners have confirmed this constraint after reviewing the complete incident history and customer compatibility requirements.`,
  });
}
brief = engine.synthesize({ feature: 'stress' });
ok('250 memories stay within 900 words', brief.words <= 900, 'words=' + brief.words);
ok('long-line content is retained', brief.words > 100 && brief.markdown.includes('distributed cache'), 'words=' + brief.words);

engine.close();
delete process.env.SPECKIT_MEMORY_ROOT;
fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n========================================');
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log('========================================');
process.exit(failed ? 1 : 0);
