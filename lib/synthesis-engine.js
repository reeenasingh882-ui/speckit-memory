'use strict';
/**
 * synthesis-engine.js — deterministic extractive synthesis for speckit-memory.
 *
 * Compresses every memory of one feature into a single brief capped at
 * `maxWords` (default 900). The pipeline is fully local (no LLM calls):
 *
 *   1. collect   — all memory rows of the feature from MemoryCache
 *   2. bucket    — normalize memory types into canonical sections
 *   3. rank      — score each memory: type weight + recency + signal density
 *   4. extract   — score individual lines, keep the best per memory under a
 *                  per-memory word cap so one huge file cannot eat the budget
 *   5. allocate  — waterfall word budget: sections in priority order
 *                  (decisions > watchpoints > open questions > bug preventions
 *                   > notes), unused budget flows to the next section
 *   6. trim      — hard guarantee: total output (headers included) <= maxWords,
 *                  lowest-scoring bullets dropped first
 *   7. cache     — result stored in synthesis_cache; auto-invalidated by
 *                  MemoryCache whenever a memory of the feature changes
 *
 * Public API (class SynthesisEngine):
 *   new SynthesisEngine(cacheOrDbPath, { maxWords = 900, fts } = {})
 *   synthesize(feature, { refresh = false } = {})  -> brief object
 *   getSynthesis(feature)                          -> cached brief or null
 *   synthesizeToFile(feature, outPath, opts)       -> writes the markdown brief
 */

const fs = require('node:fs');
const path = require('node:path');
const { MemoryCache, countWords } = require('./sqlite-cache.js');

/* ------------------------------------------------------------- type system */

const TYPE_ALIASES = {
  decision: 'decision', decisions: 'decision', decide: 'decision', decided: 'decision',
  adr: 'decision', 'architecture-decision': 'decision',
  watchpoint: 'watchpoint', watchpoints: 'watchpoint', watch: 'watchpoint',
  gotcha: 'watchpoint', gotchas: 'watchpoint', warning: 'watchpoint',
  warnings: 'watchpoint', caution: 'watchpoint', risk: 'watchpoint', risks: 'watchpoint',
  open_question: 'open_question', 'open-question': 'open_question',
  'open-questions': 'open_question',
  openquestion: 'open_question', 'open-questions': 'open_question',
  question: 'open_question', questions: 'open_question', todo: 'open_question',
  bug_prevention: 'bug_prevention', 'bug-prevention': 'bug_prevention',
  'bug-preventions': 'bug_prevention',
  bugprevention: 'bug_prevention', bug: 'bug_prevention', bugs: 'bug_prevention',
  pitfall: 'bug_prevention', pitfalls: 'bug_prevention', incident: 'bug_prevention',
  lesson: 'bug_prevention', lessons: 'bug_prevention',
};

// Canonical sections in priority order (highest first).
const SECTION_ORDER = ['decision', 'watchpoint', 'open_question', 'bug_prevention', 'other'];
const SECTION_TITLES = {
  decision: 'Decisions',
  watchpoint: 'Watchpoints',
  open_question: 'Open Questions',
  bug_prevention: 'Bug Preventions',
  other: 'Notes',
};
// Baseline share of the word budget per section (renormalized over present sections).
const SECTION_BUDGET_SHARE = {
  decision: 0.30, watchpoint: 0.22, open_question: 0.18, bug_prevention: 0.14, other: 0.16,
};
const TYPE_WEIGHT = {
  decision: 100, watchpoint: 80, open_question: 70, bug_prevention: 60, other: 40,
};

function canonicalType(type) {
  const key = String(type || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (TYPE_ALIASES[key]) return TYPE_ALIASES[key];
  // Singularize a trailing plural and retry (covers ad-hoc filenames).
  const singular = key.endsWith('ies') ? key.slice(0, -3) + 'y'
    : key.endsWith('s') && !key.endsWith('ss') ? key.slice(0, -1)
    : null;
  if (singular && TYPE_ALIASES[singular]) return TYPE_ALIASES[singular];
  return 'other';
}

/* ------------------------------------------------------------ line scoring */

// Markers that usually carry the actual information in a memory line.
const SIGNAL_MARKER_RE =
  /\b(must|never|always|shall|required?|decision|decided|because|warning|caution|risk|critical|important|bug|fixme|hack|todo|blocked?|prevent|pitfall|gotcha|regression|breaking|deprecated|invariant|constraint|verify|assert)\b/i;
const CODE_TOKEN_RE = /`[^`]+`|[A-Za-z_][A-Za-z0-9_]*\(\)|\b[A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b|\b[a-z]+_[a-z_]+\b|\b0x[0-9a-fA-F]+\b|\d+(?:\.\d+)?\b/;
const URL_RE = /https?:\/\/\S+/;

function scoreLine(rawLine, sectionKey) {
  const line = String(rawLine || '').trim();
  if (!line) return -1;
  const words = line.split(/\s+/).length;

  let s = 0;
  // Markdown headings carry little on their own — only mild context value.
  if (/^#{1,6}\s/.test(line)) s -= 2;
  // Bullets and list items are pre-distilled facts.
  if (/^([-*+]|\d+\.)\s/.test(line)) s += 1;

  // Length sweet spot: 4–60 words.
  if (words >= 4 && words <= 60) s += 2;
  else if (words < 3) s -= 2;
  else s -= 1; // very long run-on lines

  // Signal markers (capped so one keyword-stuffed line cannot dominate).
  const markers = line.match(new RegExp(SIGNAL_MARKER_RE.source, 'gi'));
  if (markers) s += Math.min(3, markers.length * 1.2);

  // Concrete artifacts: identifiers, numbers, code spans.
  const code = line.match(new RegExp(CODE_TOKEN_RE.source, 'g'));
  if (code) s += Math.min(3, code.length * 0.6);

  // Noise penalties.
  if (URL_RE.test(line) && words < 12) s -= 1;
  if (/^(\||[-+]\s*[-+]|!|\||>{3,})/.test(line)) s -= 2; // table rules / diffs / quotes
  if (/^(-{3,}|={3,}|_{3,})$/.test(line)) return -1;     // horizontal rules

  // Section-specific boosts.
  if (sectionKey === 'open_question' && /\?\s*$/.test(line)) s += 1.5;
  if (sectionKey === 'decision' && /\b(we|team|use|adopt|choose|standardi[sz]e[d]?)\b/i.test(line)) s += 0.8;
  if (sectionKey === 'watchpoint' && /\b(when|if|before|after|until|unless)\b/i.test(line)) s += 0.8;
  if (sectionKey === 'bug_prevention' && /\b(caused|fix|regression|prevent(ed)?)\b/i.test(line)) s += 0.8;

  return s;
}

function normalizeForDedup(line) {
  return String(line).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function stripListMarker(line) {
  return String(line).replace(/^([-*+]|\d+\.)\s+/, '').replace(/^#{1,6}\s+/, '').trim();
}

/* -------------------------------------------------------------- main class */

class SynthesisEngine {
  constructor(cacheOrDbPath, opts = {}) {
    if (cacheOrDbPath instanceof MemoryCache) {
      this.cache = cacheOrDbPath;
    } else {
      this.cache = new MemoryCache(cacheOrDbPath || MemoryCache.defaultPath(), opts);
    }
    this.maxWords = Number(opts.maxWords) > 0 ? Number(opts.maxWords) : 900;
  }

  /**
   * Cached fresh brief when available, otherwise (re)generate.
   * Returns {
   *   feature, content, wordCount, maxWords, memoryCount, sectionCounts,
   *   cached, truncatedBullets, generatedAt
   * }
   */
  synthesize(feature, { refresh = false } = {}) {
    const f = String(feature);
    if (!refresh) {
      const cached = this.getSynthesis(f);
      if (cached) return cached;
    }

    const memories = this.cache.getByFeature(f);
    const built = this._compress(memories, f);
    this.cache.setCachedSynthesis(f, built.content, built.wordCount);

    return {
      feature: f,
      content: built.content,
      wordCount: built.wordCount,
      maxWords: this.maxWords,
      memoryCount: memories.length,
      sectionCounts: built.sectionCounts,
      cached: false,
      truncatedBullets: built.truncatedBullets,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Fresh cached brief or null (stale/missing caches are treated as absent). */
  getSynthesis(feature) {
    if (this.cache.isSynthesisStale(feature)) return null;
    const row = this.cache.getCachedSynthesis(feature);
    if (!row) return null;
    return {
      feature: row.feature,
      content: row.content,
      wordCount: row.word_count,
      maxWords: this.maxWords,
      cached: true,
      generatedAt: row.created_at,
    };
  }

  synthesizeToFile(feature, outPath, opts = {}) {
    const brief = this.synthesize(feature, opts);
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, brief.content.endsWith('\n') ? brief.content : brief.content + '\n');
    return brief;
  }

  close() { this.cache.close(); }

  /* ----------------------------------------------------------- internals */

  /** Score a memory row: type weight + recency + signal density. */
  _scoreMemory(row, oldestTs, newestTs) {
    const type = canonicalType(row.type);
    let score = TYPE_WEIGHT[type];
    const ts = Date.parse(row.updated_at) || 0;
    const span = Math.max(1, newestTs - oldestTs);
    score += 20 * ((ts - oldestTs) / span); // 0..20 recency
    const words = Math.max(1, countWords(row.content));
    const signals = (row.content.match(new RegExp(SIGNAL_MARKER_RE.source, 'gi')) || []).length;
    score += Math.min(10, (signals / words) * 400); // 0..10 density
    return score;
  }

  /**
   * Pick the highest-value lines of one memory, capped at `capWords` words.
   * Selected lines keep their original reading order.
   */
  _extractLines(row, sectionKey, capWords) {
    const rawLines = String(row.content || '').split(/\r?\n/);
    const scored = [];
    rawLines.forEach((line, idx) => {
      const cleaned = stripListMarker(line);
      const parts = cleaned.split(/\s+/).filter(Boolean);
      const segmentSize = Math.max(12, Math.min(40, Math.floor(capWords)));
      for (let start = 0; start < parts.length; start += segmentSize) {
        const text = parts.slice(start, start + segmentSize).join(' ');
        const s = scoreLine(text, sectionKey);
        if (s > 0) scored.push({ text, score: s, idx: idx + start / 1000000 });
      }
    });
    scored.sort((a, b) => b.score - a.score || a.idx - b.idx);

    const picked = [];
    let words = 0;
    for (const cand of scored) {
      const w = countWords(cand.text);
      if (w === 0) continue;
      if (words + w > capWords && picked.length > 0) continue; // keep scanning for a shorter gem
      if (words + w > capWords * 1.4) break;                   // nothing small enough ahead
      picked.push(cand);
      words += w;
      if (words >= capWords) break;
    }
    picked.sort((a, b) => a.idx - b.idx); // restore reading order
    return picked;
  }

  _compress(memories, feature) {
    const maxWords = this.maxWords;

    if (!memories.length) {
      const content = `# Feature synthesis: ${feature}\n\nNo memories indexed for this feature yet.\n`;
      return { content, wordCount: countWords(content), sectionCounts: {}, truncatedBullets: 0 };
    }

    // 1) bucket + 2) rank
    const tsList = memories.map((m) => Date.parse(m.updated_at) || 0);
    const oldestTs = Math.min(...tsList);
    const newestTs = Math.max(...tsList);
    const buckets = new Map();
    for (const row of memories) {
      const key = canonicalType(row.type);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({ row, score: this._scoreMemory(row, oldestTs, newestTs) });
    }
    for (const list of buckets.values()) list.sort((a, b) => b.score - a.score);

    const presentKeys = SECTION_ORDER.filter((k) => buckets.has(k));
    const shareSum = presentKeys.reduce((a, k) => a + SECTION_BUDGET_SHARE[k], 0) || 1;

    // Fixed markdown overhead: title, generated line, section headers.
    const overhead = 12 + presentKeys.reduce((a, k) => a + countWords(SECTION_TITLES[k]) + 1, 0);
    const usable = Math.max(60, maxWords - overhead);

    // Per-memory cap: no single file may dominate.
    const perMem = Math.min(60, Math.max(12, Math.floor(usable / Math.min(memories.length, 40))));

    // 4) extract candidates per section (memory order = score order)
    const sections = presentKeys.map((key) => {
      const bullets = [];
      for (const { row, score } of buckets.get(key)) {
        const seen = new Set();
        for (const line of this._extractLines(row, key, perMem)) {
          const norm = normalizeForDedup(line.text);
          if (!norm || seen.has(norm)) continue;
          seen.add(norm);
          const source = path.basename(row.path || '');
          const text = line.text.replace(/\s+/g, ' ').trim();
          bullets.push({
            text, source,
            // Combined priority: line signal first, memory importance breaks ties.
            rank: line.score + score / 1000,
          });
        }
      }
      return { key, title: SECTION_TITLES[key], bullets };
    });

    // 5) waterfall budget across sections in priority order
    let remaining = usable;
    const chosen = sections.map((sec, i) => {
      const isLast = i === sections.length - 1;
      const share = SECTION_BUDGET_SHARE[sec.key] / shareSum;
      let budget = isLast ? remaining : Math.min(remaining, Math.round(usable * share));
      const picked = [];
      let words = 0;
      for (const b of sec.bullets) {
        const w = countWords(b.text) + (b.source ? countWords(`(${b.source})`) : 0);
        if (words + w > budget && picked.length > 0) break;
        if (words + w > budget) continue;
        picked.push(b);
        words += w;
      }
      remaining -= words;
      return { ...sec, picked, words };
    });

    // 6) assemble + hard trim (headers included in the cap)
    const assemble = (sectionsToUse) => {
      const counts = {};
      const parts = [`# Feature synthesis: ${feature}`, ''];
      const typeNote = presentKeys
        .map((k) => `${buckets.get(k).length} ${SECTION_TITLES[k].toLowerCase()}`)
        .join(', ');
      // The date stamp is metadata only; the synthesis body itself is
      // deterministic (same memories in, same content out).
      parts.push(`_Synthesized from ${memories.length} memories (${typeNote}) — ${new Date().toISOString().slice(0, 10)}._`);
      parts.push('');
      for (const sec of sectionsToUse) {
        if (!sec.picked.length) continue;
        counts[sec.key] = sec.picked.length;
        parts.push(`## ${sec.title}`);
        for (const b of sec.picked) {
          parts.push(b.source ? `- ${b.text} (${b.source})` : `- ${b.text}`);
        }
        parts.push('');
      }
      // Trim trailing blank lines, keep exactly one final newline.
      while (parts.length && parts[parts.length - 1] === '') parts.pop();
      return { content: parts.join('\n') + '\n', counts };
    };

    let { content, counts } = assemble(chosen);
    let truncatedBullets = 0;

    // Drop the globally lowest-ranked bullets until the whole document fits.
    let guard = 0;
    while (countWords(content) > maxWords && guard++ < 5000) {
      // Candidate sections that can lose a bullet (keep >= 1 when possible).
      const donors = chosen.filter((s) => s.picked.length > 0)
        .sort((a, b) => a.key.localeCompare(b.key)); // stable order
      if (!donors.length) break;
      // Find the single lowest-ranked bullet across all sections.
      let target = null;
      for (const sec of donors) {
        for (let i = 0; i < sec.picked.length; i++) {
          const b = sec.picked[i];
          if (!target || b.rank < target.b.rank ||
              (b.rank === target.b.rank && sec.key === 'other')) {
            target = { sec, i, b };
          }
        }
      }
      target.sec.picked.splice(target.i, 1);
      truncatedBullets++;
      ({ content, counts } = assemble(chosen));
    }

    return { content, wordCount: countWords(content), sectionCounts: counts, truncatedBullets };
  }
}

module.exports = {
  SynthesisEngine,
  canonicalType,
  SECTION_ORDER,
  SECTION_TITLES,
};
