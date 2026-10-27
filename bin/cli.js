#!/usr/bin/env node
/*
 * speckit-memory CLI bootstrap.
 *
 * `mcp-start` is routed directly to the MCP stdio server (mcp-server.js).
 * Every other command is handled by the full CLI in lib/cli.js, which
 * exports main(argv) and returns an exit code (0/1/2, or null while a
 * long-running command owns the process). The exit code is propagated.
 */
'use strict';

const cmd = (process.argv[2] || '').toLowerCase();

if (cmd === 'mcp-start' || cmd === 'mcp') {
  require('../mcp-server.js').startMcpServer();
} else {
  let handled = false;
  try {
    const cli = require('../lib/cli.js');
    if (typeof cli === 'function') {
      process.exitCode = cli(process.argv.slice(2)) || 0;
      handled = true;
    } else if (cli && typeof cli.main === 'function') {
      const code = cli.main(process.argv.slice(2));
      if (code !== null && code !== undefined) process.exitCode = code;
      handled = true;
    }
  } catch (err) {
    if (!(err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes('lib/cli.js'))) throw err;
  }
  if (!handled) {
    process.stdout.write([
      'speckit-memory — persistent memory for spec-driven development',
      '',
      'Usage:',
      '  speckit-memory mcp-start    Start the MCP server (JSON-RPC 2.0 over stdio)',
      '',
      'Full CLI commands are provided by lib/cli.js when installed.',
      '',
    ].join('\n'));
    process.exitCode = cmd ? 1 : 0;
  }
}
