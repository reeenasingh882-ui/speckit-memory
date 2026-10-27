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
const fsUtils = require('./fs-utils');
const cli = require('./cli');

module.exports = {
  MemoryStore: store.MemoryStore,
  MemoryCache: store.MemoryCache,
  MemoryError: store.MemoryError,
  ImmutableLawError: store.ImmutableLawError,
  TYPES: store.TYPES,
  HISTORY_CATEGORIES: store.HISTORY_CATEGORIES,
  FEATURE_KINDS: store.FEATURE_KINDS,
  CACHE_SCHEMA_VERSION: store.CACHE_SCHEMA_VERSION,
  synthesize: syn.synthesize,
  DEFAULT_TARGET_WORDS: syn.DEFAULT_TARGET_WORDS,
  DEFAULT_TOLERANCE: syn.DEFAULT_TOLERANCE,
  fsUtils,
  cli,
};
