// Web 표준 API만 사용하므로 Node 24와 Cloudflare Worker에서 함께 쓸 수 있다.
export const MAX_BODY_BYTES = 1024 * 1024;
export const VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function makeKey(prefix) {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9]{2,4}_(?![\s\S])/.test(prefix)) throw new Error('bad_key_prefix');
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return prefix + btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function hashKey(key) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(key)));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}

function response(status, body, headers = {}) {
  return {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers,
      ...(body === null ? {} : { 'Content-Type': 'application/json; charset=utf-8' }) },
    body: body === null ? null : JSON.stringify(body),
  };
}

export const methodNotAllowed = () => response(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
const rpcError = (status, code, message, id = null) => response(status, { jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (id, result) => response(200, { jsonrpc: '2.0', id, result });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function header(headers, name) {
  if (typeof headers.get === 'function') return headers.get(name);
  const values = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
  return values.length === 1 && typeof values[0][1] === 'string' ? values[0][1] : values.length ? '' : null;
}

function loopback(origin) {
  const match = /^https?:\/\/127\.0\.0\.1(?::(\d{1,5}))?(?![\s\S])/.exec(origin);
  return match && (match[1] === undefined || Number(match[1]) > 0 && Number(match[1]) <= 65535);
}

function rateLimit() {
  const requests = new Map();
  let lastSweep = -Infinity;
  return digest => {
    const now = performance.now();
    const cutoff = now - 60_000;
    if (now - lastSweep >= 60_000) {
      for (const [key, times] of requests) if (times.at(-1) <= cutoff) requests.delete(key);
      lastSweep = now;
    }
    const times = (requests.get(digest) ?? []).filter(time => time > cutoff);
    if (times.length >= 120) return Math.ceil((times[0] - cutoff) / 1000);
    times.push(now);
    requests.set(digest, times);
    return 0;
  };
}

export function createMcp({ name, version = '1', origins = [], authenticate, tools = [], timeoutSeconds = 30 }) {
  const byName = new Map();
  const listed = tools.map(({ name, title, description, inputSchema, annotations, scope, run }) => {
    if (typeof name !== 'string' || !name || byName.has(name) || !['read', 'write'].includes(scope) ||
        typeof run !== 'function' || inputSchema?.type !== 'object') throw new Error('bad_tool');
    byName.set(name, { scope, run, inputSchema });
    return { name, title, description, inputSchema, annotations: { ...annotations, readOnlyHint: scope === 'read' } };
  });
  const allowed = new Set(origins);
  const limit = rateLimit();
  let active = 0;
  const unauthorized = () => response(401, { error: 'unauthorized' }, {
    'WWW-Authenticate': `Bearer realm="${name}"`,
  });
  if (typeof name !== 'string' || !name || /[^\x20-\x7e]|["\\]/.test(name) || typeof authenticate !== 'function') {
    throw new Error('bad_server_config');
  }

  return async function handle({ method = 'POST', headers = {}, body = '', deadline = Infinity }) {
    if (method !== 'POST') return methodNotAllowed();
    const origin = header(headers, 'origin');
    if (origin !== null && !allowed.has(origin) && !loopback(origin)) {
      return response(403, { error: 'bad_origin' });
    }
    const authorization = header(headers, 'authorization');
    const key = typeof authorization === 'string' && /^Bearer ([A-Za-z0-9_-]+)(?![\s\S])/i.exec(authorization)?.[1];
    if (!key) return unauthorized();
    const bytes = typeof body === 'string' ? encoder.encode(body) : body;
    if (!(bytes instanceof Uint8Array)) return rpcError(400, -32700, 'parse_error');
    if (bytes.length > MAX_BODY_BYTES) return response(413, { error: 'body_too_large' });
    if (active >= 32) return response(503, { error: 'server_busy' });

    const versionHeader = header(headers, 'mcp-protocol-version');
    const controller = new AbortController();
    const end = Math.min(deadline, performance.now() + timeoutSeconds * 1000);
    const timeoutResponse = () => response(504, { error: 'timeout' });
    const expired = () => controller.signal.aborted || performance.now() >= end;
    let timer;
    let id = null;
    const timedOut = new Promise(resolve => {
      timer = setTimeout(() => {
        resolve(timeoutResponse());
        controller.abort();
      }, Math.max(0, end - performance.now()));
    });
    const dispatch = async () => {
      const auth = await authenticate(authorization);
      if (expired()) return timeoutResponse();
      if (!auth || auth.user == null || !['read', 'write'].includes(auth.scope)) return unauthorized();
      const digest = await hashKey(key);
      if (expired()) return timeoutResponse();
      const retry = limit(digest);
      if (retry) return response(429, { error: 'rate_limit' }, { 'Retry-After': String(retry) });
      if (versionHeader !== null && !VERSIONS.includes(versionHeader)) {
        return response(400, { error: 'unsupported_protocol_version' });
      }

      let message;
      try {
        message = JSON.parse(decoder.decode(bytes));
      } catch {
        return rpcError(400, -32700, 'parse_error');
      }
      if (!record(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        return rpcError(400, -32600, 'invalid_request');
      }
      if (message.method === 'notifications/initialized' && !Object.hasOwn(message, 'id') &&
          (!Object.hasOwn(message, 'params') || record(message.params))) return response(202, null);
      if (typeof message.id !== 'string' && !Number.isSafeInteger(message.id)) {
        return rpcError(400, -32600, 'invalid_request');
      }
      id = message.id;
      const params = Object.hasOwn(message, 'params') ? message.params : {};
      if (!record(params)) return rpcError(200, -32602, 'invalid_params', id);

      switch (message.method) {
        case 'initialize':
          return rpcResult(id, {
            protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0],
            capabilities: { tools: {} }, serverInfo: { name, version },
          });
        case 'ping':
          return rpcResult(id, {});
        case 'tools/list':
          return rpcResult(id, { tools: listed });
        case 'tools/call': {
          const tool = byName.get(params.name);
          const args = Object.hasOwn(params, 'arguments') ? params.arguments : {};
          if (!tool || !record(args)) return rpcError(200, -32602, 'invalid_params', id);
          if (tool.scope === 'write' && auth.scope !== 'write') {
            return rpcError(403, -32003, 'insufficient_scope', id);
          }
          const { additionalProperties, properties = {} } = tool.inputSchema;
          if (additionalProperties === false && Object.keys(args).some(key => !Object.hasOwn(properties, key))) {
            return rpcError(200, -32602, 'invalid_params', id);
          }
          if (expired()) return timeoutResponse();
          const data = await tool.run(args, { user: auth.user, scope: auth.scope, signal: controller.signal });
          if (expired()) return timeoutResponse();
          const text = JSON.stringify(data);
          if (text === undefined) return rpcError(500, -32603, 'internal_error', id);
          return rpcResult(id, { content: [{ type: 'text', text }], isError: false });
        }
        default:
          return rpcError(200, -32601, 'method_not_found', id);
      }
    };

    try {
      active++;
      return await Promise.race([timedOut, dispatch().finally(() => { active--; })]);
    } catch {
      return rpcError(500, -32603, 'internal_error', id);
    } finally {
      clearTimeout(timer);
    }
  };
}
