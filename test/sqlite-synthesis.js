'use strict';
/* Integration test for sqlite-cache.js + synthesis-engine.js (run on VPS). */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert');
const { MemoryCache, countWords } = require(path.join(__dirname, '..', 'lib', 'sqlite-cache.js'));
const { SynthesisEngine } = require(path.join(__dirname, '..', 'lib', 'synthesis-engine.js'));

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function section(name) { console.log('\n== ' + name + ' =='); }

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'speckit-test-'));
const MEM = path.join(ROOT, 'memories');
const DB = path.join(ROOT, 'cache.db');

/* fixtures: feature `auth` + feature `payments` */
fs.mkdirSync(path.join(MEM, 'auth'), { recursive: true });
fs.mkdirSync(path.join(MEM, 'payments'), { recursive: true });
fs.writeFileSync(path.join(MEM, 'auth', 'decisions.md'), [
  '# auth decisions',
  '- We use JWT with short-lived access tokens (15 min) because refresh rotation was too complex for v1.',
  '- Postgres is the only source of truth for user sessions; Redis is a cache only and MUST be treated as disposable.',
  '- Password hashing: argon2id with memory cost 64 MB — decided 2026-09-12.',
  '- No third-party auth providers in v1.',
].join('\n'));
fs.writeFileSync(path.join(MEM, 'auth', 'watchpoints.md'), [
  '# auth watchpoints',
  '- WARNING: token revocation list is in-memory only; a pod restart wipes it for up to 60 seconds.',
  '- If login rate limit is disabled during load tests, MUST re-enable before deploy or accounts get brute-forced.',
  '- The `sessions` table lacks an index on (user_id, expires_at) — watch query plans on growth.',
].join('\n'));
fs.writeFileSync(path.join(MEM, 'auth', 'open-questions.md'), [
  '# open questions',
  '- Should we migrate refresh tokens to opaque server-side handles? Open since 2026-08.',
  '- Do we need WebAuthn for step-up auth before the custody release?',
].join('\n'));
fs.writeFileSync(path.join(MEM, 'auth', 'bug-preventions.md'), [
  '# bug preventions',
  '- Regression 2026-09-01: comparing token expiry as local time caused off-by-one-hour logout. Always parse timestamps as UTC.',
  '- Never trust the `aud` claim without checking the client_id — caused a cross-tenant leak in staging.',
].join('\n'));
fs.writeFileSync(path.join(MEM, 'auth', 'notes.md'), [
  '# notes',
  'General context about the auth service. Mostly prose that should rank lower than the distilled bullets above.',
].join('\n'));
fs.writeFileSync(path.join(MEM, 'payments', 'decisions.md'), [
  '# payments decisions',
  '- All amounts are stored as integer minor units; floats are forbidden anywhere in the payment path.',
].join('\n'));

console.log('LIB_DIR=' + process.env.LIB_DIR);
console.log('fixtures at ' + MEM);

/* ---- 1. schema + indexing ---- */
section('1. schema + syncDirectory');
const cache = new MemoryCache(DB);
ok('fts available', cache.fts === true, 'fts=' + cache.fts);
let sync = cache.syncDirectory(MEM);
ok('indexed 6 files', sync.indexed === 6, JSON.stringify(sync));
ok('no removals on first sync', sync.removed === 0);
const stats1 = cache.stats();
ok('6 memories', stats1.memories === 6, JSON.stringify(stats1.byFeature));
ok('2 features', stats1.features === 2);
ok('types derived', stats1.byType['decision'] === 2 && stats1.byType['watchpoint'] === 1 &&
   stats1.byType['open-question'] === 1 && stats1.byType['bug-prevention'] === 1 &&
   stats1.byType['note'] === 1, JSON.stringify(stats1.byType));

section('2. idempotent re-sync (no cache invalidation)');
const firstRow = cache.getByPath(path.join(MEM, 'auth', 'decisions.md'));
sync = cache.syncDirectory(MEM);
ok('second sync: 0 indexed', sync.indexed === 0 && sync.unchanged === 6, JSON.stringify(sync));
const secondRow = cache.getByPath(path.join(MEM, 'auth', 'decisions.md'));
ok('updated_at stable when content unchanged', firstRow.updated_at === secondRow.updated_at);

/* ---- 3. search ---- */
section('3. search');
let hits = cache.search({ keywords: 'argon2', feature: 'auth' });
ok('FTS finds argon2 in auth', hits.length === 1 && /argon2id/.test(hits[0].snippet), 'hits=' + hits.length);
hits = cache.search({ keywords: ['token', 'revocation'] });
ok('multi-keyword AND', hits.length >= 1 && hits.every((h) => /token/i.test(h.content)));
hits = cache.search({ keywords: 'minor units', feature: 'payments' });
ok('feature filter isolates payments', hits.length === 1 && hits[0].feature === 'payments');
hits = cache.search({ keywords: 'timestamps' });
ok('prefix match catches "timestamps"', hits.length >= 1);
hits = cache.search({ keywords: 'zzz-no-such-token' });
ok('no hit for absent keyword', hits.length === 0);
const since = new Date(Date.now() - 60 * 1000).toISOString();
hits = cache.search({ since, limit: 10 });
ok('since-filter includes fresh rows', hits.length === 6);
const until = new Date(Date.now() - 60 * 1000).toISOString();
hits = cache.search({ until, limit: 10 });
ok('until-filter in the past excludes all', hits.length === 0);
hits = cache.search({ type: 'decision', order: 'oldest', limit: 10 });
ok('type filter + oldest order', hits.length === 2 && hits.every((h) => h.type === 'decision'));

/* ---- 4. synthesis: small feature ---- */
section('4. synthesis (small feature)');
const engine = new SynthesisEngine(cache, { maxWords: 900 });
let brief = engine.synthesize('auth');
ok('wordCount <= 900', brief.wordCount <= 900, 'wordCount=' + brief.wordCount);
ok('cached flag false on first build', brief.cached === false);
ok('5 memories consumed', brief.memoryCount === 5, 'n=' + brief.memoryCount);
ok('Decisions section present', /^## Decisions$/m.test(brief.content));
ok('Watchpoints section present', /^## Watchpoints$/m.test(brief.content));
ok('Open Questions section present', /^## Open Questions$/m.test(brief.content));
ok('Bug Preventions section present', /^## Bug Preventions$/m.test(brief.content));
ok('argon2 decision surfaced', /argon2id/.test(brief.content));
ok('revocation watchpoint surfaced', /revocation/.test(brief.content));
ok('UTC bug prevention surfaced', /UTC/.test(brief.content));
ok('source annotations included', /\(decisions\.md\)/.test(brief.content));
const again = engine.synthesize('auth');
ok('second call served from synthesis_cache', again.cached === true && again.wordCount === brief.wordCount);
ok('cached read is identical', again.content === brief.content);

/* ---- 5. synthesis under heavy load (compression guarantee) ---- */
section('5. synthesis (250 large memories)');
const stressPath = path.join(ROOT, 'stress-mem');
fs.mkdirSync(stressPath, { recursive: true });
const filler = () => {
  const lines = [];
  for (let i = 0; i < 40; i++) {
    lines.push(`- Watchpoint filler item ${i}: the gizmo_${i} module MUST be revalidated when config_v${i % 7} changes because of drift risk ${i}.`);
  }
  return lines.join('\n');
};
for (let i = 0; i < 250; i++) {
  const type = i % 4 === 0 ? 'decision' : i % 4 === 1 ? 'watchpoint' : i % 4 === 2 ? 'open-questions' : 'bug-preventions';
  const p = path.join(stressPath, `m${i}.md`);
  fs.writeFileSync(p, `# stress memory ${i}\n${filler()}\n`);
  cache.indexFile(p, { feature: 'stress', type });
}
brief = engine.synthesize('stress', { refresh: true });
ok('stress wordCount <= 900', brief.wordCount <= 900, 'wordCount=' + brief.wordCount);
ok('stress consumed 250 memories', brief.memoryCount === 250);
ok('stress output non-trivial', brief.wordCount > 300, 'wordCount=' + brief.wordCount);
ok('stress truncated bullets reported', brief.truncatedBullets > 0, 'truncated=' + brief.truncatedBullets);

/* ---- 6. cache invalidation on file change ---- */
section('6. cache invalidation (file change)');
ok('cache exists before edit', cache.getCachedSynthesis('auth') !== null);
// rewrite decisions.md with a new, unambiguous decision
fs.writeFileSync(path.join(MEM, 'auth', 'decisions.md'), [
  '# auth decisions',
  '- DECIDED 2026-10-27: migrate all session validation to the edge worker — Redis lookup removed from the hot path.',
  '- Keep argon2id hashing.',
].join('\n'));
sync = cache.syncDirectory(MEM);
ok('edit detected (1 re-indexed)', sync.indexed === 1, JSON.stringify(sync));
ok('synthesis cache invalidated', cache.getCachedSynthesis('auth') === null);
ok('engine reports stale', cache.isSynthesisStale('auth') === true);
brief = engine.synthesize('auth');
ok('regenerated with new decision', /edge worker/.test(brief.content));
ok('regen wordCount <= 900', brief.wordCount <= 900);

/* ---- 7. deletion propagation ---- */
section('7. deletion propagation');
fs.unlinkSync(path.join(MEM, 'payments', 'decisions.md'));
sync = cache.syncDirectory(MEM);
ok('deleted file row removed', sync.removed === 1, JSON.stringify(sync));
ok('payments memories now 0', cache.count({ feature: 'payments' }) === 0);
ok('stress feature untouched', cache.count({ feature: 'stress' }) === 250);

/* ---- 8. LIKE fallback (fts disabled) ---- */
section('8. LIKE fallback (fts: false)');
const cache2 = new MemoryCache(':memory:', { fts: false });
cache2.indexMemory({ type: 'decision', path: '/x/decisions.md', feature: 'auth', content: 'We decided on argon2id hashing for passwords.' });
cache2.indexMemory({ type: 'watchpoint', path: '/x/watchpoints.md', feature: 'auth', content: 'Token revocation list is in-memory only.' });
ok('fts flag off', cache2.fts === false);
hits = cache2.search({ keywords: 'argon2id' });
ok('LIKE search works', hits.length === 1 && hits[0].type === 'decision');
hits = cache2.search({ keywords: ['argon2id', 'revocation'] });
ok('LIKE AND semantics', hits.length === 0);
hits = cache2.search({ keywords: 'revocation list' });
ok('LIKE multi-word', hits.length === 1);
const engine2 = new SynthesisEngine(cache2, { maxWords: 100 });
const small = engine2.synthesize('auth');
ok('tiny cap honored (<=100)', small.wordCount <= 100, 'wordCount=' + small.wordCount);

/* ---- 9. empty feature ---- */
section('9. empty feature');
const empty = engine.synthesize('no-such-feature');
ok('empty brief generated', /No memories indexed/.test(empty.content));
ok('empty brief cached', engine.synthesize('no-such-feature').cached === true);

/* ---- 10. persistence across reopen ---- */
section('10. persistence across reopen');
cache.close();
const reopened = new MemoryCache(DB);
ok('rows persisted', reopened.count() === 255, 'n=' + reopened.count());
ok('synthesis persisted + fresh', reopened.getCachedSynthesis('auth') !== null &&
   reopened.isSynthesisStale('auth') === false);
reopened.close();

section('11. more than 500 memories');
const bulk = new MemoryCache(':memory:');
for (let i = 0; i < 501; i++) {
  bulk.indexMemory({ type: 'decision', path: `/bulk/${i}.md`, feature: 'bulk', content: `- Decision ${i} MUST retain unique token_${i} because every memory matters.` });
}
ok('feature+type count is not capped', bulk.count({ feature: 'bulk', type: 'decision' }) === 501);
ok('getByFeature returns every row', bulk.getByFeature('bulk').length === 501);
const bulkEngine = new SynthesisEngine(bulk, { maxWords: 900 });
const bulkBrief = bulkEngine.synthesize('bulk');
ok('synthesis consumes every row', bulkBrief.memoryCount === 501, 'n=' + bulkBrief.memoryCount);
ok('bulk synthesis stays within 900 words', bulkBrief.wordCount <= 900, 'words=' + bulkBrief.wordCount);
bulk.close();

section('12. FTS empty tokens and feature override');
const punctuationCache = new MemoryCache(':memory:');
let punctuationHits;
try { punctuationHits = punctuationCache.search({ keywords: '"' }); }
catch (err) { punctuationHits = { error: err.message }; }
punctuationCache.close();
ok('punctuation-only FTS query does not crash', Array.isArray(punctuationHits) && punctuationHits.length === 0, JSON.stringify(punctuationHits));
const overrideDir = path.join(ROOT, 'override-input');
fs.mkdirSync(overrideDir, { recursive: true });
fs.writeFileSync(path.join(overrideDir, 'one.md'), '- A decision that MUST persist.');
const overrideCache = new MemoryCache(':memory:');
const overrideSync = overrideCache.syncDirectory(overrideDir, { infer: { feature: 'custom', type: 'decision' } });
ok('featuresTouched honors feature override', overrideSync.featuresTouched.join(',') === 'custom', JSON.stringify(overrideSync));
overrideCache.close();

section('13. FTS rebuild on reopen');
const ftsDb = path.join(ROOT, 'fts-reopen.db');
let ftsCache = new MemoryCache(ftsDb, { fts: false });
ftsCache.indexMemory({ type: 'decision', path: '/legacy/a.md', feature: 'legacy', content: 'uniquelegacytoken must remain searchable' });
ftsCache.close();
ftsCache = new MemoryCache(ftsDb, { fts: true });
ok('existing rows are indexed when FTS is enabled', ftsCache.search({ keywords: 'uniquelegacytoken' }).length === 1);
ftsCache.close();

section('14. long-line synthesis');
const longCache = new MemoryCache(':memory:');
for (let i = 0; i < 250; i++) {
  longCache.indexMemory({
    type: i % 2 ? 'decision' : 'watchpoint', path: `/long/${i}.md`, feature: 'long',
    content: `- We MUST retain decision ${i} because the distributed cache configuration changes require coordinated validation across every deployment environment before production release and all service owners have confirmed this constraint after reviewing the complete incident history and customer compatibility requirements.`,
  });
}
const longBrief = new SynthesisEngine(longCache, { maxWords: 900 }).synthesize('long');
ok('long-line synthesis stays within 900 words', longBrief.wordCount <= 900, 'words=' + longBrief.wordCount);
ok('long-line synthesis retains source content', longBrief.wordCount > 100 && longBrief.content.includes('distributed cache'), 'words=' + longBrief.wordCount);
longCache.close();

section('15. fallback bounds and corrupt-store protection');
const fallbackPath = path.join(ROOT, 'fallback-store.json');
process.env.SPECKIT_MEMORY_PATH = fallbackPath;
const fallback = require(path.join(__dirname, '..', 'lib', 'fallback-engine.js'));
for (let i = 0; i < 250; i++) {
  fallback.addMemory({ type: 'decision', feature: 'fallback-stress', content: `Memory ${i} ` + Array.from({ length: 45 }, (_, j) => `word${j}`).join(' ') });
}
const fallbackBrief = fallback.synthesize({ feature: 'fallback-stress' });
ok('fallback synthesis is bounded', fallbackBrief.words <= 900, 'words=' + fallbackBrief.words);
ok('fallback synthesis retains content', fallbackBrief.words > 100, 'words=' + fallbackBrief.words);
const corruptPath = path.join(ROOT, 'fallback-corrupt.json');
fs.writeFileSync(corruptPath, '{invalid json CORRUPT_ORIGINAL_SENTINEL');
process.env.SPECKIT_MEMORY_PATH = corruptPath;
delete require.cache[require.resolve(path.join(__dirname, '..', 'lib', 'fallback-engine.js'))];
const corruptFallback = require(path.join(__dirname, '..', 'lib', 'fallback-engine.js'));
let corruptError = null;
try { corruptFallback.addMemory({ type: 'decision', content: 'must not overwrite' }); }
catch (err) { corruptError = err; }
ok('corrupt store raises a warning', corruptError && corruptError.domain === true, String(corruptError));
ok('corrupt original is not overwritten', fs.readFileSync(corruptPath, 'utf8').includes('CORRUPT_ORIGINAL_SENTINEL'));
ok('corrupt backup is preserved', corruptError && corruptError.backupPath && fs.existsSync(corruptError.backupPath));
delete process.env.SPECKIT_MEMORY_PATH;

console.log('\n========================================');
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log('========================================');
fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
