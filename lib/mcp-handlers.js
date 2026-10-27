/*
 * JSON-RPC 2.0 / MCP dispatch for speckit-memory.
 *
 * Transport-agnostic: createMcpHandler() returns an async handleMessage(msg)
 * that maps one parsed JSON-RPC message to a response object, or to null when
 * the message is a notification (which must never be answered). mcp-server.js
 * owns the stdio wiring; this module owns protocol semantics and the tool
 * surface.
 *
 * JSON-RPC error codes used:
 *   -32700 Parse error            (raised by the transport on bad JSON)
 *   -32600 Invalid Request        (not a JSON-RPC 2.0 request object)
 *   -32601 Method not found
 *   -32602 Invalid params         (bad tools/call arguments, unknown tool)
 *   -32603 Internal error         (unexpected engine failure)
 *   -32002 Server not initialized (MCP convention for pre-initialize requests)
 *
 * Domain-level tool failures (e.g. synthesizing a feature with no memories)
 * are reported as successful responses with `isError: true` content, per the
 * MCP tools/call semantics, so the AI client can read and recover.
 */
'use strict';

const ERROR_CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_NOT_INITIALIZED: -32002,
});

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

function buildTools(engine) {
  const typeSchema = engine && Array.isArray(engine.MEMORY_TYPES) && engine.MEMORY_TYPES.length
    ? {
        type: 'string',
        enum: engine.MEMORY_TYPES,
        description: `Memory category. Allowed values: ${engine.MEMORY_TYPES.join(', ')}.`,
      }
    : {
        type: 'string',
        description: 'Memory category (e.g. decision, pattern, rule, preference, context, lesson, insight). Any short label works; stay consistent within a project.',
      };

  return [
    {
      name: 'memory_add',
      description:
        'Persist a durable project memory. Call this whenever the user states a durable preference or constraint, an architectural or design decision is made, a recurring pattern is discovered, or a lesson/pitfall is learned. Memories survive across sessions and power later synthesis. Write content as a standalone statement: future readers will not have this conversation as context.',
      inputSchema: {
        type: 'object',
        properties: {
          type: typeSchema,
          content: {
            type: 'string',
            description: 'The memory itself, phrased so it can be understood without the surrounding conversation.',
          },
          feature: {
            type: 'string',
            description: 'Feature/spec area this memory belongs to (e.g. "auth", "payments"). Synthesis is produced per feature, so set this whenever the memory is feature-scoped.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional retrieval tags.',
          },
          metadata: {
            type: 'object',
            description: 'Optional JSON object with provenance or other structured context.',
          },
        },
        required: ['type', 'content'],
        additionalProperties: false,
      },
    },
    {
      name: 'memory_list',
      description:
        'List stored memories, newest first, optionally filtered by category (type) and/or feature. Use to review what the project already remembers before proposing new decisions.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Only return memories of this category.' },
          feature: { type: 'string', description: 'Only return memories for this feature.' },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 50, description: 'Maximum memories to return (default 50).' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'memory_synthesize',
      description:
        'Synthesize a ~900-word markdown brief for one feature from every stored memory belonging to it, grouped by category. Use at spec-drafting/planning time to ground the plan in accumulated decisions, patterns, rules and lessons.',
      inputSchema: {
        type: 'object',
        properties: {
          feature: {
            type: 'string',
            description: 'The feature to synthesize (must match the `feature` values used with memory_add).',
          },
        },
        required: ['feature'],
        additionalProperties: false,
      },
    },
    {
      name: 'memory_search',
      description:
        'Keyword search across all stored memories, ranked best-match first. Use before making decisions or writing specs to check for prior decisions, constraints and lessons that already exist.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Space-separated keywords. A memory matches when any keyword hits; more keyword hits rank higher.',
          },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Maximum results (default 20).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ];
}

function textResult(text, isError) {
  return { content: [{ type: 'text', text }], isError: Boolean(isError) };
}

function stringify(value) {
  return JSON.stringify(value, null, 2);
}

function requireNonEmptyString(args, key, tool) {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RpcError(ERROR_CODES.INVALID_PARAMS, `${tool}: "arguments.${key}" must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeLimit(args, max, tool) {
  if (args.limit === undefined) return undefined;
  if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1) {
    throw new RpcError(ERROR_CODES.INVALID_PARAMS, `${tool}: "arguments.limit" must be a positive integer.`);
  }
  return Math.min(args.limit, max);
}

function validateArguments(schema, args, tool) {
  const invalid = (message) => {
    throw new RpcError(ERROR_CODES.INVALID_PARAMS, `${tool}: ${message}`);
  };
  if (!schema) return;
  const properties = schema.properties || {};
  for (const key of schema.required || []) {
    if (args[key] === undefined) invalid(`missing required "arguments.${key}".`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        invalid(`"arguments.${key}" is not allowed.`);
      }
    }
  }
  const checkType = (value, spec, label) => {
    if (spec.type === 'string' && typeof value !== 'string') invalid(`"${label}" must be a string.`);
    if (spec.type === 'integer' && !Number.isInteger(value)) invalid(`"${label}" must be an integer.`);
    if (spec.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) invalid(`"${label}" must be a number.`);
    if (spec.type === 'boolean' && typeof value !== 'boolean') invalid(`"${label}" must be a boolean.`);
    if (spec.type === 'array' && !Array.isArray(value)) invalid(`"${label}" must be an array.`);
    if (spec.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) invalid(`"${label}" must be an object.`);
  };
  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (!spec) continue;
    checkType(value, spec, `arguments.${key}`);
    if (spec.enum && !spec.enum.includes(value)) invalid(`"arguments.${key}" must be one of: ${spec.enum.join(', ')}.`);
    if (typeof value === 'number') {
      if (spec.minimum !== undefined && value < spec.minimum) invalid(`"arguments.${key}" must be >= ${spec.minimum}.`);
      if (spec.maximum !== undefined && value > spec.maximum) invalid(`"arguments.${key}" must be <= ${spec.maximum}.`);
    }
    if (spec.type === 'array' && spec.items) {
      value.forEach((item, index) => checkType(item, spec.items, `arguments.${key}[${index}]`));
    }
  }
}

function createMcpHandler({ engine, serverInfo, protocolVersion = '2025-06-18', supportedVersions }) {
  let initialized = false;
  const tools = buildTools(engine);

  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  async function callTool(name, args) {
    switch (name) {
      case 'memory_add': {
        const type = requireNonEmptyString(args, 'type', name);
        const content = requireNonEmptyString(args, 'content', name);
        const payload = { type, content };
        if (args.feature !== undefined) payload.feature = requireNonEmptyString(args, 'feature', name);
        if (args.tags !== undefined) {
          if (!Array.isArray(args.tags)) {
            throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'memory_add: "arguments.tags" must be an array of strings.');
          }
          payload.tags = args.tags.map((t) => {
            if (typeof t !== 'string' || t.trim() === '') {
              throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'memory_add: "arguments.tags" items must be non-empty strings.');
            }
            return t.trim();
          });
        }
        if (args.metadata !== undefined) payload.metadata = args.metadata;
        const record = await engine.addMemory(payload);
        if (!record || typeof record !== 'object') {
          throw new Error('Engine addMemory() returned no record.');
        }
        const total = typeof record.totalCount === 'number'
          ? record.totalCount
          : (await engine.listMemories({})).length;
        const scope = payload.feature ? `, feature: ${payload.feature}` : '';
        return textResult(
          `Stored memory ${record.id !== undefined ? record.id : '(engine returned no id)'} (type: ${type}${scope}). Store now holds ${total} ${total === 1 ? 'memory' : 'memories'}.\n\n${stringify(record)}`
        );
      }

      case 'memory_list': {
        const filter = {};
        if (args.type !== undefined) filter.type = requireNonEmptyString(args, 'type', name);
        if (args.feature !== undefined) filter.feature = requireNonEmptyString(args, 'feature', name);
        const limit = normalizeLimit(args, 1000, name);
        filter.limit = limit !== undefined ? limit : 50;
        const records = await engine.listMemories(filter);
        if (!Array.isArray(records)) throw new Error('Engine listMemories() returned a non-array.');
        const desc = [filter.type && `type=${filter.type}`, filter.feature && `feature=${filter.feature}`].filter(Boolean).join(', ');
        const header = `${records.length} ${records.length === 1 ? 'memory' : 'memories'}${desc ? ` (${desc})` : ''}.`;
        if (!records.length) {
          return textResult(`${header} Nothing stored${desc ? ' for this filter' : ''} yet — capture knowledge with memory_add.`);
        }
        return textResult(`${header}\n\n${stringify(records)}`);
      }

      case 'memory_synthesize': {
        const feature = requireNonEmptyString(args, 'feature', name);
        const out = await engine.synthesize({ feature });
        let text = '';
        if (typeof out === 'string') text = out;
        else if (out && typeof out === 'object') {
          if (typeof out.markdown === 'string') text = out.markdown;
          else if (typeof out.text === 'string') text = out.text;
          else if (typeof out.synthesis === 'string') text = out.synthesis;
          else if (typeof out.content === 'string') text = out.content; // SynthesisEngine brief shape
          else text = stringify(out);
        }
        if (!text.trim()) text = `Engine produced an empty synthesis for feature "${feature}".`;
        const words = (text.match(/\S+/g) || []).length;
        return textResult(`${text}\n\n---\n(synthesis for "${feature}": ${words} words)`);
      }

      case 'memory_search': {
        const query = requireNonEmptyString(args, 'query', name);
        const limit = normalizeLimit(args, 100, name);
        const records = await engine.searchMemories({ query, limit: limit !== undefined ? limit : 20 });
        if (!Array.isArray(records)) throw new Error('Engine searchMemories() returned a non-array.');
        if (!records.length) return textResult(`No memories match "${query}".`);
        const label = records.length === 1 ? 'match' : 'matches';
        return textResult(`Top ${records.length} ${label} for "${query}":\n\n${stringify(records)}`);
      }

      default:
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, `Unknown tool: ${name}`);
    }
  }

  async function handleMessage(message) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      return fail(null, ERROR_CODES.INVALID_REQUEST, 'Invalid Request: message must be a JSON-RPC 2.0 object.');
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    const { id, method } = message;
    if (message.jsonrpc !== '2.0') {
      return hasId
        ? fail(id, ERROR_CODES.INVALID_REQUEST, 'Invalid Request: "jsonrpc" must be exactly "2.0".')
        : null;
    }
    if (hasId && id !== null && typeof id !== 'string' && typeof id !== 'number') {
      return fail(null, ERROR_CODES.INVALID_REQUEST, 'Invalid Request: "id" must be a string, a number, or null.');
    }
    if (typeof method !== 'string' || method === '') {
      return hasId
        ? fail(id, ERROR_CODES.INVALID_REQUEST, 'Invalid Request: "method" must be a non-empty string.')
        : null;
    }
    const isNotification = !hasId;

    if (!initialized && method !== 'initialize') {
      if (isNotification) return null;
      return fail(id, ERROR_CODES.SERVER_NOT_INITIALIZED, 'Server not initialized: send an "initialize" request first.');
    }

    switch (method) {
      case 'initialize': {
        if (isNotification) return null;
        const params = message.params;
        if (!params || typeof params !== 'object' || Array.isArray(params)) {
          return fail(id, ERROR_CODES.INVALID_PARAMS, 'Invalid params: "params" for initialize must be an object.');
        }
        if (typeof params.protocolVersion !== 'string' || !params.protocolVersion.trim()) {
          return fail(id, ERROR_CODES.INVALID_PARAMS, 'Invalid params: "params.protocolVersion" must be a non-empty string.');
        }
        if (!params.capabilities || typeof params.capabilities !== 'object' || Array.isArray(params.capabilities)) {
          return fail(id, ERROR_CODES.INVALID_PARAMS, 'Invalid params: "params.capabilities" must be an object.');
        }
        if (!params.clientInfo || typeof params.clientInfo !== 'object' || Array.isArray(params.clientInfo)
            || typeof params.clientInfo.name !== 'string' || !params.clientInfo.name.trim()
            || typeof params.clientInfo.version !== 'string' || !params.clientInfo.version.trim()) {
          return fail(id, ERROR_CODES.INVALID_PARAMS, 'Invalid params: "params.clientInfo" must include non-empty name and version.');
        }
        const requested = params.protocolVersion;
        const negotiated = supportedVersions && supportedVersions.has(requested)
          ? requested
          : protocolVersion;
        initialized = true;
        return ok(id, {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          instructions:
            'speckit-memory keeps durable project memory across sessions. ' +
            'Call memory_add when a durable decision, preference, pattern or lesson appears; ' +
            'call memory_search or memory_list before making decisions to check what is already remembered; ' +
            'call memory_synthesize(feature) when drafting a spec or plan to ground it in accumulated memory.',
        });
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;

      case 'ping':
        if (isNotification) return null;
        return ok(id, {});

      case 'tools/list':
        if (isNotification) return null;
        return ok(id, { tools });

      case 'tools/call': {
        if (isNotification) return null;
        const params = message.params;
        if (!params || typeof params !== 'object' || Array.isArray(params)) {
          return fail(id, ERROR_CODES.INVALID_PARAMS, 'Invalid params: "params" for tools/call must be an object.');
        }
        const name = params.name;
        if (typeof name !== 'string' || name === '') {
          return fail(id, ERROR_CODES.INVALID_PARAMS, 'Invalid params: "params.name" must be a non-empty string.');
        }
        const tool = tools.find((t) => t.name === name);
        if (!tool) {
          return fail(id, ERROR_CODES.INVALID_PARAMS, `Unknown tool: ${name}. Available tools: ${tools.map((t) => t.name).join(', ')}.`);
        }
        const toolArgs = params.arguments;
        if (toolArgs !== undefined && (toolArgs === null || typeof toolArgs !== 'object' || Array.isArray(toolArgs))) {
          return fail(id, ERROR_CODES.INVALID_PARAMS, `Invalid params: "arguments" for ${name} must be an object.`);
        }
        try {
          validateArguments(tool.inputSchema, toolArgs || {}, name);
          const result = await callTool(name, toolArgs || {});
          return ok(id, result);
        } catch (err) {
          if (err instanceof RpcError) return fail(id, err.code, err.message);
          if (err && (err.domain === true || err.isDomainError === true)) {
            return ok(id, textResult(`${err.message || 'Tool execution failed.'}`, true));
          }
          throw err;
        }
      }

      default:
        return isNotification
          ? null
          : fail(id, ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  return { handleMessage, tools };
}

module.exports = { createMcpHandler, buildTools, validateArguments, ERROR_CODES, RpcError };
