'use strict';

/**
 * MemoryStore — the canonical file-backed memory engine for speckit-memory.
 *
 * Three memory trees inside a project:
 *
 *   .specify/memory/     Governance Law   (immutable, append-only)
 *     laws/LAW-####-slug.md
 *   docs/memory/         Project History  (long-term memory)
 *     decisions/DEC-#### ... .md (dated filenames)
 *     worklogs/LOG-#### ... .md
 *     bug-preventions/BUG-#### ... .md
 *   specs/<feature>/     Feature Memory
 *     watchpoints.md    (appended entries "## WP-<FEATURE>-####: title (date)")
 *     open-questions.md (appended entries "## OQ-<FEATURE>-####: title (date)")
 *     memory.md         (generated 900-word synthesis, written by synthesizer)
 *
 * A derived index cache lives in .speckit-memory/ (SQLite via the built-in
 * node:sqlite module when available, JSON file otherwise). The cache is fully
 * rebuildable from the markdown files at any time via scan().
 *
 * Markdown files carry YAML frontmatter (subset, see fs-utils).
 */

const fs = require('fs');
const path = require('path');
const u = require('./fs-utils');

const CACHE_SCHEMA_VERSION = '2';

const TYPE_LAW = 'law';
const TYPE_HISTORY = 'history';
const TYPE_FEATURE = 'feature';
const TYPES = [TYPE_LAW, TYPE_HISTORY, TYPE_FEATURE];

const HISTORY_CATEGORIES = {
  decisions: { idPrefix: 'DEC', label: 'Decisions' },
  worklogs: { idPrefix: 'LOG', label: 'Worklogs' },
  'bug-preventions': { idPrefix: 'BUG', label: 'Bug Preventions' },
};

const HISTORY_CATEGORY_ALIASES = {
  decision: 'decisions',
  decisions: 'decisions',
  worklog: 'worklogs',
  worklogs: 'worklogs',
  log: 'worklogs',
  'bug-prevention': 'bug-preventions',
  'bug-preventions': 'bug-preventions',
  bug: 'bug-preventions',
  lesson: 'bug-preventions',
};

const FEATURE_KINDS = {
  watchpoint: { file: 'watchpoints.md', idPrefix: 'WP', label: 'watchpoints' },
  'open-question': {
    file: 'open-questions.md',
    idPrefix: 'OQ',
    label: 'open questions',
  },
};

const FEATURE_KIND_ALIASES = {
  watchpoint: 'watchpoint',
  watchpoints: 'watchpoint',
  wp: 'watchpoint',
  'open-question': 'open-question',
  'open-questions': 'open-question',
  oq: 'open-question',
  question: 'open-question',
};

const RESOLVED_MARKER_RE = /\*\*\[RESOLVED[^\]]*\]\*\*/;

class MemoryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MemoryError';
    this.code = code || 'EMEMORY';
    this.domain = true; // MCP handler reports domain errors as tool results
  }
}

class ImmutableLawError extends MemoryError {
  constructor(id) {
    super(
      `Governance laws are immutable: ${id} cannot be modified or removed. ` +
        'Append a new law instead.',
      'EIMMUTABLE'
    );
    this.name = 'ImmutableLawError';
  }
}

// ---------------------------------------------------------------------------
// MemoryCache — derived index (SQLite preferred, JSON fallback)
// ---------------------------------------------------------------------------

class MemoryCache {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
    u.ensureDir(cacheDir);
    let DatabaseSync = null;
    try {
      // Node >= 22.5 (stable enough for an index cache; JSON fallback below)
      DatabaseSync = require('node:sqlite').DatabaseSync;
    } catch (_) {
      DatabaseSync = null;
    }
    if (DatabaseSync) {
      this.kind = 'sqlite';
      const dbPath = path.join(cacheDir, 'index.db');
      this.db = new DatabaseSync(dbPath);
      this.db.exec(`CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )`);

      const tableExists = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'"
      ).get();
      let composite = false;
      if (tableExists) {
        const pkColumns = this.db.prepare('PRAGMA table_info(memories)').all()
          .filter((row) => Number(row.pk) > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((row) => row.name);
        composite = pkColumns.length === 2 && pkColumns[0] === 'id' && pkColumns[1] === 'feature';
      }

      const createMemories = `CREATE TABLE memories (
        id TEXT,
        type TEXT NOT NULL,
        category TEXT,
        feature TEXT,
        title TEXT,
        file_path TEXT NOT NULL,
        created TEXT,
        updated TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT,
        word_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT,
        PRIMARY KEY (id, feature)
      )`;

      if (tableExists && !composite) {
        this.db.exec('BEGIN');
        try {
          this.db.exec('ALTER TABLE memories RENAME TO memories_legacy');
          this.db.exec(createMemories);
          this.db.exec(`INSERT INTO memories
            (id, type, category, feature, title, file_path, created, updated, tags, content_hash, word_count, indexed_at)
            SELECT id, type, category, feature, title, file_path, created, updated, tags, content_hash, word_count, indexed_at
            FROM memories_legacy`);
          this.db.exec('DROP TABLE memories_legacy');
          this.db.exec('COMMIT');
        } catch (err) {
          this.db.exec('ROLLBACK');
          throw err;
        }
      } else if (!tableExists) {
        this.db.exec(createMemories);
      }

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
        CREATE INDEX IF NOT EXISTS idx_memories_feature ON memories(feature);
        CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      `);
      this.db
        .prepare(
          "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)"
        )
        .run(CACHE_SCHEMA_VERSION);
    } else {
      this.kind = 'json';
      this.jsonPath = path.join(cacheDir, 'index.json');
      this.rows = [];
      if (u.fileExists(this.jsonPath)) {
        try {
          const parsed = JSON.parse(u.readTextFile(this.jsonPath));
          this.rows = Array.isArray(parsed.rows) ? parsed.rows : [];
        } catch (_) {
          this.rows = [];
        }
      }
    }
  }

  replaceAll(entries) {
    const indexedAt = u.nowIso();
    if (this.kind === 'sqlite') {
      this.db.exec('BEGIN');
      try {
        this.db.exec('DELETE FROM memories');
        const stmt = this.db.prepare(
          `INSERT INTO memories
             (id, type, category, feature, title, file_path,
              created, updated, tags, content_hash, word_count, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const e of entries) {
          stmt.run(
            e.id,
            e.type,
            e.category || null,
            e.feature || null,
            e.title || '',
            e.filePath,
            e.created || null,
            e.updated || null,
            JSON.stringify(e.tags || []),
            e.hash || null,
            e.wordCount || 0,
            indexedAt
          );
        }
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    } else {
      this.rows = entries.map((e) => ({
        id: e.id,
        type: e.type,
        category: e.category || null,
        feature: e.feature || null,
        title: e.title || '',
        file_path: e.filePath,
        created: e.created || null,
        updated: e.updated || null,
        tags: JSON.stringify(e.tags || []),
        content_hash: e.hash || null,
        word_count: e.wordCount || 0,
        indexed_at: indexedAt,
      }));
      u.writeTextFileAtomic(
        this.jsonPath,
        JSON.stringify({ schema_version: CACHE_SCHEMA_VERSION, rows: this.rows }, null, 2)
      );
    }
    return entries.length;
  }

  /**
   * Query the derived index. Returns index rows (no content — content lives
   * in the markdown files). filter: {type, category, feature, tag}
   */
  query(filter = {}) {
    let rows;
    if (this.kind === 'sqlite') {
      const where = [];
      const params = [];
      if (filter.type) {
        where.push('type = ?');
        params.push(filter.type);
      }
      if (filter.category) {
        where.push('category = ?');
        params.push(filter.category);
      }
      if (filter.feature) {
        where.push('feature = ?');
        params.push(filter.feature);
      }
      const sql =
        'SELECT * FROM memories' +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY id';
      rows = this.db.prepare(sql).all(...params);
    } else {
      rows = this.rows.filter(
        (r) =>
          (!filter.type || r.type === filter.type) &&
          (!filter.category || r.category === filter.category) &&
          (!filter.feature || r.feature === filter.feature)
      );
    }
    if (filter.tag) {
      rows = rows.filter((r) => {
        try {
          return JSON.parse(r.tags).includes(filter.tag);
        } catch (_) {
          return false;
        }
      });
    }
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      category: r.category,
      feature: r.feature,
      title: r.title,
      filePath: r.file_path,
      created: r.created,
      updated: r.updated,
      tags: safeParseTags(r.tags),
      hash: r.content_hash,
      wordCount: r.word_count,
      indexedAt: r.indexed_at,
    }));
  }

  count() {
    if (this.kind === 'sqlite') {
      return this.db.prepare('SELECT COUNT(*) AS c FROM memories').get().c;
    }
    return this.rows.length;
  }

  close() {
    if (this.kind === 'sqlite' && this.db) {
      try {
        this.db.close();
      } catch (_) {
        /* already closed */
      }
    }
  }
}

function safeParseTags(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

class MemoryStore {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    this.memoryDocRoot = path.join(this.rootDir, '.specify', 'memory');
    this.lawRoot = path.join(this.memoryDocRoot, 'laws');
    this.historyRoot = path.join(this.rootDir, 'docs', 'memory');
    this.specsRoot = path.join(this.rootDir, 'specs');
    this.cacheDir = path.join(this.rootDir, '.speckit-memory');
    this._cache = null;
  }

  /** Resolve the store for the project containing startDir (or cwd). */
  static open(startDir) {
    const root = u.findProjectRoot(startDir);
    if (!root) {
      throw new MemoryError(
        'No project root found (looked for .specify, package.json, or .git). ' +
          'Run `speckit-memory init` first, or pass --root.'
      );
    }
    return new MemoryStore(root);
  }

  get cache() {
    if (!this._cache) this._cache = new MemoryCache(this.cacheDir);
    return this._cache;
  }

  isInitialized() {
    return (
      fs.existsSync(this.memoryDocRoot) &&
      fs.existsSync(this.historyRoot) &&
      fs.existsSync(this.specsRoot)
    );
  }

  relative(p) {
    return path.relative(this.rootDir, p).split(path.sep).join('/');
  }

  // -- init ----------------------------------------------------------------

  init() {
    const created = [];
    const mkDir = (p) => {
      if (!fs.existsSync(p)) {
        u.ensureDir(p);
        created.push(`${this.relative(p)}/`);
      }
    };
    mkDir(this.memoryDocRoot);
    mkDir(this.lawRoot);
    mkDir(this.historyRoot);
    for (const cat of Object.keys(HISTORY_CATEGORIES)) {
      mkDir(path.join(this.historyRoot, cat));
    }
    mkDir(this.specsRoot);
    mkDir(this.cacheDir);

    const touch = (p) => {
      if (!u.fileExists(p)) fs.writeFileSync(p, '');
    };
    touch(path.join(this.lawRoot, '.gitkeep'));
    for (const cat of Object.keys(HISTORY_CATEGORIES)) {
      touch(path.join(this.historyRoot, cat, '.gitkeep'));
    }

    const wroteReadme =
      this._writeIfAbsent(path.join(this.memoryDocRoot, 'README.md'), TEMPLATES.lawReadme) |
      this._writeIfAbsent(path.join(this.historyRoot, 'README.md'), TEMPLATES.historyReadme) |
      this._writeIfAbsent(path.join(this.specsRoot, 'README.md'), TEMPLATES.specsReadme);
    this._ensureGitignore();
    return { rootDir: this.rootDir, created, wroteReadme: Boolean(wroteReadme) };
  }

  _writeIfAbsent(p, text) {
    if (u.fileExists(p)) return false;
    u.writeTextFileAtomic(p, text);
    return true;
  }

  _ensureGitignore() {
    const gi = path.join(this.rootDir, '.gitignore');
    const marker = '.speckit-memory/';
    if (u.fileExists(gi)) {
      const text = u.readTextFile(gi);
      const present = text
        .split(/\r?\n/)
        .some((l) => l.trim() === marker || l.trim() === '.speckit-memory');
      if (!present) {
        fs.appendFileSync(
          gi,
          `${text.endsWith('\n') ? '' : '\n'}\n# speckit-memory derived index cache\n${marker}\n`
        );
      }
    } else {
      u.writeTextFileAtomic(gi, `# speckit-memory derived index cache\n${marker}\n`);
    }
  }

  // -- add -----------------------------------------------------------------

  /**
   * Add a memory entry.
   * law:     { type:'law', content, title?, tags? }
   * history: { type:'history', content, title?, category?, feature?, tags? }
   * feature: { type:'feature', content, title?, feature (required), kind?, }
   */
  add(input) {
    const type = input.type;
    if (!TYPES.includes(type)) {
      throw new MemoryError(
        `Unknown memory type "${type}" (expected law | history | feature)`
      );
    }
    let body = input.content == null ? null : String(input.content).trim();
    if (input.contentFile) {
      if (body != null && body !== '') {
        throw new MemoryError('Pass either content or contentFile, not both');
      }
      const contentPath = path.resolve(input.contentFile);
      try {
        body = u.readTextFile(contentPath).trim();
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          throw new MemoryError(`Content file not found: ${contentPath}`);
        }
        throw new MemoryError(`Cannot read content file ${contentPath}: ${err.message}`);
      }
    }
    if (!body) throw new MemoryError('Memory content is empty');

    if (type === TYPE_LAW) return this._addLaw(body, input);
    if (type === TYPE_HISTORY) return this._addHistory(body, input);
    return this._addFeature(body, input);
  }

  _addLaw(body, { title, tags, mcpType, metadata }) {
    const t = title && String(title).trim() ? String(title).trim() : u.deriveTitle(body);
    const id = u.nextSequentialId(
      'LAW',
      this._lawEntries().map((e) => e.id)
    );
    const now = u.nowIso();
    const file = path.join(this.lawRoot, `${id}-${u.slugify(t)}.md`);
    const fm = {
      id,
      type: TYPE_LAW,
      title: t,
      created: now,
      updated: now,
      tags: normalizeTags(tags),
      immutable: true,
    };
    attachEntryMetadata(fm, mcpType, metadata);
    u.writeMarkdownFile(file, fm, `# ${id}: ${t}\n\n${body}\n`);
    return this._entryFromLawFile(file);
  }

  _addHistory(body, { title, category, feature, tags, mcpType, metadata }) {
    const cat = normalizeHistoryCategory(category || 'worklogs');
    const t = title && String(title).trim() ? String(title).trim() : u.deriveTitle(body);
    const prefix = HISTORY_CATEGORIES[cat].idPrefix;
    const id = u.nextSequentialId(
      prefix,
      this._historyEntries()
        .filter((e) => e.category === cat)
        .map((e) => e.id)
    );
    const now = u.nowIso();
    const dir = u.ensureDir(path.join(this.historyRoot, cat));
    const file = u.uniquePath(path.join(dir, `${u.todayIso()}-${u.slugify(t)}.md`));
    const fm = {
      id,
      type: TYPE_HISTORY,
      category: cat,
      title: t,
      created: now,
      updated: now,
      tags: normalizeTags(tags),
    };
    if (feature) fm.feature = u.slugify(feature);
    attachEntryMetadata(fm, mcpType, metadata);
    u.writeMarkdownFile(file, fm, `# ${id}: ${t}\n\n${body}\n`);
    return this._entryFromHistoryFile(file);
  }

  _addFeature(body, { title, feature, kind, tags, mcpType, metadata }) {
    if (!feature || !String(feature).trim()) {
      throw new MemoryError('Feature memory requires a feature name (--feature)');
    }
    const k = normalizeFeatureKind(kind || 'watchpoint');
    const def = FEATURE_KINDS[k];
    const featureSlug = u.slugify(feature);
    const t = title && String(title).trim() ? String(title).trim() : u.deriveTitle(body);
    const dir = u.ensureDir(path.join(this.specsRoot, featureSlug));
    const file = path.join(dir, def.file);

    let doc;
    if (u.fileExists(file)) {
      doc = u.readMarkdownFile(file);
    } else {
      doc = {
        frontmatter: { feature: featureSlug, kind: def.label, updated: u.nowIso() },
        body: `# ${featureSlug} - ${def.label}\n`,
      };
    }
    const id = this._nextFeatureId(def.idPrefix, k, featureSlug);
    const entryBlock = `## ${id}: ${t} (${u.todayIso()})\n\n${body}`;
    const fm = {
      ...doc.frontmatter,
      feature: featureSlug,
      kind: def.label,
      updated: u.nowIso(),
    };
    attachEntryMetadata(fm, mcpType, metadata, id);
    if (Array.isArray(tags) && tags.length) fm[`${id}tags`] = normalizeTags(tags);
    u.writeMarkdownFile(
      file,
      fm,
      `${doc.body.replace(/\s+$/, '')}\n\n${entryBlock}\n`
    );
    const parsed = this._parseFeatureFile(file, featureSlug, k);
    const entry = parsed.find((e) => e.id === id);
    if (!entry) {
      throw new MemoryError(`Failed to read back feature entry ${id} from ${file}`);
    }
    return entry;
  }

  // -- scan ----------------------------------------------------------------

  /**
   * Scan all three trees, rebuild the index cache, return every entry.
   * The filesystem is always the source of truth; the cache is derived.
   */
  scan() {
    const entries = [
      ...this._lawEntries(),
      ...this._historyEntries(),
      ...this._featureEntries(),
    ];
    this.cache.replaceAll(entries);
    return entries;
  }

  _lawEntries() {
    return u
      .listMarkdownFiles(this.lawRoot)
      .map((f) => {
        try {
          return this._entryFromLawFile(f);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  }

  _entryFromLawFile(file) {
    const { frontmatter: fm, body } = u.readMarkdownFile(file);
    const base = path.basename(file, '.md');
    const idMatch = /^([A-Z]+-\d+)-/.exec(base);
    const id = String(fm.id || (idMatch && idMatch[1]) || base);
    const title = String(
      fm.title || body.replace(/^#\s*[^\n]*\n?/, '').trim().split('\n')[0] || id
    );
    const created = isoOrFileTime(fm.created, file);
    const updated = isoOrFileTime(fm.updated, file);
    const content = stripHeading(body, id);
    return {
      id,
      ...entryMetadata(fm),
      type: TYPE_LAW,
      category: null,
      feature: fm.feature ? String(fm.feature) : null,
      title,
      filePath: this.relative(file),
      created,
      updated,
      tags: normalizeTags(fm.tags),
      content,
      status: null,
      hash: u.sha256Hex(content),
      wordCount: u.countWords(content),
    };
  }

  _historyEntries() {
    return u
      .listMarkdownFiles(this.historyRoot)
      .map((f) => {
        try {
          return this._entryFromHistoryFile(f);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  }

  _entryFromHistoryFile(file) {
    const { frontmatter: fm, body } = u.readMarkdownFile(file);
    const rel = this.relative(file);
    const parts = rel.split('/');
    // docs/memory/<category>/file.md — category from path, then frontmatter
    let cat = parts.length >= 3 ? parts[parts.length - 2] : null;
    if (!HISTORY_CATEGORIES[cat]) cat = normalizeHistoryCategory(fm.category || 'worklogs');
    const base = path.basename(file, '.md');
    const idMatch = /^([A-Z]+-\d+)-/.exec(base);
    const id = String(fm.id || (idMatch && idMatch[1]) || base);
    const title = String(
      fm.title || body.replace(/^#\s*[^\n]*\n?/, '').trim().split('\n')[0] || id
    );
    const created = isoOrFileTime(fm.created, file);
    const updated = isoOrFileTime(fm.updated, file);
    const content = stripHeading(body, id);
    return {
      id,
      ...entryMetadata(fm),
      type: TYPE_HISTORY,
      category: cat,
      feature: fm.feature ? String(fm.feature) : null,
      title,
      filePath: rel,
      created,
      updated,
      tags: normalizeTags(fm.tags),
      content,
      status: null,
      hash: u.sha256Hex(content),
      wordCount: u.countWords(content),
    };
  }

  _featureEntries() {
    const out = [];
    for (const dir of u.listChildDirs(this.specsRoot)) {
      const featureSlug = path.basename(dir);
      for (const kindKey of Object.keys(FEATURE_KINDS)) {
        const file = path.join(dir, FEATURE_KINDS[kindKey].file);
        if (u.fileExists(file)) out.push(...this._parseFeatureFile(file, featureSlug, kindKey));
      }
    }
    return out;
  }

  _parseFeatureFile(file, featureSlug, kindKey) {
    const def = FEATURE_KINDS[kindKey];
    const { frontmatter: fm, body } = u.readMarkdownFile(file);
    const slug = String(fm.feature || featureSlug);
    const chunks = body.split(/^## /m).slice(1);
    const out = [];
    for (const chunk of chunks) {
      const nl = chunk.indexOf('\n');
      const head = (nl === -1 ? chunk : chunk.slice(0, nl)).trim();
      const content = (nl === -1 ? '' : chunk.slice(nl + 1)).trim();
      const hm = /^((?:WP|OQ)-(?:[A-Z0-9-]+-)?\d{4,}):\s*(.*)$/.exec(head);
      if (!hm) continue;
      const id = hm[1];
      let title = hm[2].trim();
      let date = null;
      const dm = /\s*\((\d{4}-\d{2}-\d{2})\)\s*$/.exec(title);
      if (dm) {
        date = dm[1];
        title = title.slice(0, dm.index).trim();
      }
      const resolved = RESOLVED_MARKER_RE.test(content);
      out.push({
        id,
        ...entryMetadata(fm, id),
        type: TYPE_FEATURE,
        category: kindKey,
        feature: slug,
        title: title || id,
        filePath: this.relative(file),
        created: date || String(fm.updated || '').slice(0, 10) || null,
        updated: date || (fm.updated ? String(fm.updated) : null),
        tags: normalizeTags(fm[`${id}tags`]),
        content,
        status: resolved ? 'resolved' : 'open',
        hash: u.sha256Hex(content),
        wordCount: u.countWords(content),
      });
    }
    return out;
  }

  _nextFeatureId(prefix, kindKey, featureSlug) {
    let max = 0;
    for (const entry of this._featureEntries()) {
      if (entry.category !== kindKey) continue;
      const match = /-(\d+)$/.exec(entry.id);
      if (match) max = Math.max(max, Number(match[1]));
    }
    const featurePrefix = u.slugify(featureSlug).toUpperCase();
    return `${prefix}-${featurePrefix}-${String(max + 1).padStart(4, '0')}`;
  }

  _featureEntryIds(body) {
    const ids = [];
    const re = /^## ((?:WP|OQ)-(?:[A-Z0-9-]+-)?\d{4,}):/gm;
    let m;
    while ((m = re.exec(body)) !== null) ids.push(m[1]);
    return ids;
  }

  // -- query / mutate ------------------------------------------------------

  /**
   * List entries (scans the filesystem first so the cache stays warm).
   * filter: {type, category, feature, tag, status}
   */
  list(filter = {}) {
    const entries = this.scan();
    const featureSlug = filter.feature ? u.slugify(filter.feature) : null;
    const filtered = entries.filter(
      (e) =>
        (!filter.type || e.type === filter.type) &&
        (!filter.category || e.category === filter.category) &&
        (!featureSlug || e.feature === featureSlug) &&
        (!filter.tag || (e.tags || []).includes(filter.tag)) &&
        (!filter.status || e.status === filter.status)
    );
    const typeOrder = { law: 0, history: 1, feature: 2 };
    return filtered.sort(
      (a, b) =>
        (typeOrder[a.type] - typeOrder[b.type]) ||
        String(a.id).localeCompare(String(b.id))
    );
  }

  get(id) {
    return this.scan().find((e) => e.id === id) || null;
  }

  /**
   * Update an entry (content/title/tags). Laws are immutable.
   * patch.status === 'resolved' appends a resolution marker (feature entries).
   */
  update(id, patch = {}) {
    const entry = this.get(id);
    if (!entry) throw new MemoryError(`No entry with id ${id}`);
    if (entry.type === TYPE_LAW) throw new ImmutableLawError(id);
    const now = u.nowIso();
    const abs = path.join(this.rootDir, entry.filePath);

    if (entry.type === TYPE_HISTORY) {
      const doc = u.readMarkdownFile(abs);
      const fm = { ...doc.frontmatter, id: entry.id, type: TYPE_HISTORY, updated: now };
      if (patch.title) fm.title = patch.title;
      if (patch.tags) fm.tags = normalizeTags(patch.tags);
      let bodyContent = entry.content;
      if (patch.content != null) bodyContent = String(patch.content).trim();
      if (patch.status === 'resolved') {
        if (!RESOLVED_MARKER_RE.test(bodyContent)) {
          bodyContent += `\n\n**[RESOLVED ${u.todayIso()}]**`;
        }
      }
      u.writeMarkdownFile(abs, fm, `# ${entry.id}: ${fm.title}\n\n${bodyContent}\n`);
      return this.get(id);
    }

    // feature entry: rewrite one "## ID: ..." block inside the feature file
    this._rewriteFeatureFile(abs, (head, content) => {
      let newHead = head;
      if (patch.title) {
        const hm = /^((?:WP|OQ)-(?:[A-Z0-9-]+-)?\d{4,}):\s*(.*)$/.exec(head);
        if (hm) {
          const dm = /\s*\((\d{4}-\d{2}-\d{2})\)\s*$/.exec(hm[2]);
          newHead = `${hm[1]}: ${patch.title}${dm ? ` (${dm[1]})` : ''}`;
        }
      }
      let newContent = patch.content != null ? String(patch.content).trim() : content;
      if (patch.status === 'resolved' && !RESOLVED_MARKER_RE.test(newContent)) {
        newContent += `\n\n**[RESOLVED ${u.todayIso()}]**`;
      }
      return { head: newHead, content: newContent };
    }, entry.id);
    return this.get(id);
  }

  /** Mark a feature open-question / watchpoint as resolved. */
  resolve(id) {
    return this.update(id, { status: 'resolved' });
  }

  /** Remove an entry. Laws are immutable and cannot be removed. */
  remove(id) {
    const entry = this.get(id);
    if (!entry) throw new MemoryError(`No entry with id ${id}`);
    if (entry.type === TYPE_LAW) throw new ImmutableLawError(id);
    const abs = path.join(this.rootDir, entry.filePath);
    if (entry.type === TYPE_HISTORY) {
      fs.unlinkSync(abs);
    } else {
      this._rewriteFeatureFile(abs, null, entry.id); // null replacer + dropId
      const doc = u.readMarkdownFile(abs);
      if (this._featureEntryIds(doc.body).length === 0) fs.unlinkSync(abs);
    }
    this.scan();
    return { removed: id };
  }

  /**
   * Rewrite entries of a feature file. replacer(head, content) -> {head,
   * content}; when replacer is null, the entry whose id equals dropId is
   * removed. The file frontmatter `updated` stamp is bumped either way.
   */
  _rewriteFeatureFile(file, replacer, dropId) {
    const doc = u.readMarkdownFile(file);
    const chunks = doc.body.split(/^## /m);
    const out = [chunks[0].replace(/\s+$/, '')].filter((s) => s !== '');
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i];
      const nl = chunk.indexOf('\n');
      const head = (nl === -1 ? chunk : chunk.slice(0, nl)).trim();
      const content = (nl === -1 ? '' : chunk.slice(nl + 1)).trim();
      const hm = /^((?:WP|OQ)-(?:[A-Z0-9-]+-)?\d{4,}):/.exec(head);
      const isTarget = hm && hm[1] === dropId;
      if (isTarget && replacer === null) continue; // drop
      if (isTarget && replacer) {
        const r = replacer(head, content);
        out.push(`## ${r.head}\n\n${r.content}`);
      } else {
        out.push(`## ${chunk.replace(/\s+$/, '')}`);
      }
    }
    const fm = { ...doc.frontmatter, updated: u.nowIso() };
    if (dropId && replacer === null) {
      delete fm[`${dropId}mcp_type`];
      delete fm[`${dropId}metadata`];
      delete fm[`${dropId}tags`];
    }
    u.writeMarkdownFile(file, fm, `${out.join('\n\n')}\n`);
  }

  /**
   * Write the synthesized feature memory document (specs/<feature>/memory.md).
   * Returns {file, document, wordCount, frontmatter}.
   */
  writeSynthesis(feature, body, meta = {}) {
    const featureSlug = u.slugify(feature);
    const dir = u.ensureDir(path.join(this.specsRoot, featureSlug));
    const file = path.join(dir, 'memory.md');
    const fm = {
      feature: featureSlug,
      kind: 'synthesis',
      generated: u.nowIso(),
      word_count: u.countWords(body),
      ...meta,
    };
    const document = u.toMarkdownDocument(fm, body);
    u.writeTextFileAtomic(file, document);
    return { file, filePath: this.relative(file), document, wordCount: fm.word_count, frontmatter: fm };
  }

  close() {
    if (this._cache) this._cache.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function attachEntryMetadata(fm, mcpType, metadata, id = '') {
  if (mcpType) fm[`${id}mcp_type`] = String(mcpType);
  if (metadata !== undefined) fm[`${id}metadata`] = JSON.stringify(metadata);
}

function entryMetadata(fm, id = '') {
  const rawType = fm[`${id}mcp_type`];
  const rawMetadata = fm[`${id}metadata`];
  let metadata;
  if (rawMetadata !== undefined && rawMetadata !== null && rawMetadata !== '') {
    try { metadata = typeof rawMetadata === 'string' ? JSON.parse(rawMetadata) : rawMetadata; }
    catch (_) { metadata = undefined; }
  }
  return {
    mcpType: rawType ? String(rawType) : null,
    metadata,
  };
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => String(t).trim().toLowerCase())
    .filter(Boolean);
}

function normalizeHistoryCategory(input) {
  const key = String(input || '').trim().toLowerCase();
  if (HISTORY_CATEGORIES[key]) return key;
  const aliased = HISTORY_CATEGORY_ALIASES[key];
  if (aliased) return aliased;
  throw new MemoryError(
    `Unknown history category "${input}" (expected decisions | worklogs | bug-preventions)`
  );
}

function normalizeFeatureKind(input) {
  const key = String(input || '').trim().toLowerCase();
  if (FEATURE_KINDS[key]) return key;
  const aliased = FEATURE_KIND_ALIASES[key];
  if (aliased) return aliased;
  throw new MemoryError(
    `Unknown feature kind "${input}" (expected watchpoint | open-question)`
  );
}

function isoOrFileTime(value, file) {
  if (value) return String(value);
  try {
    return new Date(fs.statSync(file).mtime).toISOString();
  } catch (_) {
    return null;
  }
}

/** Strip the leading "# ID: ..." heading from a stored body. */
function stripHeading(body, id) {
  const re = new RegExp(`^#\\s+${id}[^\\n]*\\n+`);
  return String(body || '').replace(re, '').trim();
}

// ---------------------------------------------------------------------------
// README templates written by init()
// ---------------------------------------------------------------------------

const TEMPLATES = {
  lawReadme: `# Governance Law (.specify/memory/)

Immutable principles and rules for this project. Every entry lives in
\`laws/LAW-####-slug.md\` with YAML frontmatter and is **append-only**:
once written, a law is never edited or deleted.

Add a law:

    speckit-memory add law "Never store plaintext private keys" --tag security

Laws are included (as a digest) in every feature synthesis.
`,

  historyReadme: `# Project History (docs/memory/)

Long-term memory of the project, split into three categories:

- \`decisions/\`         — DEC-####, architectural and design decisions
- \`worklogs/\`          — LOG-####, session logs and progress notes
- \`bug-preventions/\`   — BUG-####, lessons and regressions to never repeat

Add entries:

    speckit-memory add history "Chose argon2id for password hashing" --category decision
    speckit-memory add history "Session log: shipped auth refactor" --category worklog
    speckit-memory add history "Off-by-one in payout loop (fixed)" --category bug-prevention
`,

  specsReadme: `# Feature Memory (specs/<feature>/)

Per-feature working memory:

- \`watchpoints.md\`     — WP-<FEATURE>-####, risks and things to watch while building
- \`open-questions.md\`  — OQ-<FEATURE>-####, unresolved questions
- \`memory.md\`          — generated ~900-word synthesis (do not edit by hand)

Add entries and synthesize:

    speckit-memory add feature "Token expiry drifts under load" --feature auth --kind watchpoint
    speckit-memory add feature "Which redirect flow for mobile?" --feature auth --kind open-question
    speckit-memory synthesize auth
`,
};

module.exports = {
  MemoryStore,
  MemoryCache,
  MemoryError,
  ImmutableLawError,
  TYPES,
  HISTORY_CATEGORIES,
  FEATURE_KINDS,
  HISTORY_CATEGORY_ALIASES,
  FEATURE_KIND_ALIASES,
  CACHE_SCHEMA_VERSION,
  normalizeHistoryCategory,
  normalizeFeatureKind,
  normalizeTags,
};

