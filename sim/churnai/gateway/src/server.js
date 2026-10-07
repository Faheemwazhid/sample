// HTTP server: tenant REST API (/api/v1), MCP Streamable HTTP (/mcp),
// admin tenant provisioning (/admin), and the connector-gateway endpoint the
// Sim "Connect Sources" workflow calls (/v1/connections/test).
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { AppError } from './providers.js';
import { TOOLS, gatewayTestConnections } from './tools.js';
import { hashApiKey, newApiKey } from './vault.js';

const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 256 * 1024;
const TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const errBody = (e) => ({ error: e.code, message: e.message, ...(e.extra || {}) });

async function readJson(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX_BODY) throw new AppError('BODY_TOO_LARGE', 'Request body too large.', 413); chunks.push(c); }
  if (!n) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('BODY_NOT_JSON', 'Body must be JSON.', 400); }
}

function presentedKey(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : (req.headers['x-api-key'] || '').trim();
}

async function authTenant(ctx, req) {
  const key = presentedKey(req);
  if (!key) throw new AppError('UNAUTHENTICATED', 'Send your ChurnAI API key as "Authorization: Bearer <key>" or "X-API-Key".', 401);
  const r = await ctx.db.query('SELECT tenant_id FROM churnai.tenant_api_keys WHERE key_hash = $1 AND revoked_at IS NULL', [hashApiKey(key)]);
  if (!r.rows[0]) throw new AppError('UNAUTHENTICATED', 'Invalid or revoked API key.', 401);
  return r.rows[0].tenant_id;
}

function matchRoute(method, path) {
  for (const t of TOOLS) {
    const [m, pattern] = t.rest;
    if (m !== method) continue;
    const a = pattern.split('/'), b = path.split('/');
    if (a.length !== b.length) continue;
    const params = {}; let ok = true;
    for (let i = 0; i < a.length; i++) {
      if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
      else if (a[i] !== b[i]) { ok = false; break; }
    }
    if (ok) return { tool: t, params };
  }
  return null;
}

function queryArgs(url) {
  const o = {};
  for (const [k, v] of url.searchParams) o[k] = /^\d+$/.test(v) ? Number(v) : v;
  return o;
}

// ---- MCP (stateless Streamable HTTP, JSON responses) -----------------------
async function handleMcp(ctx, req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' }, { Allow: 'POST' });
  let tenantId;
  try { tenantId = await authTenant(ctx, req); } catch (e) {
    return send(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: e.message } }, { 'WWW-Authenticate': 'Bearer realm="churnai"' });
  }
  let msg;
  try { msg = await readJson(req); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const batch = Array.isArray(msg);
  const out = [];
  for (const m of batch ? msg : [msg]) {
    const r = await mcpDispatch({ ...ctx, tenantId }, m);
    if (r) out.push(r);
  }
  if (!out.length) { res.writeHead(202); return res.end(); }
  return send(res, 200, batch ? out : out[0]);
}

async function mcpDispatch(ctx, m) {
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  if (m.id === undefined) return null; // notification
  const ok = (result) => ({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize': {
      const want = m.params?.protocolVersion;
      return ok({ protocolVersion: MCP_VERSIONS.includes(want) ? want : MCP_VERSIONS[0], capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'churnai', version: '1.0.0' },
        instructions: 'Connect a customer\'s data: list_providers → ask which provider → get_provider_inputs → ask the user for exactly those inputs → connect_provider. Billing and analytics are required. Then propose_mapping → confirm_mapping → start_backfill.' });
    }
    case 'ping': return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === m.params?.name);
      if (!tool) return { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${m.params?.name}` } };
      try {
        const data = await tool.handler(ctx, m.params?.arguments || {});
        return ok({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }], structuredContent: data });
      } catch (e) {
        const body = e instanceof AppError ? errBody(e) : (console.error(e), { error: 'INTERNAL', message: 'Internal error.' });
        return ok({ content: [{ type: 'text', text: JSON.stringify(body, null, 1) }], isError: true });
      }
    }
    default: return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
  }
}

// ---- admin: your app provisions a tenant + API key -------------------------
async function handleAdmin(ctx, req, res, path) {
  if (!ctx.adminToken || !safeEq(presentedKey(req), ctx.adminToken)) throw new AppError('UNAUTHENTICATED', 'Admin token required.', 401);
  const m = path.match(/^\/admin\/tenants(?:\/([^/]+)\/keys)?$/);
  if (!m || req.method !== 'POST') throw new AppError('NOT_FOUND', 'Not found.', 404);
  const body = await readJson(req);
  const tenantId = m[1] ? decodeURIComponent(m[1]) : body.tenant_id;
  if (typeof tenantId !== 'string' || !TENANT_ID.test(tenantId)) throw new AppError('TENANT_ID_INVALID', 'tenant_id must match ' + TENANT_ID.source);
  const key = newApiKey();
  await ctx.db.tx(async (q) => {
    await q('INSERT INTO churnai.tenants(tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [tenantId]);
    await q('INSERT INTO churnai.tenant_api_keys(key_hash, tenant_id, label) VALUES ($1,$2,$3)', [hashApiKey(key), tenantId, String(body.label || '').slice(0, 100) || null]);
  });
  return send(res, 201, { tenant_id: tenantId, api_key: key, note: 'Shown once. Give it to the customer for the REST API or MCP.' });
}

export function createApp(ctx) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/healthz') return send(res, 200, { ok: true });
      if (path === '/mcp') return await handleMcp(ctx, req, res);
      if (path.startsWith('/admin/')) return await handleAdmin(ctx, req, res, path);
      if (path === '/v1/connections/test' && req.method === 'POST') {
        if (!ctx.gatewayKey || !safeEq(presentedKey(req), ctx.gatewayKey)) throw new AppError('UNAUTHENTICATED', 'Gateway key required.', 401);
        return send(res, 200, await gatewayTestConnections(ctx, await readJson(req)));
      }
      if (path === '/api/v1/tools' && req.method === 'GET')
        return send(res, 200, { tools: TOOLS.map((t) => ({ name: t.name, method: t.rest[0], path: t.rest[1], description: t.description, input_schema: t.inputSchema })) });
      const route = matchRoute(req.method, path);
      if (!route) throw new AppError('NOT_FOUND', 'Not found. GET /api/v1/tools lists endpoints.', 404);
      const tenantId = await authTenant(ctx, req);
      const args = { ...(req.method === 'GET' || req.method === 'DELETE' ? queryArgs(url) : await readJson(req)), ...route.params };
      return send(res, route.tool.rest[0] === 'POST' && route.tool.name === 'connect_provider' ? 201 : 200, await route.tool.handler({ ...ctx, tenantId }, args));
    } catch (e) {
      if (e instanceof AppError) return send(res, e.status, errBody(e));
      console.error(e);
      return send(res, 500, { error: 'INTERNAL', message: 'Internal error.' });
    }
  });
}
