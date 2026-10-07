// Connector-gateway data endpoints called by the Sim workflows (gateway key auth):
//   POST /v1/sample             Sample & Map: up to `limit` records per connected source
//   POST /v1/billing/customers  Backfill: one page of active/trialing/non-renewing customers
//   POST /v1/billing/changes    Incremental: same walk; ingest_batch re-scores only rows whose content changed
//   POST /v1/enrich             Backfill: analytics/CRM/support records for one page's link values
// Credentials are resolved from the tenant's own connection refs and never leave the gateway.
import { AppError, PROVIDERS } from './providers.js';
import { resolveCredentials } from './tools.js';
import { BILLING } from './connectors/billing.js';
import { ANALYTICS } from './connectors/analytics.js';
import { CRM, SUPPORT } from './connectors/crm_support.js';
import { KEEP, domainOf } from './connectors/util.js';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const COLLECT = { analytics: ANALYTICS, crm: CRM, support: SUPPORT };
const NORM = { exact: (v) => String(v), lowercase: (v) => String(v).trim().toLowerCase(), domain: (v) => String(v).trim().toLowerCase().split('@').pop() };
const SUM = ['events_28d', 'events_prev_28d', 'active_users_28d', 'open_tickets', 'tickets_28d', 'escalations_28d', 'csat_rated', 'csat_good', 'open_opportunities', 'matched_records'];
const MAX_AT = ['last_seen_at', 'last_ticket_at', 'last_activity_at'];
const get = (o, p) => String(p).split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

const bad = (code, msg) => new AppError(code, msg, 400, { retryable: false });

async function connection(ctx, tenantId, c, expectSource) {
  if (!c || typeof c !== 'object' || typeof c.connection_ref !== 'string') throw bad('CONNECTION_INVALID', 'connection must include connection_ref.');
  if (expectSource && c.source !== expectSource) throw bad('CONNECTION_SOURCE_MISMATCH', `Expected a ${expectSource} connection.`);
  const { provider, inputs } = await resolveCredentials(ctx, tenantId, c.connection_ref);
  const source = PROVIDERS[provider]?.source;
  if ((c.provider && c.provider !== provider) || (c.source && c.source !== source)) throw bad('CONNECTION_REF_MISMATCH', 'connection_ref does not match provider/source.');
  return { source, provider, ref: c.connection_ref, inputs };
}

function tenantOf(body) {
  if (typeof body?.tenant_id !== 'string' || !SAFE_ID.test(body.tenant_id)) throw bad('TENANT_ID_INVALID', 'tenant_id is required.');
  return body.tenant_id;
}
const limitOf = (v) => Math.min(Math.max(Math.trunc(Number(v)) || 50, 1), 50);
const endOf = (v, ctx) => { const t = v ? Date.parse(v) : (ctx.now?.() ?? Date.now()); if (!Number.isFinite(t)) throw bad('WINDOW_INVALID', 'window_end must be an ISO timestamp.'); return t; };

// ---- bulk-collect cache: one export per (tenant, connection, window) -----------
// A backfill job keeps the same window_end for all its batches, so 200 batches of 50
// share one provider export instead of re-pulling it per batch.
export function createCache({ ttlMs = 2 * 3600000, max = 32 } = {}) {
  const m = new Map();
  return async (key, fn, now = Date.now()) => {
    const hit = m.get(key);
    if (hit && now - hit.at < ttlMs) return hit.p;
    const p = fn(); m.set(key, { p, at: now });
    p.catch(() => m.get(key)?.p === p && m.delete(key));
    while (m.size > max) m.delete(m.keys().next().value);
    return p;
  };
}

function collect(ctx, tenantId, conn, end, opts = {}) {
  const fn = COLLECT[conn.source]?.[conn.provider];
  if (!fn) throw bad('UNSUPPORTED_PROVIDER', `No data connector for ${conn.provider}.`);
  const key = [tenantId, conn.ref, conn.provider, opts.sample ? 'sample' : 'full', new Date(end).toISOString()].join('|');
  return ctx.dataCache(key, () => fn(ctx, conn.inputs, { end, ...opts }), ctx.now?.() ?? Date.now());
}

// ---- POST /v1/billing/customers and /v1/billing/changes ------------------------
export async function billingPage(ctx, body) {
  const tenantId = tenantOf(body);
  const conn = await connection(ctx, tenantId, body.connection, 'billing');
  const statuses = Array.isArray(body.statuses) && body.statuses.length ? body.statuses : KEEP;
  if (statuses.some((s) => !KEEP.includes(s))) throw bad('STATUSES_INVALID', `statuses must be within ${KEEP.join(', ')}.`);
  if (body.cursor != null && (typeof body.cursor !== 'string' || body.cursor.length > 512)) throw bad('CURSOR_INVALID', 'cursor must be a string.');
  const page = await BILLING[conn.provider](ctx, conn.inputs, { cursor: body.cursor || null, limit: limitOf(body.limit), statuses });
  return { provider: conn.provider, ...page };
}

// ---- POST /v1/sample -----------------------------------------------------------
export async function sample(ctx, body) {
  const tenantId = tenantOf(body);
  const list = Array.isArray(body.connections) ? body.connections : [];
  const limit = limitOf(body.limit);
  const conns = await Promise.all(list.map((c) => connection(ctx, tenantId, c)));
  const billing = conns.find((c) => c.source === 'billing');
  if (!billing || !conns.some((c) => c.source === 'analytics')) throw bad('REQUIRED_CONNECTIONS_MISSING', 'billing and analytics connections are required.');

  const customers = []; let cursor = null;
  for (let i = 0; i < 5 && customers.length < limit; i++) {
    const p = await BILLING[billing.provider](ctx, billing.inputs, { cursor, limit, statuses: KEEP });
    customers.push(...p.customers); cursor = p.next_cursor;
    if (!p.has_more) break;
  }
  const out = { billing: customers.slice(0, limit) };
  // Prefer source records that share a value with the billing sample (ids, emails, domains, metadata),
  // so Sample & Map can measure real join overlap instead of comparing two unrelated random samples.
  const seen = new Set();
  const scan = (o) => { for (const v of Object.values(o || {})) if (v && typeof v === 'object') scan(v); else if (v != null && v !== '') { const s = String(v).trim().toLowerCase(); seen.add(s); const d = domainOf(s); if (d) seen.add(d); } };
  out.billing.forEach(scan);
  const linked = (r) => { let hit = false; const walk = (o) => { for (const v of Object.values(o || {})) { if (hit) return; if (v && typeof v === 'object') walk(v); else if (v != null && v !== '') { const s = String(v).trim().toLowerCase(); hit = seen.has(s) || seen.has(domainOf(s)); } } }; walk(r); return hit; };
  const end = endOf(null, ctx);
  await Promise.all(conns.filter((c) => c.source !== 'billing').map(async (c) => {
    const recs = await collect(ctx, tenantId, c, Math.floor(end / 3600000) * 3600000, { sample: true, days: c.source === 'analytics' ? 7 : undefined, maxRecords: 5000, maxEntities: 5000 });
    const hits = recs.filter(linked);
    out[c.source] = [...hits, ...recs.filter((r) => !hits.includes(r))].slice(0, limit);
  }));
  return out;
}

// ---- POST /v1/enrich -----------------------------------------------------------
function merge(rows) {
  const r = { ...rows[0], matched_records: 1 };
  for (const x of rows.slice(1)) {
    r.matched_records++;
    for (const k of SUM) if (typeof x[k] === 'number') r[k] = (typeof r[k] === 'number' ? r[k] : 0) + x[k];
    for (const k of MAX_AT) if (x[k] && (!r[k] || x[k] > r[k])) r[k] = x[k];
    for (const [k, v] of Object.entries(x)) if (r[k] == null && v != null) r[k] = v;
  }
  if (typeof r.csat_rated === 'number') r.csat = r.csat_rated ? Math.round((r.csat_good / r.csat_rated) * 100) / 100 : null;
  return r;
}

export async function enrich(ctx, body) {
  const tenantId = tenantOf(body);
  const end = endOf(body.window_end, ctx);
  const mapping = body.mapping && typeof body.mapping === 'object' ? body.mapping : {};
  const conns = await Promise.all((Array.isArray(body.connections) ? body.connections : []).filter((c) => c?.source !== 'billing').map((c) => connection(ctx, tenantId, c)));
  const out = {};
  await Promise.all(conns.map(async (c) => {
    const cfg = mapping[c.source];
    if (!cfg) return; // connected but not mapped
    const field = cfg.link?.source_field; const norm = NORM[cfg.link?.match];
    if (typeof field !== 'string' || field.length > 200 || !norm) throw bad('MAPPING_INVALID', `mapping.${c.source}.link is invalid.`);
    const values = body.link_values?.[c.source];
    if (!Array.isArray(values) || values.length > 1000) throw bad('LINK_VALUES_INVALID', `link_values.${c.source} must be an array (max 1000).`);
    const want = new Set(values.filter((v) => v != null).map(norm));
    const groups = new Map();
    if (want.size) {
      for (const r of await collect(ctx, tenantId, c, end)) {
        const v = get(r, field); if (v == null || v === '') continue;
        const k = norm(v); if (!want.has(k)) continue;
        (groups.get(k) || groups.set(k, []).get(k)).push(r);
      }
    }
    // One record per link key: a company domain with 12 users becomes one row with summed usage.
    out[c.source] = [...groups.values()].map(merge);
  }));
  return out;
}
