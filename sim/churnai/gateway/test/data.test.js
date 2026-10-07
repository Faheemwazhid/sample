// Gateway data endpoints against fake provider APIs (no network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/server.js';
import { unzip } from '../src/connectors/analytics.js';

const sql = (f) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
const ADMIN = 'admin-secret', GW = 'gw-secret';
const NOW = Date.parse('2026-10-01T00:00:00Z');
const DAY = 86400000;
let server, base, pgl, calls = [], routes = [];

const json = (b, status = 200, headers = {}) => new Response(JSON.stringify(b), { status, headers });
const fakeFetch = async (url, init = {}) => {
  calls.push({ url, init });
  for (const [re, fn] of routes) if (re.test(url)) return fn(url, init);
  return json({}); // connection tests during connect_provider
};
const route = (re, fn) => routes.push([re, fn]);

before(async () => {
  pgl = new PGlite();
  await pgl.exec(sql('schema.sql')); await pgl.exec(sql('gateway.sql'));
  const db = { query: (t, p) => pgl.query(t, p), tx: (fn) => pgl.transaction((tx) => fn((t, p) => tx.query(t, p))) };
  server = createApp({ db, fetch: fakeFetch, key: randomBytes(32), adminToken: ADMIN, gatewayKey: GW, now: () => NOW, retryDelayMs: 0,
    sim: { base: 'https://sim.test/api/v2', apiKey: 'k', workflows: {} } });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, { key, body } = {}) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(key && { Authorization: `Bearer ${key}` }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const gw = (path, body) => call('POST', path, { key: GW, body });
async function tenantWith(id, conns) {
  const key = (await call('POST', '/admin/tenants', { key: ADMIN, body: { tenant_id: id } })).body.api_key;
  for (const [provider, inputs] of conns) assert.equal((await call('POST', '/api/v1/connections', { key, body: { provider, inputs } })).status, 201);
  const r = await pgl.query('SELECT source, provider, connection_ref FROM churnai.tenant_connections WHERE tenant_id = $1', [id]);
  return Object.fromEntries(r.rows.map((x) => [x.source, x]));
}

const sub = (id, cust, status, extra = {}) => ({ id, status, cancel_at_period_end: false, currency: 'usd', current_period_end: NOW / 1000 + 10 * 86400,
  customer: { id: cust, email: `ceo@${cust}.com`, name: cust, created: 1700000000, metadata: { workspace_id: `ws_${cust}` } },
  items: { data: [{ quantity: 5, price: { unit_amount: 1200, currency: 'usd', nickname: 'Pro', recurring: { interval: 'month', interval_count: 1 } } }] }, ...extra });

test('gateway data endpoints require the gateway key and the owning tenant', async () => {
  const c = await tenantWith('own', [['stripe', { secret_key: 'rk_live_x' }]]);
  await tenantWith('other', []);
  assert.equal((await call('POST', '/v1/billing/customers', { key: 'nope', body: {} })).status, 401);
  const r = await gw('/v1/billing/customers', { tenant_id: 'other', connection: c.billing });
  assert.equal(r.status, 404); assert.equal(r.body.error, 'CONNECTION_REF_UNKNOWN');
  const bad = await gw('/v1/billing/customers', { tenant_id: 'own', connection: c.billing, statuses: ['canceled'] });
  assert.equal(bad.body.error, 'STATUSES_INVALID');
});

test('Stripe: trialing then active pages, non-renewing, monthly MRR, cursor and retry on 429', async () => {
  const c = await tenantWith('st', [['stripe', { secret_key: 'rk_live_x' }]]);
  let first429 = true;
  routes = [];
  route(/api\.stripe\.com\/v1\/subscriptions/, (url) => {
    if (first429) { first429 = false; return json({}, 429, { 'retry-after': '0' }); }
    const q = new URL(url).searchParams;
    assert.equal(q.get('expand[]'), 'data.customer');
    if (q.get('status') === 'trialing') return json({ has_more: false, data: [sub('sub_t', 'cus_t', 'trialing', { trial_end: NOW / 1000 + 86400 })] });
    if (!q.get('starting_after')) return json({ has_more: true, data: [sub('sub_a', 'cus_a', 'active'),
      sub('sub_y', 'cus_y', 'active', { cancel_at_period_end: true, items: { data: [{ quantity: 1, price: { unit_amount: 120000, currency: 'usd', recurring: { interval: 'year', interval_count: 1 } } }] } })] });
    return json({ has_more: false, data: [sub('sub_b', 'cus_b', 'active')] });
  });
  const p1 = await gw('/v1/billing/customers', { tenant_id: 'st', connection: c.billing, limit: 50 });
  assert.equal(p1.status, 200);
  assert.deepEqual(p1.body.customers.map((x) => [x.id, x.status]), [['cus_t', 'trialing']]);
  assert.equal(p1.body.next_cursor, 'active|');
  const p2 = await gw('/v1/billing/changes', { tenant_id: 'st', connection: c.billing, cursor: p1.body.next_cursor });
  assert.deepEqual(p2.body.customers.map((x) => [x.id, x.status, x.mrr, x.seats]), [['cus_a', 'active', 60, 5], ['cus_y', 'non_renewing', 100, 1]]);
  assert.equal(p2.body.customers[0].email_domain, 'cus_a.com');
  assert.equal(p2.body.customers[0].metadata.workspace_id, 'ws_cus_a');
  assert.equal(p2.body.next_cursor, 'active|sub_y');
  const p3 = await gw('/v1/billing/customers', { tenant_id: 'st', connection: c.billing, cursor: p2.body.next_cursor });
  assert.equal(p3.body.has_more, false); assert.equal(p3.body.next_cursor, null);
  assert.ok(!JSON.stringify([p1, p2, p3]).includes('rk_live_x'), 'credentials never returned');
  const only = await gw('/v1/billing/customers', { tenant_id: 'st', connection: c.billing, statuses: ['non_renewing'], cursor: 'active|' });
  assert.deepEqual(only.body.customers.map((x) => x.id), ['cus_y']);
});

test('Chargebee, Paddle and Dodo map to the same billing record shape', async () => {
  const c = await tenantWith('multi', [['chargebee', { site: 'acme', api_key: 'k' }]]);
  routes = [];
  route(/acme\.chargebee\.com\/api\/v2\/subscriptions/, (url) => {
    assert.deepEqual(JSON.parse(new URL(url).searchParams.get('status[in]')), ['active', 'in_trial', 'non_renewing']);
    return json({ next_offset: 'off2', list: [{ subscription: { id: 's1', customer_id: 'c1', status: 'non_renewing', mrr: 4900, currency_code: 'USD', current_term_end: 1790000000,
      subscription_items: [{ item_type: 'plan', item_price_id: 'pro-USD-monthly', quantity: 3 }] }, customer: { id: 'c1', email: 'a@b.io', company: 'B', cf_tenant: 't-9' } }] });
  });
  const cb = (await gw('/v1/billing/customers', { tenant_id: 'multi', connection: c.billing })).body;
  assert.deepEqual([cb.customers[0].status, cb.customers[0].mrr, cb.customers[0].seats, cb.customers[0].plan, cb.customers[0].metadata.cf_tenant, cb.next_cursor],
    ['non_renewing', 49, 3, 'pro-USD-monthly', 't-9', 'off2']);

  const pc = await tenantWith('pad', [['paddle', { api_key: 'k' }]]);
  route(/api\.paddle\.com\/subscriptions/, () => json({ meta: { pagination: { has_more: true } }, data: [{ id: 'sub_1', customer_id: 'ctm_1', status: 'active', currency_code: 'EUR',
    scheduled_change: { action: 'cancel' }, items: [{ quantity: 2, price: { name: 'Team', unit_price: { amount: '30000' }, billing_cycle: { interval: 'year', frequency: 1 } } }] }] }));
  route(/api\.paddle\.com\/customers/, (url) => { assert.equal(new URL(url).searchParams.get('id'), 'ctm_1'); return json({ data: [{ id: 'ctm_1', email: 'x@y.de', custom_data: { org: 'o1' } }] }); });
  const pd = (await gw('/v1/billing/customers', { tenant_id: 'pad', connection: pc.billing })).body;
  assert.deepEqual([pd.customers[0].status, pd.customers[0].mrr, pd.customers[0].email, pd.customers[0].metadata.org, pd.next_cursor], ['non_renewing', 50, 'x@y.de', 'o1', 'sub_1']);

  const dc = await tenantWith('dodo', [['dodo_payments', { api_key: 'k', environment: 'test' }]]);
  route(/test\.dodopayments\.com\/subscriptions/, () => json({ items: [{ subscription_id: 'sd1', status: 'active', created_at: new Date(NOW - 2 * DAY).toISOString(), trial_period_days: 14,
    recurring_pre_tax_amount: 9900, currency: 'USD', payment_frequency_interval: 'Month', payment_frequency_count: 1, quantity: 1, customer: { customer_id: 'cd1', email: 'z@q.com' } }] }));
  const dd = (await gw('/v1/billing/customers', { tenant_id: 'dodo', connection: dc.billing })).body;
  assert.deepEqual([dd.customers[0].id, dd.customers[0].status, dd.customers[0].mrr, dd.has_more], ['cd1', 'trialing', 99, false]);
});

test('sample prefers source records that link to billing; enrich rolls users up per domain and reuses one export', async () => {
  const c = await tenantWith('acme', [['stripe', { secret_key: 'rk_live_x' }], ['posthog', { personal_api_key: 'phx_x', project_id: '7' }],
    ['hubspot', { access_token: 'pat-na1-x' }], ['zendesk', { subdomain: 'acme', email: 'a@acme.com', api_token: 't' }]]);
  routes = [];
  route(/api\.stripe\.com\/v1\/subscriptions/, (url) => json({ has_more: false, data: new URL(url).searchParams.get('status') === 'active' ? [sub('s1', 'globex', 'active')] : [] }));
  const people = [['p0', 'd0', 'zed@random.org', 'Zed', null, 3, 1, '2026-09-29 10:00:00'],
    ['p1', 'd1', 'ann@globex.com', 'Ann', 'g1', 10, 4, '2026-09-30 10:00:00'], ['p2', 'd2', 'Bob@Globex.com', 'Bob', 'g1', 0, 7, '2026-08-20 10:00:00']];
  route(/us\.posthog\.com\/api\/projects\/7\/query/, (url, init) => {
    const b = JSON.parse(init.body);
    assert.equal(b.query.kind, 'HogQLQuery'); assert.equal(b.query.values.end, new Date(NOW).toISOString().replace('.000', '.000'));
    return json({ results: people });
  });
  route(/api\.hubapi\.com\/crm\/v3\/objects\/companies/, (url) => new URL(url).searchParams.get('after')
    ? json({ results: [{ id: '2', properties: { name: 'Globex', domain: 'GLOBEX.com', lifecyclestage: 'customer', hs_num_open_deals: '2', notes_last_updated: '2026-09-01T00:00:00Z' } }] })
    : json({ results: [{ id: '1', properties: { name: 'Other', domain: 'other.com' } }], paging: { next: { after: 'x' } } }));
  route(/acme\.zendesk\.com\/api\/v2\/incremental\/tickets\/cursor\.json/, (url) => new URL(url).searchParams.get('cursor')
    ? json({ end_of_stream: true, tickets: [{ requester_id: 9, status: 'solved', priority: 'urgent', created_at: '2026-09-25T00:00:00Z', satisfaction_rating: { score: 'bad' } }], users: [{ id: 9, email: 'ann@globex.com' }] })
    : json({ end_of_stream: false, after_cursor: 'c2', tickets: [{ requester_id: 9, status: 'open', created_at: '2026-09-20T00:00:00Z', satisfaction_rating: { score: 'good' } }], users: [{ id: 9, email: 'ann@globex.com', name: 'Ann' }] }));

  const connections = Object.values(c);
  const s = (await gw('/v1/sample', { tenant_id: 'acme', connections, limit: 2 })).body;
  assert.deepEqual(s.billing.map((x) => x.id), ['globex']);
  assert.deepEqual(s.analytics.map((x) => x.email), ['ann@globex.com', 'Bob@Globex.com'], 'linked records first, capped at limit');
  assert.equal(s.crm[0].domain, 'globex.com');
  assert.equal(s.support[0].email, 'ann@globex.com');

  const mapping = { analytics: { link: { billing_field: 'email_domain', source_field: 'email', match: 'domain' } },
    crm: { link: { billing_field: 'email_domain', source_field: 'domain', match: 'lowercase' } },
    support: { link: { billing_field: 'email_domain', source_field: 'email_domain', match: 'lowercase' } } };
  const window_end = new Date(NOW).toISOString();
  const body = { tenant_id: 'acme', connections: connections.filter((x) => x.source !== 'billing'), mapping, window_start: null, window_end,
    link_values: { analytics: ['globex.com', 'nobody.com'], crm: ['globex.com'], support: ['globex.com'] } };
  calls = [];
  const e = (await gw('/v1/enrich', body)).body;
  assert.equal(e.analytics.length, 1);
  assert.deepEqual([e.analytics[0].events_28d, e.analytics[0].events_prev_28d, e.analytics[0].active_users_28d, e.analytics[0].matched_records], [10, 11, 1, 2]);
  assert.equal(e.analytics[0].last_seen_at, '2026-09-30T10:00:00.000Z');
  assert.deepEqual([e.crm[0].id, e.crm[0].open_opportunities], ['2', 2]);
  assert.deepEqual([e.support[0].open_tickets, e.support[0].tickets_28d, e.support[0].escalations_28d, e.support[0].csat], [1, 2, 1, 0.5]);

  const before = calls.length;
  await gw('/v1/enrich', { ...body, link_values: { analytics: ['random.org'], crm: [], support: [] } });
  assert.equal(calls.filter((x) => /posthog/.test(x.url)).length, 1, 'second batch in the same window reuses the export');
  assert.ok(calls.length - before <= 1);

  const wrong = await gw('/v1/enrich', { ...body, mapping: { analytics: { link: { source_field: 'email', match: 'fuzzy' } } } });
  assert.equal(wrong.body.error, 'MAPPING_INVALID');
});

test('Mixpanel streams the export and joins profile emails; Amplitude unzips daily exports', async () => {
  const c = await tenantWith('mx', [['stripe', { secret_key: 'rk_live_x' }], ['mixpanel', { service_account_username: 'u', service_account_secret: 's', project_id: '42', region: 'eu' }]]);
  routes = [];
  const t = (d) => Math.floor((NOW - d * DAY) / 1000);
  const lines = [{ event: 'a', properties: { distinct_id: 'u1', time: t(1) } }, { event: 'b', properties: { distinct_id: 'u1', time: t(40) } },
    { event: 'c', properties: { distinct_id: 'u2', time: t(3) } }].map((x) => JSON.stringify(x)).join('\n');
  route(/data-eu\.mixpanel\.com\/api\/2\.0\/export/, () => new Response(lines + '\n', { status: 200 }));
  route(/eu\.mixpanel\.com\/api\/query\/engage/, () => json({ results: [{ $distinct_id: 'u1', $properties: { $email: 'x@corp.io' } }] }));
  const e = (await gw('/v1/enrich', { tenant_id: 'mx', connections: [c.analytics], window_end: new Date(NOW).toISOString(),
    mapping: { analytics: { link: { source_field: 'email', match: 'lowercase' } } }, link_values: { analytics: ['X@corp.io'] } })).body;
  assert.deepEqual([e.analytics[0].id, e.analytics[0].events_28d, e.analytics[0].events_prev_28d], ['u1', 1, 1]);

  // Minimal zip: one deflated .json.gz entry, as Amplitude's Export API returns.
  const gz = gzipSync(JSON.stringify({ user_id: 'amp1', event_time: '2026-09-30 01:02:03.000', user_properties: { email: 'm@n.co' } }) + '\n');
  const name = Buffer.from('1/2026-09-30_0#0.json.gz'); const data = deflateRawSync(gz);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(data.length, 20); cd.writeUInt16LE(name.length, 28);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(30 + name.length + data.length, 16);
  const zip = Buffer.concat([local, name, data, cd, name, eocd]);
  assert.equal(unzip(zip)[0].name, '1/2026-09-30_0#0.json.gz');

  const a = await tenantWith('amp', [['amplitude', { api_key: 'a', secret_key: 'b' }]]);
  route(/amplitude\.com\/api\/2\/export/, (url) => (/start=20260930T00/.test(url) ? new Response(zip, { status: 200 }) : new Response('', { status: 404 })));
  const ea = (await gw('/v1/enrich', { tenant_id: 'amp', connections: [a.analytics], window_end: new Date(NOW).toISOString(),
    mapping: { analytics: { link: { source_field: 'email_domain', match: 'lowercase' } } }, link_values: { analytics: ['n.co'] } })).body;
  assert.deepEqual([ea.analytics[0].id, ea.analytics[0].email, ea.analytics[0].events_28d], ['amp1', 'm@n.co', 1]);
  assert.equal(calls.filter((x) => /amplitude\.com\/api\/2\/export/.test(x.url)).length, 56, 'one export call per day over 56 days');
});
