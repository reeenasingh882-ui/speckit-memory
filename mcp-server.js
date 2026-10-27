#!/usr/bin/env node
/*
 * speckit-memory — MCP server (Model Context Protocol, stdio transport).
 *
 * Speaks JSON-RPC 2.0, one message per line (newline-delimited UTF-8) on
 * stdin/stdout, following MCP protocol revision 2025-06-18.
 *
 * Handshake:
 *   client -> initialize                 (request)
 *   server -> { protocolVersion, capabilities, serverInfo, instructions }
 *   client -> notifications/initialized  (notification, no response)
 *   client -> ping / tools/list / tools/call
 *
 * Start:
 *   npx speckit-memory mcp-start   (bin/cli.js routes here)
 *   node mcp-server.js             (direct)
 *
 * Programmatic:
 *   const { startMcpServer } = require('./mcp-server');
 *
 * Engine resolution (first match wins):
 *   1. SPECKIT_MEMORY_ENGINE env var — path to an engine module
 *   2. ./lib/engine.js               — canonical engine
 *   3. ./lib/memory-engine.js        — alternate module name
 *   4. ./lib/fallback-engine.js      — built-in file-backed store (always present)
 *
 * Storage: the canonical engine and the CLI share the same MemoryStore trees.
 * SPECKIT_MEMORY_ROOT selects the project root. SPECKIT_MEMORY_PATH accepts a
 * project directory or a legacy .json/.db path whose parent is the project root.
 * The SQLite index under .speckit-memory/ is derived and rebuildable.
 *
 * Engine interface (every method may be async):
 *   addMemory({ type, content, feature?, tags?, metadata? }) -> record with `id`
 *   listMemories({ type?, feature?, limit? })                -> record[] (newest first)
 *   searchMemories({ query, limit? })                        -> record[] (best match first)
 *   synthesize({ feature }) -> { feature, words, markdown } | string
 *   MEMORY_TYPES (optional string[]) — restricts `type` in the memory_add schema
 *
 * Diagnostics go to stderr only — stdout is reserved for the protocol.
 */
'use strict';

const readline = require('readline');
const path = require('path');

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function packageInfo() {
  try {
    const pkg = require('./package.json');
    return { name: pkg.name || 'speckit-memory', version: pkg.version || '1.0.0' };
  } catch (_) {
    return { name: 'speckit-memory', version: '1.0.0' };
  }
}

function log(...parts) {
  process.stderr.write(`${parts.join(' ')}\n`);
}

function loadModule(spec) {
  try {
    return require(spec);
  } catch (err) {
    // Degrade to the next engine candidate instead of dying: covers a missing
    // module, a missing optional native backend (e.g. node:sqlite on Node < 22.5),
    // and genuinely broken engine modules (those are logged loudly below).
    const missing =
      err.code === 'MODULE_NOT_FOUND' ||
      err.code === 'ERR_MODULE_NOT_FOUND' ||
      err.code === 'ERR_UNKNOWN_BUILTIN_MODULE';
    if (!missing) {
      log(`[speckit-memory] warning: engine candidate ${spec} failed to load: ${(err && err.message) || err}`);
    }
    return undefined;
  }
}

/* Accepts a canonical engine module, tolerating method-name aliases. */
function adaptEngine(raw, label) {
  const mod = raw && raw.default ? raw.default : raw;
  if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) return null;
  const pick = (...names) => {
    for (const n of names) {
      if (typeof mod[n] === 'function') return mod[n].bind(mod);
    }
    return null;
  };
  const addMemory = pick('addMemory', 'add');
  const listMemories = pick('listMemories', 'list');
  const searchMemories = pick('searchMemories', 'search');
  const synthesize = pick('synthesize');
  if (!addMemory || !listMemories || !searchMemories || !synthesize) return null;
  const memoryTypes = Array.isArray(mod.MEMORY_TYPES) ? mod.MEMORY_TYPES.map(String) : null;
  return { label, MEMORY_TYPES: memoryTypes, addMemory, listMemories, searchMemories, synthesize };
}

function resolveEngine() {
  const candidates = [];
  const envSpec = process.env.SPECKIT_MEMORY_ENGINE;
  if (envSpec) candidates.push(envSpec, path.resolve(envSpec));
  candidates.push('./lib/engine.js', './lib/memory-engine.js');
  for (const spec of candidates) {
    const adapted = adaptEngine(loadModule(spec), spec);
    if (adapted) return adapted;
  }
  const fallbackModule = require('./lib/fallback-engine.js');
  const fallback = adaptEngine(fallbackModule, './lib/fallback-engine.js (built-in)');
  if (!fallback) throw new Error('Failed to initialize the built-in fallback engine.');
  log(`[speckit-memory] notice: no loadable engine module found — using the built-in fallback engine.`);
  log(`[speckit-memory] notice: memories go to ${fallbackModule.STORE_PATH}, NOT the MemoryStore project trees. Restore the canonical engine to resume shared CLI/MCP storage.`);
  return fallback;
}

function startMcpServer(options = {}) {
  const engine = options.engine || resolveEngine();
  const serverInfo = options.serverInfo || packageInfo();
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const { createMcpHandler } = require('./lib/mcp-handlers');

  const handler = createMcpHandler({
    engine,
    serverInfo,
    protocolVersion: PROTOCOL_VERSION,
    supportedVersions: new Set(SUPPORTED_VERSIONS),
  });

  let closing = false;
  let negotiatedVersion = null;
  const write = (message) => {
    if (closing) return;
    stdout.write(`${JSON.stringify(message)}\n`);
  };

  const internalError = (message, id) => ({
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    error: { code: -32603, message: `Internal error: ${(message && message.message) || String(message)}` },
  });

  const dispatch = (message) => {
    Promise.resolve()
      .then(() => handler.handleMessage(message))
      .then(
        (response) => {
          if (response && response.result && response.result.protocolVersion) {
            negotiatedVersion = response.result.protocolVersion;
          }
          if (response) write(response);
        },
        (err) => {
          const id = message && typeof message === 'object' && !Array.isArray(message) && 'id' in message
            ? message.id : null;
          write(internalError(err, id));
        }
      );
  };

  const rl = readline.createInterface({ input: stdin, terminal: false, crlfDelay: Infinity });

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: line is not valid JSON' } });
      return;
    }
    if (Array.isArray(parsed)) {
      // Batching was removed in MCP 2025-06-18; keep it only for older negotiated clients.
      if (negotiatedVersion === null || negotiatedVersion === PROTOCOL_VERSION) {
        write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: batching is not supported by the negotiated MCP version' } });
        return;
      }
      if (parsed.length === 0) {
        write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: empty batch' } });
        return;
      }
      Promise.all(parsed.map((element) =>
        Promise.resolve()
          .then(() => handler.handleMessage(element))
          .then((response) => response || null)
          .catch((err) => {
            const id = element && typeof element === 'object' && !Array.isArray(element) && 'id' in element
              ? element.id : null;
            return internalError(err, id);
          })
      )).then((responses) => {
        const nonEmpty = responses.filter(Boolean);
        if (nonEmpty.length) write(nonEmpty);
      });
      return;
    }
    dispatch(parsed);
  });

  const close = () => {
    if (closing) return;
    closing = true;
    try { rl.close(); } catch (_) { /* already closed */ }
  };

  rl.on('close', () => {
    close();
    process.exitCode = 0;
  });
  process.once('SIGINT', close);
  process.once('SIGTERM', close);

  log(`[speckit-memory] MCP server ready (protocol ${PROTOCOL_VERSION})`);
  log(`[speckit-memory] engine: ${engine.label || 'unknown'}`);

  return { engine, protocolVersion: PROTOCOL_VERSION, close };
}

if (require.main === module) {
  try {
    startMcpServer();
  } catch (err) {
    log(`[speckit-memory] fatal: ${(err && err.stack) || err}`);
    process.exitCode = 1;
  }
}

module.exports = { startMcpServer, resolveEngine, PROTOCOL_VERSION, SUPPORTED_VERSIONS };
