'use strict';
/**
 * sqlite-cache.js — SQLite-backed memory index + search cache for speckit-memory.
 *
 * Schema (auto-created on first open):
 *   memories(id, type, path, feature, content, source_mtime, created_at, updated_at)
 *     - one row per memory file (unique index on `path`)
 *     - source_mtime (epoch ms) drives change detection / cache invalidation
 *   synthesis_cache(feature, content, word_count, created_at)
 *     - one synthesized 900-word brief per feature; invalidated automatically
 *       whenever any memory row of that feature changes
 *   memories_fts (FTS5, best effort) — keyword search with bm25 ranking.
 *     Falls back to LIKE matching when FTS5 is unavailable.
 *
 * Public API (class MemoryCache):
 *   new MemoryCache(dbPath | ':memory:', { fts = true })
 *   static MemoryCache.defaultPath()                  -> ~/.speckit/cache.db
 *   indexMemory({ type, path, feature, content, mtime })  -> { id, changed }
 *   indexFile(filePath, { feature, type } = {})       -> { id, changed, skipped }
 *   syncDirectory(dir, opts)                          -> { indexed, unchanged, removed, featuresTouched }
 *   removePath(p) / removeFeature(feature)
 *   get(id) / getByPath(p)
 *   search({ keywords, feature, type, since, until, limit, offset, order })
 *   listFeatures() / listTypes() / stats()
 *   getCachedSynthesis(f) / setCachedSynthesis(f, content, wordCount)
 *   isSynthesisStale(f) / invalidateSynthesis(f)
 *   close()
 *
 * Backend: node:sqlite (built-in, Node >= 22.5) preferred, better-sqlite3 fallback.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ---------------------------------------------------------------- backend */

function resolveBackend() {
  try {
    // Node >= 22.5
    const { DatabaseSync } = require('node:sqlite');
    return { name: 'node:sqlite', open: (p) => new DatabaseSync(p) };
  } catch (_) { /* keep trying */ }
  try {
    // Optional dependency path
    const Database = require('better-sqlite3');
    return { name: 'better-sqlite3', open: (p) => new Database(p) };
  } catch (_) { /* keep trying */ }
  throw new Error(
    'speckit-memory: no SQLite backend available. ' +
    'Use Node >= 22.5 (node:sqlite) or install better-sqlite3.'
  );
}

/* ------------------------------------------------------------------ utils */

function nowIso() {
  return new Date().toISOString();
}

function toIso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value);
  const t = Date.parse(s);
  return Number.isNaN(t) ? s : new Date(t).toISOString();
}

function countWords(text) {
  const t = String(text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

function normalizeRel(p) {
  return path.resolve(String(p || ''));
}

/* -------------------------------------------------------------- main class */

class MemoryCache {
  constructor(dbPath = MemoryCache.defaultPath(), opts = {}) {
    this.backend = resolveBackend();
    this.ftsEnabled = opts.fts !== false;
    this.dbPath = dbPath;

    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = this.backend.open(dbPath);
    this._configure();
    this._ensureSchema();
    this._prepareStatements();
  }

  static defaultPath() {
    return path.join(os.homedir(), '.speckit', 'cache.db');
  }

  _configure() {
    this.db.exec('PRAGMA busy_timeout = 5000;');
    try { this.db.exec('PRAGMA journal_mode = WAL;'); } catch (_) { /* in-memory DB */ }
    try { this.db.exec('PRAGMA synchronous = NORMAL;'); } catch (_) { /* older builds */ }
  }

  _ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        type         TEXT NOT NULL,
        path         TEXT NOT NULL,
        feature      TEXT NOT NULL,
        content      TEXT NOT NULL,
        source_mtime REAL,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_path ON memories(path);
      CREATE INDEX IF NOT EXISTS idx_memories_feature ON memories(feature);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_feature_type ON memories(feature, type);
      CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);

      CREATE TABLE IF NOT EXISTS synthesis_cache (
        feature    TEXT PRIMARY KEY,
        content    TEXT NOT NULL,
        word_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    // FTS5 is best-effort: some bundled SQLite builds lack it.
    if (this.ftsEnabled) {
      try {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
            content, feature, path,
            content='memories', content_rowid='id'
          );
        `);
        this.db.exec(`
          CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
            INSERT INTO memories_fts(rowid, content, feature, path)
            VALUES (new.id, new.content, new.feature, new.path);
          END;
          CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, rowid, content, feature, path)
            VALUES ('delete', old.id, old.content, old.feature, old.path);
          END;
          CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, rowid, content, feature, path)
            VALUES ('delete', old.id, old.content, old.feature, old.path);
            INSERT INTO memories_fts(rowid, content, feature, path)
            VALUES (new.id, new.content, new.feature, new.path);
          END;
        `);
        this.fts = true;
        // Idempotent and required when FTS is enabled on an existing database.
        this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
      } catch (_) {
        this.fts = false;
      }
    } else {
      this.fts = false;
    }

    // Column evolution for databases created by older versions of this module.
    const cols = new Set(this.db.prepare("PRAGMA table_info('memories')").all().map((c) => c.name));
    for (const [col, decl] of [['source_mtime', 'REAL'], ['tags', 'TEXT'], ['metadata', 'TEXT']]) {
      if (!cols.has(col)) this.db.exec(`ALTER TABLE memories ADD COLUMN ${col} ${decl}`);
    }
  }

  _prepareStatements() {
    const S = (sql) => this.db.prepare(sql);
    this._stmt = {
      insertMemory: S(`INSERT INTO memories(type, path, feature, content, tags, metadata, source_mtime, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      updateMemory: S(`UPDATE memories SET type = ?, path = ?, feature = ?, content = ?,
                       tags = ?, metadata = ?, source_mtime = ?, updated_at = ? WHERE id = ?`),
      touchMtime: S(`UPDATE memories SET source_mtime = ? WHERE id = ?`),
      deleteByPath: S(`DELETE FROM memories WHERE path = ?`),
      deleteByFeature: S(`DELETE FROM memories WHERE feature = ?`),
      getById: S(`SELECT * FROM memories WHERE id = ?`),
      getByPath: S(`SELECT * FROM memories WHERE path = ?`),
      listFeatures: S(`SELECT feature, COUNT(*) AS count, MAX(updated_at) AS latest
                       FROM memories GROUP BY feature ORDER BY feature`),
      listTypes: S(`SELECT type, COUNT(*) AS count FROM memories GROUP BY type ORDER BY type`),
      countAll: S(`SELECT COUNT(*) AS n FROM memories`),
      countFeature: S(`SELECT COUNT(*) AS n FROM memories WHERE feature = ?`),
      countFeatureType: S(`SELECT COUNT(*) AS n FROM memories WHERE feature = ? AND type = ?`),
      maxUpdatedByFeature: S(`SELECT MAX(updated_at) AS m FROM memories WHERE feature = ?`),
      pathsUnder: S(`SELECT id, path, feature FROM memories`),
      getSynth: S(`SELECT * FROM synthesis_cache WHERE feature = ?`),
      setSynth: S(`INSERT INTO synthesis_cache(feature, content, word_count, created_at)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(feature) DO UPDATE SET
                     content = excluded.content,
                     word_count = excluded.word_count,
                     created_at = excluded.created_at`),
      delSynth: S(`DELETE FROM synthesis_cache WHERE feature = ?`),
      countSynth: S(`SELECT COUNT(*) AS n FROM synthesis_cache`),
    };
  }

  /* ------------------------------------------------------------- indexing */

  /**
   * Upsert one memory. `path` is the identity. `updated_at` only moves when the
   * stored content actually changes, so synthesis caches are not invalidated by
   * harmless re-index runs. Changing feature/content invalidates the synthesis
   * cache of both the old and the new feature.
   */
  indexMemory({ type, path: filePath, feature, content, tags, metadata, mtime }) {
    if (!filePath) throw new Error('indexMemory: path is required');
    const abs = normalizeRel(filePath);
    const t = String(type || 'other');
    const f = String(feature || '(global)');
    const body = String(content == null ? '' : content);
    const ms = mtime == null ? null : Number(mtime);
    const tagsJson = tags == null ? null : JSON.stringify(tags);
    const metaJson = metadata == null ? null : JSON.stringify(metadata);

    const existing = this._stmt.getByPath.get(abs);
    let changed = false;
    let prevFeature = null;
    let id;

    if (!existing) {
      const res = this._stmt.insertMemory.run(t, abs, f, body, tagsJson, metaJson, ms, nowIso(), nowIso());
      id = Number(res.lastInsertRowid);
      changed = true;
    } else {
      id = Number(existing.id);
      prevFeature = existing.feature;
      if (existing.type !== t || existing.feature !== f || existing.content !== body ||
          (existing.tags ?? null) !== tagsJson || (existing.metadata ?? null) !== metaJson) {
        this._stmt.updateMemory.run(t, abs, f, body, tagsJson, metaJson, ms, nowIso(), id);
        changed = true;
      } else if (ms !== null && existing.source_mtime !== ms) {
        this._stmt.touchMtime.run(ms, id);
      }
    }

    if (changed) {
      this.invalidateSynthesis(f);
      if (prevFeature && prevFeature !== f) this.invalidateSynthesis(prevFeature);
    }
    return { id, changed };
  }

  /**
   * Index a file from disk. When feature/type are not provided they are
   * derived from the layout `<memoriesDir>/<feature>/<type>.md`:
   *   type    = basename without extension, singularized (decisions -> decision)
   *   feature = parent directory name
   */
  indexFile(filePath, { feature, type } = {}) {
    const abs = normalizeRel(filePath);
    let st;
    try {
      st = fs.statSync(abs);
    } catch (_) {
      return { skipped: true, reason: 'missing' };
    }
    if (!st.isFile()) return { skipped: true, reason: 'not-a-file' };

    const content = fs.readFileSync(abs, 'utf8');
    const resolvedType = type || MemoryCache.deriveType(abs);
    const resolvedFeature = feature || MemoryCache.deriveFeature(abs);
    const { id, changed } = this.indexMemory({
      type: resolvedType, path: abs, feature: resolvedFeature,
      content, mtime: st.mtimeMs,
    });
    return { id, changed };
  }

  static deriveType(absPath) {
    const base = path.basename(absPath, path.extname(absPath)).toLowerCase();
    const singular = base.endsWith('ies') ? base.slice(0, -3) + 'y'
      : base.endsWith('s') && !base.endsWith('ss') ? base.slice(0, -1)
      : base;
    return singular;
  }

  static deriveFeature(absPath) {
    return path.basename(path.dirname(normalizeRel(absPath))) || '(global)';
  }

  /**
   * Walk `dir` recursively, (re)index every memory file and delete rows whose
   * source file no longer exists. Returns per-run counters plus the set of
   * features whose synthesis caches were touched.
   */
  syncDirectory(dir, opts = {}) {
    const extensions = new Set(opts.extensions || ['.md', '.markdown']);
    const root = normalizeRel(dir);
    if (!fs.existsSync(root)) throw new Error(`syncDirectory: ${root} does not exist`);

    const found = [];
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.isFile() && extensions.has(path.extname(ent.name).toLowerCase())) found.push(p);
      }
    };
    walk(root);

    let indexed = 0, unchanged = 0, skipped = 0;
    const featuresTouched = new Set();
    for (const p of found) {
      const r = this.indexFile(p, opts.infer || {});
      if (r.skipped) { skipped++; continue; }
      if (r.changed) {
        indexed++;
        featuresTouched.add(opts.infer && opts.infer.feature
          ? String(opts.infer.feature)
          : MemoryCache.deriveFeature(p));
      }
      else unchanged++;
    }

    // Remove rows under `root` whose files vanished.
    let removed = 0;
    const foundSet = new Set(found.map(normalizeRel));
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    for (const row of this._stmt.pathsUnder.all()) {
      const rp = normalizeRel(row.path);
      if (rp !== root && !rp.startsWith(prefix)) continue;
      if (!foundSet.has(rp)) {
        this._stmt.deleteByPath.run(rp);
        this.invalidateSynthesis(row.feature);
        featuresTouched.add(row.feature);
        removed++;
      }
    }
    return { indexed, unchanged, skipped, removed, featuresTouched: [...featuresTouched] };
  }

  removePath(p) {
    const abs = normalizeRel(p);
    const row = this._stmt.getByPath.get(abs);
    if (!row) return false;
    this._stmt.deleteByPath.run(abs);
    this.invalidateSynthesis(row.feature);
    return true;
  }

  removeFeature(feature) {
    const had = this.count({ feature }) > 0;
    this._stmt.deleteByFeature.run(feature);
    this.invalidateSynthesis(feature);
    return had;
  }

  /* -------------------------------------------------------------- queries */

  get(id) { return MemoryCache._row(this._stmt.getById.get(id)) || null; }
  getByPath(p) { return MemoryCache._row(this._stmt.getByPath.get(normalizeRel(p))) || null; }

  getByFeature(feature, { type, limit = null } = {}) {
    return this._query({ feature, type, limit, order: 'recent' });
  }

  /** Newest-first listing across all features (engine contract: listMemories). */
  list({ type, feature, limit = 50 } = {}) {
    return this._query({ type, feature, limit, order: 'recent' });
  }

  /**
   * Keyword search with optional filters.
   *   keywords: string | string[]  (whitespace-split; AND semantics, OR with mode:'or')
   *   feature / type: exact filters
   *   since / until:  ISO string or Date, compared against updated_at
   *   order: 'relevance' (default; bm25 via FTS or recency fallback)
   *          | 'recent' | 'oldest'
   * Returns rows with an added `snippet` field.
   */
  search(opts = {}) {
    const keywords = MemoryCache._keywords(opts.keywords);
    const rows = this._query({ ...opts, keywords, mode: opts.mode });
    for (const r of rows) r.snippet = MemoryCache._snippet(r.content, keywords);
    return rows;
  }

  static _keywords(k) {
    if (k == null) return [];
    const arr = Array.isArray(k) ? k : String(k).split(/\s+/);
    return arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  }

  _query({ keywords = [], mode = 'and', feature, type, since, until, limit = 50, offset = 0, order = 'relevance' } = {}) {
    if (limit !== null) limit = Math.max(1, Number(limit) || 50);
    offset = Math.max(0, Number(offset) || 0);

    const where = [];
    const params = [];
    if (feature) { where.push('m.feature = ?'); params.push(feature); }
    if (type) { where.push('m.type = ?'); params.push(type); }
    const sinceIso = toIso(since); if (sinceIso) { where.push('m.updated_at >= ?'); params.push(sinceIso); }
    const untilIso = toIso(until); if (untilIso) { where.push('m.updated_at <= ?'); params.push(untilIso); }

    let sql;
    if (keywords.length && this.fts && order === 'relevance') {
      const match = MemoryCache._ftsQuery(keywords, mode);
      if (!match) return [];
      where.push('memories_fts MATCH ?');
      params.push(match);
      sql = `SELECT m.*, bm25(memories_fts) AS rank
             FROM memories m JOIN memories_fts ON memories_fts.rowid = m.id
             ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
             ORDER BY rank`;
    } else {
      const kwConds = [];
      for (const kw of keywords) {
        kwConds.push("(lower(m.content) LIKE ? ESCAPE '\\' OR lower(m.feature) LIKE ? ESCAPE '\\' OR lower(m.path) LIKE ? ESCAPE '\\')");
        const like = '%' + MemoryCache._escapeLike(kw) + '%';
        params.push(like, like, like);
      }
      if (kwConds.length) {
        where.push(mode === 'or' ? `(${kwConds.join(' OR ')})` : kwConds.join(' AND '));
      }
      const ord = order === 'oldest' ? 'm.updated_at ASC, m.id ASC' : 'm.updated_at DESC, m.id DESC';
      sql = `SELECT m.* FROM memories m
             ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
             ORDER BY ${ord}`;
    }
    if (limit !== null) {
      sql += ' LIMIT ? OFFSET ?';
      params.push(limit, offset);
    } else if (offset) {
      sql += ' LIMIT -1 OFFSET ?';
      params.push(offset);
    }
    return this.db.prepare(sql).all(...params).map(MemoryCache._row);
  }

  static _ftsQuery(keywords, mode = 'and') {
    // Phrase-quote each token; prefix-match keeps partial identifiers findable.
    const terms = keywords
      .map((k) => k.replace(/["'^*()]/g, ' ').trim())
      .filter(Boolean)
      .map((k) => `"${k}"*`);
    return terms.join(mode === 'or' ? ' OR ' : ' AND ');
  }

  static _escapeLike(s) {
    return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
  }

  static _snippet(content, keywords, maxLen = 200) {
    const text = String(content || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    let idx = -1;
    for (const kw of keywords) {
      const i = text.toLowerCase().indexOf(kw);
      if (i !== -1 && (idx === -1 || i < idx)) idx = i;
    }
    if (idx === -1) return text.slice(0, maxLen) + (text.length > maxLen ? '...' : '');
    const start = Math.max(0, idx - 60);
    const snip = text.slice(start, start + maxLen);
    return (start > 0 ? '...' : '') + snip + (start + maxLen < text.length ? '...' : '');
  }

  static _row(r) {
    if (r && r.id != null) r.id = Number(r.id);
    if (r && r.rank != null) r.rank = Number(r.rank);
    if (r && 'tags' in r) {
      if (r.tags == null) { r.tags = []; }
      else {
        try {
          const parsed = JSON.parse(r.tags);
          r.tags = Array.isArray(parsed) ? parsed : [];
        } catch (_) { r.tags = []; }
      }
    }
    if (r && 'metadata' in r) {
      if (r.metadata == null) { r.metadata = undefined; }
      else { try { r.metadata = JSON.parse(r.metadata); } catch (_) { r.metadata = undefined; } }
    }
    return r;
  }

  listFeatures() { return this._stmt.listFeatures.all(); }
  listTypes() { return this._stmt.listTypes.all(); }

  count({ feature, type } = {}) {
    if (feature && type) {
      return Number(this._stmt.countFeatureType.get(feature, type).n);
    }
    if (feature) return Number(this._stmt.countFeature.get(feature).n);
    return Number(this._stmt.countAll.get().n);
  }

  stats() {
    const byType = {};
    for (const r of this._stmt.listTypes.all()) byType[r.type] = r.count;
    const byFeature = {};
    for (const r of this._stmt.listFeatures.all()) byFeature[r.feature] = r.count;
    return {
      dbPath: this.dbPath,
      backend: this.backend.name,
      fts: this.fts,
      memories: Number(this._stmt.countAll.get().n),
      features: Object.keys(byFeature).length,
      byType,
      byFeature,
      synthesisCached: Number(this._stmt.countSynth.get().n),
    };
  }

  /* -------------------------------------------------------- synthesis cache */

  getCachedSynthesis(feature) {
    const row = this._stmt.getSynth.get(String(feature));
    return row || null;
  }

  setCachedSynthesis(feature, content, wordCount) {
    const f = String(feature);
    this._stmt.setSynth.run(f, String(content), Number(wordCount ?? countWords(content)), nowIso());
  }

  /** A cached synthesis is stale when any memory of the feature changed after it was written. */
  isSynthesisStale(feature) {
    const cached = this.getCachedSynthesis(feature);
    if (!cached) return true;
    const m = this._stmt.maxUpdatedByFeature.get(String(feature)).m;
    if (!m) return false; // no memories exist; the "empty" cache stays valid
    return m > cached.created_at;
  }

  invalidateSynthesis(feature) {
    this._stmt.delSynth.run(String(feature));
  }

  close() {
    try { this.db.close(); } catch (_) { /* already closed */ }
  }
}

module.exports = { MemoryCache, countWords };
