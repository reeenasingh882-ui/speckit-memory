'use strict';

/**
 * speckit-memory command line interface.
 *
 * bin/cli.js loads this module and calls main(argv) for every command except
 * `mcp-start` (routed directly to the MCP server there — this module also
 * supports it for direct `node lib/cli.js mcp-start` use).
 *
 * Commands:
 *   speckit-memory init
 *   speckit-memory add <type> <content...> [options]
 *   speckit-memory list [--type] [--category] [--feature] [--tag] [--status]
 *   speckit-memory show <id>
 *   speckit-memory resolve <id>
 *   speckit-memory synthesize <feature> [--words N] [--stdout]
 *   speckit-memory mcp-start
 *
 * Exit codes: 0 success, 1 runtime error, 2 usage error.
 */

const fs = require('fs');
const path = require('path');
const u = require('./fs-utils');
const { MemoryStore, MemoryError, ImmutableLawError, TYPES } = require('./memory-store');
const { synthesize, DEFAULT_TARGET_WORDS } = require('./synthesizer');

const USAGE = [
  'speckit-memory — persistent memory for spec-driven development',
  '',
  'Usage:',
  '  speckit-memory init [--root DIR]                       Create the memory trees',
  '  speckit-memory add <type> <content...> [options]       Add a memory entry',
  '  speckit-memory list [filters]                          List memory entries',
  '  speckit-memory show <id>                               Print one stored entry file',
  '  speckit-memory resolve <id>                            Mark a feature entry resolved',
  '  speckit-memory synthesize <feature> [options]          Build ~900-word feature memory',
  '  speckit-memory mcp-start                               Start the MCP stdio server',
  '',
  'Types: law (immutable) | history | feature',
  '',
  'add options:',
  '  --title <t>        Entry title (derived from content when omitted)',
  '  --category <c>     history: decisions | worklogs | bug-preventions (default worklogs)',
  '  --feature <name>   feature: feature name (required); history: optional reference',
  '  --kind <k>         feature: watchpoint | open-question (default watchpoint)',
  '  --tag <t>          Retrieval tag (repeatable)',
  '  --file <path>      Read content from a file instead of the argument',
  '  --json             Print the created entry as JSON',
  '  --root <dir>       Project root (default: auto-discover)',
  '',
  'list filters:',
  '  --type --category --feature --tag --status [--since YYYY-MM-DD] [--until YYYY-MM-DD]',
  '  [--limit N] [--json] [--root DIR]',
  '',
  'synthesize options:',
  '  --words <n>        Word target (default 900)',
  '  --stdout           Print the document instead of writing it',
  '  --root <dir>       Project root',
  '',
  'Content can also be piped:  echo "note" | speckit-memory add history -',
].join('\n');

const VALUE_FLAGS = new Set([
  'root',
  'title',
  'category',
  'feature',
  'kind',
  'file',
  'words',
  'status',
  'type',
  'limit',
, 'since', 'until']);
const BOOL_FLAGS = new Set(['json', 'stdout', 'help', 'version']);

function usageError(message) {
  process.stderr.write(`error: ${message}\n\n${USAGE}\n`);
  return 2;
}

function parseArgv(argv) {
  const positional = [];
  const opts = { tags: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      let key = a.slice(2);
      let value = true;
      const eq = key.indexOf('=');
      if (eq !== -1) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      key = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (key === 'tag') {
        if (value === true) {
          if (i + 1 >= argv.length) return { err: `--tag requires a value` };
          value = argv[++i];
        }
        opts.tags.push(String(value));
        continue;
      }
      if (VALUE_FLAGS.has(key)) {
        if (value === true) {
          if (i + 1 >= argv.length) return { err: `--${key} requires a value` };
          value = argv[++i];
        }
        opts[key] = value;
      } else if (BOOL_FLAGS.has(key)) {
        opts[key] = Boolean(value);
      } else {
        return { err: `unknown option --${key}` };
      }
      continue;
    }
    positional.push(a);
  }
  return { positional, opts };
}

function resolveStore(opts, { autoInit = false } = {}) {
  let root = opts.root ? path.resolve(opts.root) : u.findProjectRoot();
  if (!root) root = process.cwd();
  const store = new MemoryStore(root);
  if (autoInit) store.init();
  else if (!store.isInitialized()) {
    throw new MemoryError(
      `Memory trees are not initialized under ${root}. Run "speckit-memory init" first.`
    );
  }
  return store;
}

function truncate(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? `${str.slice(0, n - 3)}...` : str;
}

function printTable(entries) {
  if (entries.length === 0) {
    process.stdout.write('No memories found. Add one: speckit-memory add law|history|feature ...\n');
    return;
  }
  const rows = entries.map((e) => [
    e.id,
    e.type,
    e.category || '-',
    e.feature || '-',
    String(e.created || e.updated || '-').slice(0, 10),
    String(e.wordCount || 0),
    e.title,
  ]);
  const widths = [0, 1, 2, 3, 4, 5].map((i) =>
    Math.max(...rows.map((r) => r[i].length))
  );
  const header = ['ID', 'TYPE', 'CATEGORY', 'FEATURE', 'DATE', 'WORDS', 'TITLE'];
  const line = (r) =>
    r
      .slice(0, 6)
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ') +
    '  ' +
    truncate(r[6], Math.max(20, 100 - widths.reduce((a, b) => a + b + 2, 0)));
  process.stdout.write(`${line(header)}\n${'-'.repeat(Math.max(40, line(header).length))}\n`);
  for (const r of rows) process.stdout.write(`${line(r)}\n`);
}

function readStdin() {
  // Reading stdin on a TTY would block until EOF (Ctrl-D); refuse politely.
  try {
    if (process.stdin.isTTY) {
      process.stderr.write(
        'error: no piped input on stdin (this is a terminal). Pipe content instead, e.g. echo "note" | speckit-memory add history -\n'
      );
      process.exit(2);
    }
    return fs.readFileSync(0, 'utf8');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') throw err;
    return '';
  }
}

function cmdInit(opts) {
  const root = opts.root ? path.resolve(opts.root) : (u.findProjectRoot() || process.cwd());
  const store = new MemoryStore(root);
  const res = store.init();
  const created = res.created.length ? res.created.join(', ') : 'nothing (already initialized)';
  process.stdout.write(`Initialized speckit-memory under ${store.rootDir}\n`);
  process.stdout.write(`Created: ${created}\n`);
  process.stdout.write(
    'Trees: .specify/memory/ (law)  docs/memory/ (history)  specs/ (feature)\n'
  );
  return 0;
}

function cmdAdd(positional, opts) {
  const type = (positional[0] || '').toLowerCase();
  if (!TYPES.includes(type)) {
    return usageError(
      `add: unknown type "${positional[0] || ''}" (expected law | history | feature)`
    );
  }
  const rest = positional.slice(1);
  let content;
  if (opts.file) {
    content = null; // read via contentFile in store.add
  } else if (rest.length === 1 && rest[0] === '-') {
    content = readStdin();
  } else {
    content = rest.join(' ');
  }
  if (!opts.file && !(content && content.trim())) {
    return usageError('add: content is required (argument, "-", or --file)');
  }
  const store = resolveStore(opts);
  const entry = store.add({
    type,
    content,
    contentFile: opts.file,
    title: opts.title,
    category: opts.category,
    feature: opts.feature,
    kind: opts.kind,
    tags: opts.tags,
  });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Added ${entry.id} (${entry.type}${entry.category ? `/${entry.category}` : ''}` +
        `${entry.feature ? `, feature: ${entry.feature}` : ''}): ` +
        `"${entry.title}" -> ${entry.filePath}\n`
    );
  }
  return 0;
}

function cmdList(opts) {
  const limit = opts.limit ? parseInt(opts.limit, 10) : null;
  if (opts.limit && (!Number.isInteger(limit) || limit < 1)) {
    return usageError('list: --limit must be a positive integer');
  }
  const store = resolveStore(opts);
  let entries = store.list({
    type: opts.type ? String(opts.type).toLowerCase() : null,
    category: opts.category,
    feature: opts.feature,
    status: opts.status,
  });
  const requiredTags = opts.tags.map((tag) => String(tag).toLowerCase());
  if (requiredTags.length) {
    entries = entries.filter((entry) => requiredTags.every((tag) => (entry.tags || []).includes(tag)));
  }
  if (opts.since) {
    // Compare on the date part: --since/--until are YYYY-MM-DD while entries
    // carry full ISO timestamps ("2026-10-29T..." must fall inside --until).
    const since = String(opts.since).slice(0, 10);
    entries = entries.filter((e) => String(e.updated || e.created || '').slice(0, 10) >= since);
  }
  if (opts.until) {
    const until = String(opts.until).slice(0, 10);
    entries = entries.filter((e) => String(e.updated || e.created || '').slice(0, 10) <= until);
  }
  if (limit) entries = entries.slice(0, limit);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
  } else {
    printTable(entries);
    process.stdout.write(`Total: ${entries.length}\n`);
  }
  return 0;
}

function cmdShow(positional, opts) {
  const id = positional[0];
  if (!id) return usageError('show: an entry id is required (e.g. LAW-0001)');
  const store = resolveStore(opts);
  const entry = store.get(id.toUpperCase() === id ? id : id.toUpperCase());
  if (!entry) {
    process.stderr.write(`error: no entry with id ${id}\n`);
    return 1;
  }
  const abs = path.join(store.rootDir, entry.filePath);
  process.stdout.write(u.readTextFile(abs));
  return 0;
}

function cmdResolve(positional, opts) {
  const id = positional[0];
  if (!id) return usageError('resolve: an entry id is required (e.g. OQ-AUTH-0001)');
  const store = resolveStore(opts);
  const entry = store.resolve(id.toUpperCase());
  if (opts.json) process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
  else process.stdout.write(`Resolved ${entry.id} (${entry.status}).\n`);
  return 0;
}

function cmdSynthesize(positional, opts) {
  const feature = positional[0];
  if (!feature) return usageError('synthesize: a feature name is required');
  const words = opts.words ? parseInt(opts.words, 10) : DEFAULT_TARGET_WORDS;
  if (!Number.isInteger(words) || words < 100) {
    return usageError('synthesize: --words must be an integer >= 100');
  }
  const store = resolveStore(opts);
  const result = synthesize(store, feature, {
    targetWords: words,
    write: !opts.stdout,
  });
  if (opts.stdout) {
    const fm = {
      feature: result.feature,
      kind: 'synthesis',
      generated: u.nowIso(),
      word_count: result.wordCount,
      target_words: result.targetWords,
    };
    process.stdout.write(u.toMarkdownDocument(fm, result.body));
  } else {
    process.stdout.write(
      `Synthesized feature memory for "${result.feature}": ${result.wordCount} words ` +
        `(target ${result.targetWords} +/- ${result.tolerance}) -> ${result.filePath}\n`
    );
  }
  return 0;
}

function cmdSearch(positional, opts) {
  const keywords = positional.map((k) => String(k).toLowerCase()).filter(Boolean);
  if (!keywords.length) return usageError('search: at least one keyword is required');
  const limit = opts.limit ? parseInt(opts.limit, 10) : 20;
  if (!Number.isInteger(limit) || limit < 1) {
    return usageError('search: --limit must be a positive integer');
  }
  const store = resolveStore(opts);
  const entries = store.scan();
  const scored = [];
  for (const e of entries) {
    const hay = `${e.id} ${e.title || ''} ${e.content || ''} ${(e.tags || []).join(' ')}`.toLowerCase();
    let score = 0;
    let matchedAll = true;
    for (const kw of keywords) {
      if (!hay.includes(kw)) { matchedAll = false; break; }
      score += 1;
      if (String(e.id).toLowerCase() === kw) score += 3;
      if (String(e.title || '').toLowerCase().includes(kw)) score += 2;
    }
    if (matchedAll) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.e.id).localeCompare(String(b.e.id)));
  const hits = scored.slice(0, limit).map((s) => s.e);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(hits, null, 2)}\n`);
  } else {
    printTable(hits);
    process.stdout.write(`Matches: ${hits.length}\n`);
  }
  return 0;
}

function cmdRemove(positional, opts) {
  const id = positional[0];
  if (!id) return usageError('remove: an entry id is required (e.g. DEC-0001)');
  const store = resolveStore(opts);
  const before = store.get(id.toUpperCase());
  const result = store.remove(id.toUpperCase());
  const removedId = (before && before.id) || (result && result.removed) || id.toUpperCase();
  if (opts.json) process.stdout.write(`${JSON.stringify(before || result, null, 2)}\n`);
  else process.stdout.write(`Removed ${removedId}.\n`);
  return 0;
}

function cmdExport(positional, opts) {
  const store = resolveStore(opts);
  const entries = store.scan();
  const bundle = {
    format: 'speckit-memory-export',
    version: 1,
    exported: u.nowIso(),
    count: entries.length,
    entries,
  };
  const json = `${JSON.stringify(bundle, null, 2)}\n`;
  const out = positional[0];
  if (out) {
    fs.writeFileSync(path.resolve(out), json, 'utf8');
    process.stdout.write(`Exported ${entries.length} entries to ${out}\n`);
  } else {
    process.stdout.write(json);
  }
  return 0;
}

function cmdImport(positional, opts) {
  const srcFile = positional[0];
  if (!srcFile) return usageError('import: a JSON export file is required');
  const store = resolveStore(opts);
  let bundle;
  try {
    bundle = JSON.parse(fs.readFileSync(path.resolve(srcFile), 'utf8'));
  } catch (err) {
    process.stderr.write(`error: cannot read import file: ${err.message}\n`);
    return 1;
  }
  const entries = Array.isArray(bundle) ? bundle : (bundle && bundle.entries);
  if (!Array.isArray(entries)) {
    process.stderr.write('error: import file has no "entries" array\n');
    return 1;
  }
  let imported = 0;
  let skipped = 0;
  for (const e of entries) {
    try {
      if (!e || !e.id || !e.content) { skipped += 1; continue; }
      if (store.get(e.id)) { skipped += 1; continue; }
      store.add({
        type: e.type === 'law' ? 'law' : e.type === 'feature' ? 'feature' : 'history',
        title: e.title,
        content: e.content,
        category: e.category,
        feature: e.feature,
        kind: e.category === 'open-questions' ? 'open-question' : 'watchpoint',
        tags: e.tags,
        id: e.id,
      });
      imported += 1;
    } catch (_) {
      skipped += 1;
    }
  }
  process.stdout.write(`Imported ${imported} entries (${skipped} skipped).\n`);
  return 0;
}

function cmdStats(opts) {
  const store = resolveStore(opts);
  const entries = store.scan();
  const byType = {};
  const byCategory = {};
  const byStatus = { open: 0, resolved: 0, other: 0 };
  let words = 0;
  for (const e of entries) {
    byType[e.type] = (byType[e.type] || 0) + 1;
    const cat = e.category || '(none)';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    if (e.status === 'open') byStatus.open += 1;
    else if (e.status === 'resolved') byStatus.resolved += 1;
    else byStatus.other += 1;
    words += Number(e.wordCount || 0);
  }
  const out = { total: entries.length, byType, byCategory, byStatus, totalWords: words };
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    process.stdout.write(`Entries: ${out.total}\n`);
    for (const [k, v] of Object.entries(byType)) process.stdout.write(`  ${k}: ${v}\n`);
    process.stdout.write(`Status: open=${byStatus.open} resolved=${byStatus.resolved}\n`);
    process.stdout.write(`Words: ${words}\n`);
  }
  return 0;
}

function cmdDoctor(opts) {
  const store = resolveStore(opts);
  const problems = [];
  if (!store.isInitialized()) {
    problems.push('memory trees are missing - run `speckit-memory init`');
  }
  let entries = [];
  try {
    entries = store.scan();
  } catch (err) {
    problems.push(`scan failed: ${err.message}`);
  }
  const cacheDir = path.join(store.rootDir, '.speckit-memory');
  if (u.fileExists(cacheDir)) {
    for (const f of fs.readdirSync(cacheDir)) {
      if (f.includes('corrupt')) {
        problems.push(`corrupt cache remnant: .speckit-memory/${f} (safe to delete)`);
      }
    }
  }
  const seen = new Map();
  for (const e of entries) {
    if (seen.has(e.id)) problems.push(`duplicate id ${e.id} (${seen.get(e.id)} vs ${e.filePath})`);
    else seen.set(e.id, e.filePath);
  }
  if (problems.length) {
    for (const pr of problems) process.stdout.write(`! ${pr}\n`);
    process.stdout.write(`Doctor found ${problems.length} issue(s).\n`);
  } else {
    process.stdout.write(`All healthy: ${entries.length} entries indexed.\n`);
  }
  return problems.length ? 1 : 0;
}

function cmdMcpStart() {
  const mod = require('../mcp-server');
  const start = mod.startMcpServer || mod.default || mod;
  const maybePromise = start();
  if (maybePromise && typeof maybePromise.catch === 'function') {
    maybePromise.catch((err) => {
      process.stderr.write(`mcp server error: ${err && err.stack ? err.stack : err}\n`);
      process.exitCode = 1;
    });
  }
  return null; // server owns the process lifetime
}

/**
 * CLI entry point. Returns an exit code (or null when the process is kept
 * alive by a long-running command such as mcp-start).
 */
function main(argv) {
  const parsed = parseArgv(Array.isArray(argv) ? argv : []);
  if (parsed.err) return usageError(parsed.err);
  const { positional, opts } = parsed;
  const command = (positional[0] || '').toLowerCase();
  const rest = positional.slice(1);

  if (opts.version || command === 'version') {
    let version = '0.0.0';
    try {
      version = require('../package.json').version;
    } catch (_) {
      /* standalone */
    }
    process.stdout.write(`${version}\n`);
    return 0;
  }
  if (opts.help || command === 'help' || command === '') {
    process.stdout.write(`${USAGE}\n`);
    return command === '' ? 0 : 0;
  }

  try {
    switch (command) {
      case 'init':
        return cmdInit(opts);
      case 'add':
        return cmdAdd(rest, opts);
      case 'list':
      case 'ls':
        return cmdList(opts);
      case 'show':
      case 'get':
        return cmdShow(rest, opts);
      case 'resolve':
        return cmdResolve(rest, opts);
      case 'remove':
      case 'rm':
        return cmdRemove(rest, opts);
      case 'search':
      case 'find':
        return cmdSearch(rest, opts);
      case 'export':
        return cmdExport(rest, opts);
      case 'import':
        return cmdImport(rest, opts);
      case 'stats':
        return cmdStats(opts);
      case 'doctor':
        return cmdDoctor(opts);
      case 'synthesize':
      case 'synth':
        return cmdSynthesize(rest, opts);
      case 'mcp-start':
      case 'mcp':
        return cmdMcpStart();
      default:
        return usageError(`unknown command "${positional[0]}"`);
    }
  } catch (err) {
    if (err instanceof ImmutableLawError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    if (err instanceof MemoryError || err.domain === true) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

module.exports = { main, USAGE };
module.exports.run = main;

if (require.main === module) {
  const code = main(process.argv.slice(2));
  if (code !== null && code !== undefined) process.exit(code);
}

