'use strict';

/**
 * Deterministic 900-word feature memory synthesizer.
 *
 * Reads all memory trees through a MemoryStore and assembles
 * specs/<feature>/memory.md — a bounded, honest synthesis:
 *
 *   - watchpoints and open questions get the largest share of the budget
 *   - project history is ranked by relevance to the feature, then recency
 *   - governance laws are included as one-line digests
 *   - anything trimmed for budget is listed by id in Synthesis Notes
 *   - nothing is invented: every sentence comes from a stored entry
 *
 * The engine is offline and deterministic — no LLM calls, no network.
 */

const u = require('./fs-utils');

const DEFAULT_TARGET_WORDS = 900;
const DEFAULT_TOLERANCE = 60;

// Fraction of the target word budget per section (fixed parts: snapshot +
// notes take the remainder, roughly 15%).
const SECTION_SPLIT = {
  watchpoints: 0.33,
  openQuestions: 0.18,
  history: 0.23,
  laws: 0.11,
};

function byIdAsc(a, b) {
  return String(a.id).localeCompare(String(b.id));
}

function tokenizeFeature(feature) {
  const slug = u.slugify(feature);
  const tokens = new Set([
    slug,
    slug.replace(/-/g, ' '),
    ...slug.split('-').filter((t) => t.length >= 3),
  ]);
  return { slug, tokens };
}

function relevanceScore(entry, slug, tokens) {
  let score = 0;
  if (entry.feature === slug) score += 4;
  const title = String(entry.title || '').toLowerCase();
  const content = String(entry.content || '').toLowerCase();
  for (const tag of entry.tags || []) {
    if (tokens.has(String(tag).toLowerCase())) {
      score += 2;
      break;
    }
  }
  for (const tok of tokens) {
    if (title.includes(tok)) {
      score += 2;
      break;
    }
  }
  for (const tok of tokens) {
    if (content.includes(tok)) {
      score += 1;
      break;
    }
  }
  return score;
}

function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
}

function trimToWords(text, maxWords) {
  const sentences = splitSentences(text);
  const out = [];
  let count = 0;
  for (const s of sentences) {
    const w = u.countWords(s);
    if (count + w > maxWords && out.length > 0) break;
    out.push(s);
    count += w;
  }
  return out.join(' ');
}

function renderEntryFull(e) {
  const date = e.created ? ` (${e.created})` : '';
  const resolved = e.status === 'resolved' ? ' *(resolved)*' : '';
  return `### ${e.id}: ${e.title}${date}${resolved}\n\n${e.content}`;
}

function renderLawDigest(e) {
  return `### ${e.id}: ${e.title}\n\n${u.firstSentences(e.content, 200)}`;
}

/**
 * Fit entries into a word budget. Entries are consumed in priority order
 * (caller-sorted). The first entry that does not fit is trimmed if there is
 * room for at least MIN_PARTIAL_WORDS; everything after it is excluded.
 */
function fillSection(entries, budget, opts = {}) {
  const MIN_PARTIAL_WORDS = 40;
  const included = [];
  const excluded = [];
  let used = 0;
  let overflowed = false;

  for (const e of entries) {
    if (overflowed) {
      excluded.push({ id: e.id, words: e.wordCount || u.countWords(e.content) });
      continue;
    }
    const text = opts.digest ? renderLawDigest(e) : renderEntryFull(e);
    const w = u.countWords(text);
    const remaining = budget - used;
    if (w <= remaining) {
      included.push(text);
      used += w;
      continue;
    }
    if (!opts.digest && remaining >= MIN_PARTIAL_WORDS) {
      const trimmed = trimToWords(text, remaining - 6);
      included.push(
        `${trimmed}\n\n[...entry ${e.id} trimmed to fit the word budget]`
      );
      used += u.countWords(trimmed) + 8;
      excluded.push({ id: e.id, partial: true });
    } else {
      excluded.push({ id: e.id, words: w });
    }
    overflowed = true;
  }

  const markdown =
    included.length > 0 ? included.join('\n\n') : '_None recorded._';
  return { markdown, words: u.countWords(markdown), included, excluded };
}

function redistributeSplit(split, present) {
  const keys = Object.keys(split);
  const active = keys.filter((k) => present[k]);
  if (active.length === 0) return;
  const total = keys.reduce((s, k) => s + split[k], 0);
  const activeSum = active.reduce((s, k) => s + split[k], 0);
  for (const k of active) split[k] = (split[k] * total) / activeSum;
  for (const k of keys) if (!present[k]) split[k] = 0;
}

function buildContentSections(src, split, targetWords) {
  const budgets = {
    watchpoints: Math.round(targetWords * split.watchpoints),
    openQuestions: Math.round(targetWords * split.openQuestions),
    history: Math.round(targetWords * split.history),
    laws: Math.round(targetWords * split.laws),
  };
  const watchpoints = fillSection(src.watchpoints, budgets.watchpoints);
  const openQuestions = fillSection(src.openQuestions, budgets.openQuestions);
  const history = fillSection(src.history, budgets.history);
  const laws = fillSection(src.laws, budgets.laws, { digest: true });
  const sections = { watchpoints, openQuestions, history, laws };
  const excludedBySection = {};
  let excludedWords = 0;
  for (const [name, sec] of Object.entries(sections)) {
    const words = sec.excluded.reduce(
      (s, x) => s + (x.words || u.countWords(x.id)),
      0
    );
    excludedBySection[name] = sec.excluded;
    excludedWords += words;
  }
  let largestExcludedSection = null;
  let best = 0;
  for (const [name, sec] of Object.entries(sections)) {
    const words = sec.excluded.reduce(
      (s, x) => s + (x.words || u.countWords(x.id)),
      0
    );
    if (words > best) {
      best = words;
      largestExcludedSection = name;
    }
  }
  return { sections, excludedBySection, excludedWords, largestExcludedSection };
}

function describeExcluded(excluded) {
  if (!excluded || excluded.length === 0) return 'none';
  const shown = excluded.slice(0, 12).map((x) => (x.partial ? `${x.id} (partial)` : x.id));
  const more = excluded.length > shown.length ? `, +${excluded.length - shown.length} more` : '';
  return shown.join(', ') + more;
}

/**
 * Synthesize the ~900-word feature memory.
 *
 * options:
 *   targetWords  number   word target (default 900)
 *   tolerance    number   accepted deviation (default 60)
 *   write        boolean  write specs/<feature>/memory.md (default true)
 *
 * Returns { feature, targetWords, tolerance, wordCount, body, document,
 *           file, filePath, sources, excludedBySection }
 */
function synthesize(store, feature, options = {}) {
  if (!feature || !String(feature).trim()) {
    const err = new Error('synthesize: "feature" must be a non-empty string.');
    err.domain = true;
    throw err;
  }
  const write = options.write !== false;
  const targetWords = Math.max(
    100,
    Math.round(Number(options.targetWords) || DEFAULT_TARGET_WORDS)
  );
  const tolerance = Math.round(options.tolerance || DEFAULT_TOLERANCE);
  const { slug, tokens } = tokenizeFeature(feature);

  const all = store.scan();
  const laws = all.filter((e) => e.type === 'law').sort(byIdAsc);
  const historyScored = all
    .filter((e) => e.type === 'history')
    .map((e) => ({ e, score: relevanceScore(e, slug, tokens) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(b.e.created || '').localeCompare(String(a.e.created || ''))
    );
  const history = historyScored.map((x) => x.e);
  const relevantCount = historyScored.filter((x) => x.score > 0).length;
  const featureEntries = all.filter(
    (e) => e.type === 'feature' && e.feature === slug
  );
  const watchpoints = featureEntries
    .filter((e) => e.category === 'watchpoint' && e.status !== 'resolved')
    .sort(byIdAsc);
  const openQuestions = featureEntries
    .filter((e) => e.category === 'open-question' && e.status !== 'resolved')
    .sort(byIdAsc);

  // Fixed overhead (H1 + section headings + snapshot + notes) is reserved up
  // front so the content sections converge on the remaining budget.
  const fixedReserve = Math.round(targetWords * 0.2);
  const contentTarget = Math.max(120, targetWords - fixedReserve);

  const split = { ...SECTION_SPLIT };
  redistributeSplit(split, {
    watchpoints: watchpoints.length > 0,
    openQuestions: openQuestions.length > 0,
    history: history.length > 0,
    laws: laws.length > 0,
  });

  const src = { watchpoints, openQuestions, history, laws };
  const contentWordsOf = (b) =>
    Object.values(b.sections).reduce((s, x) => s + x.words, 0);
  let built = buildContentSections(src, split, targetWords);
  for (let attempt = 0; attempt < 8; attempt++) {
    const contentWords = contentWordsOf(built);
    if (contentWords > contentTarget + tolerance) {
      // Over budget: shrink digest-heavy sections first.
      if (split.history > 0) split.history *= 0.7;
      if (split.laws > 0) split.laws *= 0.7;
      split.watchpoints *= 0.95;
      split.openQuestions *= 0.95;
    } else if (contentWords < contentTarget - tolerance && built.excludedWords > 0) {
      // Under budget with material left out: grow the neediest section.
      const key = built.largestExcludedSection;
      if (!key || split[key] === undefined) break;
      split[key] *= 1.35;
    } else {
      break;
    }
    built = buildContentSections(src, split, targetWords);
  }

  const assemble = (b) => {
    const sec = b.sections;
    const includedCounts = {
      watchpoints: `${sec.watchpoints.included.length}/${watchpoints.length}`,
      openQuestions: `${sec.openQuestions.included.length}/${openQuestions.length}`,
      history: `${sec.history.included.length}/${history.length}`,
      laws: `${sec.laws.included.length}/${laws.length}`,
    };
    const emptySections = Object.entries(b.sections)
      .filter(([, s]) => s.included.length === 0)
      .map(([name]) => name);

    const lines = [];
    lines.push(options.heading || `# Feature Memory: ${slug}`);
    lines.push('');
    lines.push('## Snapshot');
    lines.push('');
    lines.push(
      `Generated ${u.nowIso()} for feature "${slug}". Word target: ${targetWords} ` +
        `(+/- ${tolerance}). Sources: ${laws.length} governance laws, ` +
        `${history.length} history entries (${relevantCount} feature-relevant), ` +
        `${watchpoints.length} active watchpoints, ${openQuestions.length} open questions. ` +
        'This document is a deterministic synthesis of stored memories; it invents nothing. ' +
        `Regenerate with: speckit-memory synthesize ${slug}.`
    );
    lines.push('');
    lines.push('## Active Watchpoints');
    lines.push('');
    lines.push(sec.watchpoints.markdown);
    lines.push('');
    lines.push('## Open Questions');
    lines.push('');
    lines.push(sec.openQuestions.markdown);
    lines.push('');
    lines.push('## Project History Context');
    lines.push('');
    lines.push(sec.history.markdown);
    lines.push('');
    lines.push('## Governance Law Digest');
    lines.push('');
    lines.push(sec.laws.markdown);
    lines.push('');
    lines.push('## Synthesis Notes');
    lines.push('');
    lines.push(`- Word budget: target ${targetWords} (+/- ${tolerance}); actual body ` +
      `is counted on regeneration (frontmatter word_count).`);
    lines.push(
      `- Included: watchpoints ${includedCounts.watchpoints}, open questions ` +
        `${includedCounts.openQuestions}, history ${includedCounts.history}, laws ${includedCounts.laws}.`
    );
    lines.push(
      `- Excluded for budget: watchpoints ${describeExcluded(b.excludedBySection.watchpoints)}; ` +
        `open questions ${describeExcluded(b.excludedBySection.openQuestions)}; ` +
        `history ${describeExcluded(b.excludedBySection.history)}; ` +
        `laws ${describeExcluded(b.excludedBySection.laws)}.`
    );
    lines.push(
      `- Sections with no data: ${emptySections.length ? emptySections.join(', ') : 'none'}.`
    );
    lines.push(
      '- Laws are immutable and always appear as digests; history is ranked by ' +
        'feature relevance then recency.'
    );
    return { body: lines.join('\n'), includedCounts, emptySections };
  };

  let assembled = assemble(built);
  if (u.countWords(assembled.body) > targetWords + tolerance) {
    // Final guard: scale every content budget proportionally and rebuild once.
    const scale = Math.max(0.2, contentTarget / Math.max(1, contentWordsOf(built)));
    for (const k of Object.keys(split)) split[k] *= scale;
    built = buildContentSections(src, split, targetWords);
    assembled = assemble(built);
  }
  const { body, includedCounts, emptySections } = assembled;

  const result = {
    feature: slug,
    targetWords,
    tolerance,
    wordCount: u.countWords(body),
    body,
    sources: {
      laws: laws.length,
      history: history.length,
      historyRelevant: relevantCount,
      watchpoints: watchpoints.length,
      openQuestions: openQuestions.length,
    },
    excludedBySection: built.excludedBySection,
  };

  if (write) {
    const written = store.writeSynthesis(slug, body, {
      target_words: targetWords,
      tolerance,
      laws_count: laws.length,
      history_count: history.length,
      watchpoints_count: watchpoints.length,
      open_questions_count: openQuestions.length,
    });
    result.file = written.file;
    result.filePath = written.filePath;
    result.document = written.document;
  }
  return result;
}

module.exports = {
  synthesize,
  DEFAULT_TARGET_WORDS,
  DEFAULT_TOLERANCE,
  tokenizeFeature,
  relevanceScore,
  fillSection,
  trimToWords,
};

