'use strict';
/** Canonical MCP engine backed by the same MemoryStore used by the CLI. */
const path = require('node:path');
const { MemoryStore, MemoryError } = require('./memory-store');
const { synthesize } = require('./synthesizer');
const { slugify } = require('./fs-utils');

const MEMORY_TYPES = [
  'law', 'history', 'feature', 'decision', 'worklog', 'bug-prevention',
  'watchpoint', 'open-question', 'pattern', 'rule', 'preference',
  'context', 'lesson', 'insight', 'note',
];
const TYPE_MAP = {
  decision: { type: 'history', category: 'decisions' },
  decisions: { type: 'history', category: 'decisions' },
  worklog: { type: 'history', category: 'worklogs' },
  worklogs: { type: 'history', category: 'worklogs' },
  log: { type: 'history', category: 'worklogs' },
  'bug-prevention': { type: 'history', category: 'bug-preventions' },
  'bug-preventions': { type: 'history', category: 'bug-preventions' },
  bug: { type: 'history', category: 'bug-preventions' },
  lesson: { type: 'history', category: 'bug-preventions' },
  watchpoint: { type: 'feature', kind: 'watchpoint' },
  watchpoints: { type: 'feature', kind: 'watchpoint' },
  wp: { type: 'feature', kind: 'watchpoint' },
  'open-question': { type: 'feature', kind: 'open-question' },
  'open-questions': { type: 'feature', kind: 'open-question' },
  oq: { type: 'feature', kind: 'open-question' },
  question: { type: 'feature', kind: 'open-question' },
  pattern: { type: 'history', category: 'decisions' },
  rule: { type: 'history', category: 'decisions' },
  preference: { type: 'history', category: 'decisions' },
  context: { type: 'history', category: 'worklogs' },
  insight: { type: 'history', category: 'worklogs' },
  note: { type: 'history', category: 'worklogs' },
};
const CONFIG_PATH = process.env.SPECKIT_MEMORY_ROOT
  || process.env.SPECKIT_MEMORY_PATH
  || process.env.SPECKIT_MEMORY_DB
  || null;
let store = null;

function projectRoot() {
  if (process.env.SPECKIT_MEMORY_ROOT) return path.resolve(process.env.SPECKIT_MEMORY_ROOT);
  if (CONFIG_PATH) {
    const absolute = path.resolve(CONFIG_PATH);
    return path.extname(absolute) ? path.dirname(absolute) : absolute;
  }
  try { return MemoryStore.open(process.cwd()).rootDir; }
  catch (_) { return process.cwd(); }
}

function ctx() {
  if (!store) {
    store = new MemoryStore(projectRoot());
    // Explicit-init only: the MCP engine must not silently create .specify/
    // trees in whatever directory the client happened to start us from.
    if (!store.isInitialized()) {
      throw new MemoryError(
        'Memory trees are not initialized. Run `speckit-memory init` first ' +
          '(or point SPECKIT_MEMORY_ROOT at an initialized project).'
      );
    }
  }
  return store;
}

function typeMapping(type) {
  const key = String(type || '').trim().toLowerCase();
  if (key === 'law' || key === 'history' || key === 'feature') return { type: key };
  if (!TYPE_MAP[key]) throw new MemoryError(`Unknown memory type "${type}".`);
  return TYPE_MAP[key];
}

function publicRow(entry) {
  const type = entry.mcpType || (entry.type === 'history'
    ? ({ decisions: 'decision', worklogs: 'worklog', 'bug-preventions': 'bug-prevention' })[entry.category]
    : entry.type === 'feature' ? (entry.category || 'feature') : entry.type);
  return {
    id: entry.id,
    type,
    content: entry.content,
    feature: entry.feature || null,
    tags: entry.tags || [],
    metadata: entry.metadata,
    category: entry.category || null,
    status: entry.status || null,
    filePath: entry.filePath,
    createdAt: entry.created || null,
    updatedAt: entry.updated || entry.created || null,
  };
}

function addMemory(input = {}) {
  const type = typeof input.type === 'string' ? input.type.trim() : '';
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  if (!type) throw new MemoryError('addMemory: "type" must be a non-empty string.');
  if (!content) throw new MemoryError('addMemory: "content" must be a non-empty string.');
  const mapping = typeMapping(type);
  if (mapping.type === 'feature' && (typeof input.feature !== 'string' || !input.feature.trim())) {
    throw new MemoryError('Feature memory requires a feature name.');
  }
  const entry = ctx().add({
    ...mapping,
    content,
    feature: input.feature,
    title: input.title,
    tags: input.tags,
    metadata: input.metadata,
    mcpType: type,
    category: input.category || mapping.category,
    kind: input.kind || mapping.kind,
  });
  return { ...publicRow(entry), totalCount: ctx().scan().length };
}

function listMemories({ type, feature, limit } = {}) {
  let rows = ctx().list({ feature: feature ? slugify(feature) : undefined });
  if (type) {
    const mapping = typeMapping(type);
    const original = String(type).trim().toLowerCase();
    rows = rows.filter((entry) => {
      if (entry.mcpType) return entry.mcpType.toLowerCase() === original;
      if (entry.type !== mapping.type) return false;
      if (mapping.category && entry.category !== mapping.category) return false;
      if (mapping.kind && entry.category !== mapping.kind) return false;
      return true;
    });
  }
  rows.sort((a, b) => String(b.created || '').localeCompare(String(a.created || ''))
    || String(b.id).localeCompare(String(a.id)));
  const lim = Math.min(Math.max(1, Number(limit) || 50), 1000);
  return rows.slice(0, lim).map(publicRow);
}

function snippet(content, terms) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  const indexes = terms.map((term) => lower.indexOf(term)).filter((i) => i >= 0);
  const start = indexes.length ? Math.max(0, Math.min(...indexes) - 60) : 0;
  return (start ? '...' : '') + text.slice(start, start + 200) + (start + 200 < text.length ? '...' : '');
}

function searchMemories({ query, limit } = {}) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new MemoryError('searchMemories: "query" must be a non-empty string.');
  }
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const entry of ctx().scan()) {
    const content = String(entry.content || '').toLowerCase();
    const meta = `${entry.mcpType || ''} ${entry.type} ${entry.category || ''} ${entry.feature || ''} ${entry.title || ''} ${(entry.tags || []).join(' ')}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (content.includes(term)) score += 2;
      if (meta.includes(term)) score += 1;
    }
    if (score) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || String(b.entry.created || '').localeCompare(String(a.entry.created || '')));
  const max = Math.min(Math.max(1, Number(limit) || 20), 100);
  return scored.slice(0, max).map(({ entry }) => ({ ...publicRow(entry), snippet: snippet(entry.content, terms) }));
}

function synthesizeFeature({ feature } = {}) {
  if (typeof feature !== 'string' || !feature.trim()) {
    throw new MemoryError('memory_synthesize: "feature" must be a non-empty string.');
  }
  const label = slugify(feature);
  const scoped = ctx().list({ feature: label });
  if (!scoped.length) {
    throw new MemoryError(`No memories found for feature "${label}". Add feature-scoped memories with memory_add first.`);
  }
  const out = synthesize(ctx(), label, {
    write: false,
    heading: `# Feature synthesis — ${label}`,
  });
  return { feature: label, words: out.wordCount, markdown: out.body, memoryCount: scoped.length };
}

function resolveMemory({ id } = {}) {
  if (typeof id !== 'string' || !id.trim()) {
    throw new MemoryError('resolveMemory: "id" must be a non-empty string.');
  }
  const entry = ctx().resolve(id.trim().toUpperCase());
  return { ...publicRow(entry), totalCount: ctx().scan().length };
}

function deleteMemory({ id } = {}) {
  if (typeof id !== 'string' || !id.trim()) {
    throw new MemoryError('deleteMemory: "id" must be a non-empty string.');
  }
  const key = id.trim().toUpperCase();
  const entry = ctx().get(key);
  if (!entry) throw new MemoryError(`No entry with id ${key}`);
  ctx().remove(key);
  return { ...publicRow(entry), totalCount: ctx().scan().length };
}

function close() {
  if (store) store.close();
  store = null;
}

module.exports = {
  addMemory,
  listMemories,
  searchMemories,
  resolveMemory,
  deleteMemory,
  synthesize: synthesizeFeature,
  // Explicit name too: `synthesize` above is the MCP-shaped entry point;
  // `synthesizeFeature` documents the actual signature for programmatic use.
  synthesizeFeature,
  MEMORY_TYPES,
  DB_PATH: CONFIG_PATH,
  projectRoot,
  close,
};
