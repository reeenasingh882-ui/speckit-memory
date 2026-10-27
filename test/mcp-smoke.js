/*
 * Smoke test for the speckit-memory MCP server.
 *
 * Spawns `node mcp-server.js` and drives a full client session over stdio:
 *   initialize -> notifications/initialized -> ping -> tools/list -> tools/call
 * for every tool, plus error-path checks (parse error, invalid request,
 * method not found, invalid params, pre-initialize request, persistence).
 *
 * Exit code 0 = all checks green. Run: node test/mcp-smoke.js  (or npm test)
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let nextId = 0;
const newId = () => ++nextId;

function startServer(storePath) {
  const child = spawn(process.execPath, ['mcp-server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { SPECKIT_MEMORY_PATH: storePath }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        responses.push(JSON.parse(line));
      } catch (_) {
        responses.push({ __parseError: true, raw: line });
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => process.stderr.write(`[server] ${c}`));
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const sendRaw = (text) => child.stdin.write(`${text}\n`);
  const waitFor = (predicate, timeoutMs = 10000) => new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      const hit = responses.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - startedAt > timeoutMs) return reject(new Error('timeout waiting for response'));
      return setTimeout(tick, 20);
    };
    tick();
  });
  const stop = () => { try { child.stdin.end(); } catch (_) { /* already closed */ } };
  return { child, responses, send, sendRaw, waitFor, stop };
}

async function main() {
  const results = [];
  const expect = (name, cond, detail) => {
    results.push({ name, ok: !!cond, detail: detail || '' });
    if (!cond) process.stderr.write(`FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speckit-mcp-smoke-'));
  const storePath = path.join(tmpDir, 'store.json');

  /* ---------- session 1: full happy path + error paths ---------- */
  const s1 = startServer(storePath);

  const initId = newId();
  s1.send({
    jsonrpc: '2.0', id: initId, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-test', version: '0.0.0' } },
  });
  const init = await s1.waitFor((m) => m.id === initId);
  expect('initialize: responds with protocolVersion 2025-06-18', init.result && init.result.protocolVersion === '2025-06-18');
  expect('initialize: serverInfo.name = speckit-memory', init.result && init.result.serverInfo && init.result.serverInfo.name === 'speckit-memory');
  expect('initialize: advertises tools capability', !!(init.result && init.result.capabilities && init.result.capabilities.tools));

  const before = s1.responses.length;
  s1.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await sleep(150);
  expect('notifications/initialized: no response (notification)', s1.responses.length === before);

  const pingId = newId();
  s1.send({ jsonrpc: '2.0', id: pingId, method: 'ping' });
  const ping = await s1.waitFor((m) => m.id === pingId);
  expect('ping: empty result {}', ping.result && Object.keys(ping.result).length === 0);

  const listId = newId();
  s1.send({ jsonrpc: '2.0', id: listId, method: 'tools/list' });
  const list = await s1.waitFor((m) => m.id === listId);
  const toolNames = list.result && list.result.tools ? list.result.tools.map((t) => t.name).sort() : [];
  expect('tools/list: exactly 4 tools', toolNames.length === 4, toolNames.join(','));
  expect('tools/list: memory_add, memory_list, memory_search, memory_synthesize present',
    ['memory_add', 'memory_list', 'memory_search', 'memory_synthesize'].every((n) => toolNames.includes(n)));
  expect('tools/list: every tool has description + JSON Schema inputSchema',
    list.result.tools.every((t) => typeof t.description === 'string' && t.description.length > 40
      && t.inputSchema && t.inputSchema.type === 'object'));

  const requestNotificationStart = s1.responses.length;
  s1.send({ jsonrpc: '2.0', method: 'ping' });
  s1.send({ jsonrpc: '2.0', method: 'tools/list' });
  await sleep(200);
  expect('request methods sent as notifications: no response', s1.responses.length === requestNotificationStart);

  const call = async (name, args) => {
    const cid = newId();
    s1.send({ jsonrpc: '2.0', id: cid, method: 'tools/call', params: { name, arguments: args } });
    return s1.waitFor((m) => m.id === cid);
  };
  const text = (resp) => (resp.result && resp.result.content && resp.result.content[0] && resp.result.content[0].text) || '';

  let r = await call('memory_add', { type: 'decision', content: 'Use JSON-RPC 2.0 over stdio as the MCP transport.', feature: 'mcp-server', tags: ['transport', 'protocol'] });
  expect('memory_add: stored, isError=false', r.result && r.result.isError === false && text(r).includes('Stored memory'), JSON.stringify(r).slice(0, 200));

  r = await call('memory_add', { type: 'pattern', content: 'Persist user preferences immediately when the user states them.', feature: 'mcp-server' });
  expect('memory_add (second): store holds 2', text(r).includes('2 memories'));

  r = await call('memory_list', { feature: 'mcp-server' });
  expect('memory_list: 2 memories, contains first record content', text(r).includes('2 memories') && text(r).includes('JSON-RPC 2.0 over stdio'));

  r = await call('memory_search', { query: 'transport stdio' });
  expect('memory_search: ranks the transport decision first', !r.result.isError && text(r).includes('JSON-RPC 2.0 over stdio'));

  r = await call('memory_search', { query: 'zzz-no-such-keyword' });
  expect('memory_search: clean miss is not an error', r.result && r.result.isError === false && text(r).includes('No memories match'));

  r = await call('memory_search', { query: '"' });
  expect('memory_search: punctuation-only query is a clean miss', r.result && r.result.isError === false && !r.error);

  r = await call('memory_synthesize', { feature: 'mcp-server' });
  expect('memory_synthesize: markdown synthesis with word count', r.result && r.result.isError === false
    && text(r).includes('# Feature synthesis') && /words\)/.test(text(r)));

  r = await call('memory_synthesize', { feature: 'does-not-exist' });
  expect('memory_synthesize: unknown feature -> isError=true with guidance', r.result && r.result.isError === true
    && text(r).toLowerCase().includes('no memories found'));

  /* ---------- error paths ---------- */
  r = await call('memory_search', {});
  expect('tools/call missing required arg -> -32602', r.error && r.error.code === -32602);

  r = await call('memory_add', { type: 'decision', content: '   ' });
  expect('tools/call blank content -> -32602', r.error && r.error.code === -32602);

  r = await call('memory_add', { type: 'decision', content: 'valid content', unexpected: true });
  expect('tools/call additional property -> -32602', r.error && r.error.code === -32602);

  r = await call('memory_add', { type: 'not-in-enum', content: 'invalid type' });
  expect('tools/call type outside enum -> -32602', r.error && r.error.code === -32602);

  r = await call('memory_list', { limit: 1001 });
  expect('tools/call limit above schema maximum -> -32602', r.error && r.error.code === -32602);

  r = await call('no_such_tool', {});
  expect('tools/call unknown tool -> -32602', r.error && r.error.code === -32602);

  const badMethodId = newId();
  s1.send({ jsonrpc: '2.0', id: badMethodId, method: 'resources/list' });
  r = await s1.waitFor((m) => m.id === badMethodId);
  expect('unknown method -> -32601', r.error && r.error.code === -32601);

  const badVersionId = newId();
  s1.send({ jsonrpc: '1.0', id: badVersionId, method: 'ping' });
  r = await s1.waitFor((m) => m.id === badVersionId);
  expect('wrong jsonrpc version -> -32600', r.error && r.error.code === -32600);

  const batchStart = s1.responses.length;
  s1.send([{ jsonrpc: '2.0', id: newId(), method: 'ping' }]);
  await sleep(200);
  const batchResponses = s1.responses.slice(batchStart);
  expect('MCP 2025-06-18 batch -> -32600', batchResponses.length === 1
    && batchResponses[0].error && batchResponses[0].error.code === -32600
    && /batching/.test(batchResponses[0].error.message));

  s1.sendRaw('{ this is not json');
  r = await s1.waitFor((m) => m.error && m.error.code === -32700);
  expect('malformed JSON line -> -32700', !!r);

  const notifyBefore = s1.responses.length;
  s1.send({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' });
  await sleep(150);
  expect('unknown notification: silently ignored', s1.responses.length === notifyBefore);

  expect('protocol hygiene: every stdout line is valid JSON', !s1.responses.some((m) => m.__parseError));
  s1.stop();
  await sleep(200);

  /* ---------- session 2: persistence across restart ---------- */
  const s2 = startServer(storePath);
  const i2 = newId();
  s2.send({ jsonrpc: '2.0', id: i2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-2', version: '0.0.0' } } });
  await s2.waitFor((m) => m.id === i2);
  s2.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const c2 = newId();
  s2.send({ jsonrpc: '2.0', id: c2, method: 'tools/call', params: { name: 'memory_list', arguments: {} } });
  r = await s2.waitFor((m) => m.id === c2);
  expect('persistence: memories survive server restart', text(r).includes('2 memories'));
  s2.stop();

  /* ---------- session 3: request before initialize ---------- */
  const s3 = startServer(path.join(tmpDir, 'store-b.json'));
  const earlyId = newId();
  s3.send({ jsonrpc: '2.0', id: earlyId, method: 'ping' });
  r = await s3.waitFor((m) => m.id === earlyId);
  expect('request before initialize -> -32002 (server not initialized)', r.error && r.error.code === -32002);
  const emptyInitId = newId();
  s3.send({ jsonrpc: '2.0', id: emptyInitId, method: 'initialize', params: {} });
  r = await s3.waitFor((m) => m.id === emptyInitId);
  expect('initialize with empty params -> -32602', r.error && r.error.code === -32602);
  const i3 = newId();
  s3.send({ jsonrpc: '2.0', id: i3, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-3', version: '0.0.0' } } });
  r = await s3.waitFor((m) => m.id === i3);
  expect('initialize after -32002 still succeeds', r.result && r.result.protocolVersion === '2025-06-18');
  s3.stop();

  /* ---------- summary ---------- */
  const passed = results.filter((x) => x.ok).length;
  for (const item of results) {
    process.stdout.write(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok || !item.detail ? '' : ` — ${item.detail}`}\n`);
  }
  process.stdout.write(`\n${passed}/${results.length} checks passed\n`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`smoke test crashed: ${(err && err.stack) || err}\n`);
  process.exitCode = 1;
});
