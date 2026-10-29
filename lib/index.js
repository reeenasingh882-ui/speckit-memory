'use strict';

/**
 * Programmatic API for speckit-memory.
 *
 *   const { MemoryStore, synthesize } = require('speckit-memory/lib');
 *   const store = MemoryStore.open(process.cwd());
 *   store.init();
 *   store.add({ type: 'law', content: '...' });
 *   const entries = store.list({ type: 'law' });
 *   const doc = synthesize(store, 'auth');
 *
 * The MCP server consumes lib/engine.js (same store, MCP-shaped methods).
 */

const store = require('./memory-store');
const syn = require('./synthesizer');
const engine = require('./engine');
const fsUtils = require('./fs-utils');
const cli = require('./cli');

// NOTE on naming: two different cache classes exist in this package.
//   - memory-store.js "MemoryCache"  -> the per-store index cache
//     (SQLite `index.db`, schema keyed on (id, feature)); exported here.
//   - sqlite-cache.js "MemoryCache"  -> the standalone search/feature cache
//     used by synthesis-engine.js; not exported here.
// They share a name for historical reasons but have different schemas.

module.exports = {
  MemoryStore: store.MemoryStore,
  // Index cache (memory-store.js). See the note above.
  MemoryCache: store.MemoryCache,
  MemoryError: store.MemoryError,
  ImmutableLawError: store.ImmutableLawError,
  TYPES: store.TYPES,
  HISTORY_CATEGORIES: store.HISTORY_CATEGORIES,
  FEATURE_KINDS: store.FEATURE_KINDS,
  CACHE_SCHEMA_VERSION: store.CACHE_SCHEMA_VERSION,
  synthesize: syn.synthesize,
  synthesizeFeature: engine.synthesizeFeature,
  DEFAULT_TARGET_WORDS: syn.DEFAULT_TARGET_WORDS,
  DEFAULT_TOLERANCE: syn.DEFAULT_TOLERANCE,
  fsUtils,
  cli,
};
