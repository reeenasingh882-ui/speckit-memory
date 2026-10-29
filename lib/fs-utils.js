'use strict';

/**
 * Filesystem utilities for speckit-memory.
 *
 * Zero dependencies. Provides:
 *   - project-root discovery
 *   - markdown read/write with a YAML frontmatter subset (scalars, arrays)
 *   - atomic file writes
 *   - id/slug/date/hash helpers
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT_MARKERS = ['.specify', 'package.json', '.git'];

// ---------------------------------------------------------------------------
// Generic fs helpers
// ---------------------------------------------------------------------------

function findProjectRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (;;) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function fileExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch (_) {
    return false;
  }
}

function readTextFile(p) {
  return fs.readFileSync(p, 'utf8');
}

function writeTextFileAtomic(p, text) {
  const tmp = path.join(
    path.dirname(p),
    `.${path.basename(p)}.tmp-${process.pid}-${Date.now()}`
  );
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, p);
}

/**
 * Recursively list *.md files under `dir`, skipping README.md and dotfiles.
 */
function listMarkdownFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name === 'README.md' || ent.name.startsWith('.')) continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.endsWith('.md')) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

function listChildDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(dir, e.name))
    .sort();
}

// ---------------------------------------------------------------------------
// YAML frontmatter subset
//
// Supported: `key: scalar`, `key: [a, b]`, and block arrays:
//   key:
//     - a
//     - b
// Scalars: strings (optionally quoted), numbers, booleans, null.
// Nested objects are intentionally not supported.
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function unquote(s) {
  if (
    s.length >= 2 &&
    ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function parseScalar(s) {
  const v = String(s).trim();
  // Quoted scalars are always strings: `"1.10"` must round-trip as the text
  // "1.10", never as the number 1.1.
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const parsed = JSON.parse(v);
      return typeof parsed === 'string' ? parsed : v.slice(1, -1);
    } catch (_) {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~' || v === '') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

function parseFrontmatterText(text) {
  const fm = {};
  // Strip a UTF-8 BOM up front: Windows editors save one and it would
  // otherwise break the /^---/ match, leaking frontmatter into the body.
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  const m = FRONTMATTER_RE.exec(src);
  if (!m) return { frontmatter: fm, body: src };
  const body = src.slice(m[0].length);
  let currentKey = null;
  for (const rawLine of m[1].split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, '  ');
    if (line.trim() === '') continue;
    if (/^\s+-\s+/.test(line)) {
      if (currentKey) {
        if (!Array.isArray(fm[currentKey])) fm[currentKey] = [];
        fm[currentKey].push(parseScalar(line.replace(/^\s+-\s+/, '')));
      }
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const rest = kv[2].trim();
    currentKey = key;
    if (rest === '') {
      fm[key] = null; // may become a block array on the following lines
      continue;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      fm[key] =
        inner === '' ? [] : inner.split(',').map((s) => parseScalar(s));
    } else {
      fm[key] = parseScalar(rest);
    }
  }
  return { frontmatter: fm, body };
}

function needsQuoting(s) {
  return (
    s === '' ||
    /^[\s]|[\\\s]$/.test(s) ||
    /[:#{}[\],&*!|>'"%@`\n\r]/.test(s) ||
    // Keep numeric-looking strings ("1.10", "007") quoted so a read/write
    // round-trip cannot coerce them into numbers (1.1, 7).
    /^-?\d+(\.\d+)?$/.test(s) ||
    /^(true|false|null|~)$/i.test(s)
  );
}

function formatScalar(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  return needsQuoting(s) ? JSON.stringify(s) : s;
}

function stringifyFrontmatterText(fm) {
  const lines = [];
  for (const [key, value] of Object.entries(fm || {})) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${formatScalar(item)}`);
    } else {
      lines.push(`${key}: ${formatScalar(value)}`);
    }
  }
  return lines.join('\n');
}

function readMarkdownFile(filePath) {
  const raw = readTextFile(filePath);
  const { frontmatter, body } = parseFrontmatterText(raw);
  return {
    path: filePath,
    raw,
    frontmatter,
    body: body.replace(/^\s+/, ''),
  };
}

function toMarkdownDocument(frontmatter, body) {
  return (
    `---\n${stringifyFrontmatterText(frontmatter)}\n---\n\n` +
    `${String(body == null ? '' : body).replace(/\s+$/, '')}\n`
  );
}

function writeMarkdownFile(filePath, frontmatter, body) {
  writeTextFileAtomic(filePath, toMarkdownDocument(frontmatter, body));
  return filePath;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function slugify(text, maxLength = 60) {
  const s = String(text == null ? '' : text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return s || 'entry';
}

function nowIso() {
  return new Date().toISOString();
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function countWords(text) {
  return String(text == null ? '' : text)
    .split(/\s+/)
    .filter(Boolean).length;
}

function firstSentences(text, maxChars = 240) {
  const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastStop = Math.max(
    cut.lastIndexOf('. '),
    cut.lastIndexOf('! '),
    cut.lastIndexOf('? '),
    cut.lastIndexOf('.')
  );
  return (lastStop > 60 ? cut.slice(0, lastStop + 1) : cut).trim() + ' [...]';
}

function nextSequentialId(prefix, existingIds) {
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const id of existingIds || []) {
    const m = re.exec(String(id || ''));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}

function uniquePath(p) {
  if (!fileExists(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!fileExists(candidate)) return candidate;
  }
  throw new Error(`Could not find a unique path near ${p}`);
}

function deriveTitle(body) {
  const line =
    String(body || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && !/^---/.test(s)) || 'untitled';
  const stripped = line.replace(/^#+\s*/, '').replace(/[*_`>]/g, '');
  const words = stripped.split(/\s+/).slice(0, 12).join(' ');
  return words.length > 80 ? `${words.slice(0, 77)}...` : words;
}

module.exports = {
  PROJECT_ROOT_MARKERS,
  findProjectRoot,
  ensureDir,
  fileExists,
  readTextFile,
  writeTextFileAtomic,
  listMarkdownFiles,
  listChildDirs,
  parseFrontmatterText,
  stringifyFrontmatterText,
  readMarkdownFile,
  toMarkdownDocument,
  writeMarkdownFile,
  slugify,
  nowIso,
  todayIso,
  sha256Hex,
  countWords,
  firstSentences,
  nextSequentialId,
  uniquePath,
  deriveTitle,
};

