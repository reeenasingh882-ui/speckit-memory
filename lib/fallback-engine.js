/*
 * Built-in fallback engine — zero-dependency, file-backed memory store.
 * Used only when the canonical engine (lib/engine.js) is not installed yet.
 * Interface contract: see the header of mcp-server.js.
 *
 * Store location: $SPECKIT_MEMORY_PATH or ~/.speckit-memory/store.json
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const STORE_PATH = process.env.SPECKIT_MEMORY_PATH
  ? path.resolve(process.env.SPECKIT_MEMORY_PATH)
  : path.join(os.homedir(), '.speckit-memory', 'store.json');

const WORD_TARGET = 900;

class DomainError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DomainError';
    this.domain = true;
  }
}

function emptyState() {
  return { version: 1, memories: [] };
}

function corruptStore(reason) {
  const backupPath = `${STORE_PATH}.corrupt-${Date.now()}.bak`;
  try {
    fs.copyFileSync(STORE_PATH, backupPath);
  } catch (err) {
    throw new DomainError(`Memory store is corrupt (${reason}); backup failed: ${err.message}. No data was overwritten.`);
  }
  const err = new DomainError(
    `Memory store is corrupt (${reason}). Original preserved at ${backupPath}; no data was overwritten.`
  );
  err.backupPath = backupPath;
  throw err;
}

function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STORE_PATH, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyState();
    throw new DomainError(`Cannot read memory store ${STORE_PATH}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    corruptStore(err.message);
  }
  if (!parsed || !Array.isArray(parsed.memories)) corruptStore('memories must be an array');
  return parsed;
}

function persistState(state) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, STORE_PATH);
}

let sequence = 0;
function makeId(now = new Date()) {
  sequence = (sequence + 1) % 10000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `m_${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`
    + `_${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}_${p(sequence, 4)}`;
}

function countWords(text) {
  return (String(text).match(/\S+/g) || []).length;
}

function addMemory(input) {
  if (!input || typeof input !== 'object') throw new DomainError('memory_add: arguments must be an object.');
  const type = typeof input.type === 'string' ? input.type.trim() : '';
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  if (!type) throw new DomainError('memory_add: "type" must be a non-empty string.');
  if (!content) throw new DomainError('memory_add: "content" must be a non-empty string.');
  const record = {
    id: makeId(),
    type,
    content,
    feature: typeof input.feature === 'string' && input.feature.trim() ? input.feature.trim() : null,
    tags: Array.isArray(input.tags)
      ? input.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
      : [],
    createdAt: new Date().toISOString(),
  };
  const state = loadState();
  state.memories.push(record);
  persistState(state);
  return Object.assign({}, record, { totalCount: state.memories.length });
}

function listMemories(filter = {}) {
  let items = loadState().memories.slice();
  if (filter.type) items = items.filter((m) => m.type === filter.type);
  if (filter.feature) items = items.filter((m) => m.feature === filter.feature);
  items.sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id)));
  if (typeof filter.limit === 'number' && filter.limit > 0) items = items.slice(0, Math.floor(filter.limit));
  return items;
}

function searchMemories({ query, limit } = {}) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) throw new DomainError('memory_search: "query" must contain at least one keyword.');
  const scored = [];
  for (const m of loadState().memories) {
    const content = String(m.content || '').toLowerCase();
    const meta = `${m.type || ''} ${m.feature || ''} ${(m.tags || []).join(' ')}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (content.includes(term)) score += 2;
      if (meta.includes(term)) score += 1;
    }
    if (score > 0) scored.push({ memory: m, score });
  }
  scored.sort((a, b) =>
    b.score - a.score || String(b.memory.createdAt).localeCompare(String(a.memory.createdAt)));
  const max = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 20;
  return scored.slice(0, max).map((s) => s.memory);
}

function synthesize({ feature } = {}) {
  const label = typeof feature === 'string' ? feature.trim() : '';
  if (!label) throw new DomainError('memory_synthesize: "feature" must be a non-empty string.');
  const scoped = loadState().memories.filter((m) => m.feature === label);
  if (!scoped.length) {
    throw new DomainError(`No memories found for feature "${label}". Add feature-scoped memories with memory_add first.`);
  }

  const byType = new Map();
  for (const m of scoped) {
    if (!byType.has(m.type)) byType.set(m.type, []);
    byType.get(m.type).push(m);
  }

  const lines = [];
  lines.push(`# Feature synthesis — ${label}`);
  lines.push('');
  lines.push(`Generated ${new Date().toISOString()} from ${scoped.length} stored memories, grouped by category. Target length: ~${WORD_TARGET} words.`);
  lines.push('');
  for (const [type, group] of byType) {
    lines.push(`## ${type.charAt(0).toUpperCase()}${type.slice(1)} (${group.length})`);
    lines.push('');
    for (const m of group) {
      const tagNote = m.tags && m.tags.length ? ` _[${m.tags.join(', ')}]_` : '';
      lines.push(`- **${m.id}** — ${m.content}${tagNote}`);
    }
    lines.push('');
  }
  lines.push('## Coverage');
  lines.push('');
  lines.push(`Categories present: ${[...byType.keys()].sort().join(', ')}.`);
  lines.push(`${scoped.length} memories feed this synthesis.`);

  let markdown = lines.join('\n');
  const words = countWords(markdown);
  if (words < WORD_TARGET) {
    markdown += `\n\n_Note: ${words} words — below the ~${WORD_TARGET}-word target because the stored source memories are shorter. No padding was added._\n`;
  } else if (words > WORD_TARGET) {
    const note = '\n\n_Truncated to the 900-word limit; remaining memories were omitted._';
    const budget = Math.max(1, WORD_TARGET - countWords(note));
    // Trim line-by-line so headings and list structure survive truncation.
    const out = [];
    let count = 0;
    for (const lineText of markdown.split('\n')) {
      const w = countWords(lineText);
      if (count + w > budget && out.length > 0) break;
      out.push(lineText);
      count += w;
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    markdown = out.join('\n') + note;
  }
  return { feature: label, words: countWords(markdown), markdown, memoryCount: scoped.length };
}

module.exports = { STORE_PATH, WORD_TARGET, addMemory, listMemories, searchMemories, synthesize };
