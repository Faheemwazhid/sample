import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/server.js';

const sql = (f) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
let server, base, pgl, providerCalls = [], simCalls = [];
const ADMIN = 'admin-secret', GW = 'gw-secret';

// Fake upstreams: provider APIs accept only "good" credentials; Sim echoes.
const fakeFetch = async (url, init = {}) => {
  if (url.startsWith('https://sim.test/')) {
    simCalls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ success: true, data: { executionId: 'ex1', output: { status: 'proposed', version: 1 } } }), { status: 200 });
  }
  providerCalls.push({ url, headers: init.headers });
  const auth = JSON.stringify(init.headers || {}) + (init.body || '');
  return new Response('{}', { status: /good/.test(auth) || /Z29vZ/.test(auth) ? 200 : 401 });
};

before(async () => {
  pgl = new PGlite();
  await pgl.exec(sql('schema.sql')); await pgl.exec(sql('gateway.sql'));
  const db = { query: (t, p) => pgl.query(t, p), tx: (fn) => pgl.transaction((tx) => fn((t, p) => tx.query(t, p))) };
  server = createApp({ db, fetch: fakeFetch, key: randomBytes(32), adminToken: ADMIN, gatewayKey: GW,
    sim: { base: 'https://sim.test/api/v2', apiKey: 'sim-key', workflows: { map: 'wf-map', backfill: 'wf-bf', score: 'wf-score' } } });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, { key, body } = {}) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(key && { Authorization: `Bearer ${key}` }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: r.status === 202 ? null : await r.json() };
};
const tenant = async (id) => (await call('POST', '/admin/tenants', { key: ADMIN, body: { tenant_id: id } })).body.api_key;
const mcp = (key, method, params, id = 1) => call('POST', '/mcp', { key, body: { jsonrpc: '2.0', id, method, params } });

test('admin provisioning requires the admin token', async () => {
  assert.equal((await call('POST', '/admin/tenants', { key: 'nope', body: { tenant_id: 'x' } })).status, 401);
  assert.equal((await call('POST', '/admin/tenants', { key: ADMIN, body: { tenant_id: 'bad id!' } })).body.error, 'TENANT_ID_INVALID');
});

test('REST: list → inputs → connect flow, isolated per tenant', async () => {
  const acme = await tenant('acme'), globex = await tenant('globex');
  assert.equal((await call('GET', '/api/v1/providers')).status, 401);

  const list = (await call('GET', '/api/v1/providers', { key: acme })).body.sources;
  assert.deepEqual(list.map((s) => s.source), ['billing', 'analytics', 'crm', 'support']);
  assert.ok(list[0].providers.some((p) => p.provider === 'stripe'));

  const inputs = (await call('GET', '/api/v1/providers/stripe', { key: acme })).body.inputs;
  assert.deepEqual(inputs.map((i) => i.name), ['secret_key']);

  const missing = await call('POST', '/api/v1/connections', { key: acme, body: { provider: 'stripe', inputs: {} } });
  assert.equal(missing.status, 400); assert.equal(missing.body.error, 'INPUTS_INVALID');
  assert.deepEqual(missing.body.problems, [{ field: 'secret_key', problem: 'missing' }]);

  const bad = await call('POST', '/api/v1/connections', { key: acme, body: { provider: 'stripe', inputs: { secret_key: 'rk_live_bad' } } });
  assert.equal(bad.status, 422); assert.equal(bad.body.error, 'PROVIDER_AUTH_FAILED');

  const ok = await call('POST', '/api/v1/connections', { key: acme, body: { provider: 'stripe', inputs: { secret_key: 'rk_live_good' } } });
  assert.equal(ok.status, 201); assert.equal(ok.body.status, 'connected');
  assert.deepEqual(ok.body.missing_required, ['analytics']);
  assert.ok(!JSON.stringify(ok.body).includes('rk_live_good'), 'secret never echoed');

  const stored = await pgl.query("SELECT ciphertext FROM churnai.connection_secrets WHERE tenant_id = 'acme'");
  assert.equal(stored.rows.length, 1); assert.ok(!stored.rows[0].ciphertext.includes('rk_live_good'), 'encrypted at rest');

  // Reconnecting replaces the old secret.
  await call('POST', '/api/v1/connections', { key: acme, body: { provider: 'stripe', inputs: { secret_key: 'rk_live_good2' } } });
  assert.equal((await pgl.query("SELECT 1 FROM churnai.connection_secrets WHERE tenant_id = 'acme'")).rows.length, 1);

  const ph = await call('POST', '/api/v1/connections', { key: acme, body: { provider: 'posthog', inputs: { personal_api_key: 'phx_good', project_id: '123', region: 'eu' } } });
  assert.equal(ph.body.ready_for_mapping, true);
  assert.equal(providerCalls.at(-1).url, 'https://eu.posthog.com/api/projects/123/');

  assert.equal((await call('GET', '/api/v1/connections', { key: globex })).body.connections.length, 0, 'tenant isolation');

  const dis = await call('DELETE', '/api/v1/connections/analytics', { key: acme });
  assert.deepEqual(dis.body.missing_required, ['analytics']);
});

test('subdomain inputs cannot redirect requests to other hosts', async () => {
  const k = await tenant('ssrf');
  const r = await call('POST', '/api/v1/connections', { key: k, body: { provider: 'zendesk', inputs: { subdomain: 'evil.com/x?', email: 'a@b.co', api_token: 'good' } } });
  assert.equal(r.body.error, 'INPUTS_INVALID');
});

test('gateway endpoint re-tests stored refs only for the owning tenant', async () => {
  const ref = (await pgl.query("SELECT connection_ref FROM churnai.tenant_connections WHERE tenant_id = 'acme' AND source = 'billing'")).rows[0].connection_ref;
  const body = { tenant_id: 'acme', connections: [{ source: 'billing', provider: 'stripe', connection_ref: ref }] };
  assert.equal((await call('POST', '/v1/connections/test', { key: 'wrong', body })).status, 401);
  assert.deepEqual((await call('POST', '/v1/connections/test', { key: GW, body })).body.results, [{ source: 'billing', ok: true }]);
  assert.equal((await call('POST', '/v1/connections/test', { key: GW, body: { ...body, tenant_id: 'globex' } })).body.results[0].error, 'CONNECTION_REF_UNKNOWN');
});

test('MCP: initialize, list tools, call tools with tenant injected', async () => {
  const k = await tenant('mcpco');
  assert.equal((await mcp(null, 'tools/list')).status, 401);
  const init = await mcp(k, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.equal((await call('POST', '/mcp', { key: k, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status, 202);

  const tools = (await mcp(k, 'tools/list')).body.result.tools.map((t) => t.name);
  assert.deepEqual(tools, ['list_providers', 'get_provider_inputs', 'connect_provider', 'list_connections', 'disconnect_source',
    'propose_mapping', 'get_mapping', 'confirm_mapping', 'start_backfill', 'run_incremental_sync', 'score_accounts', 'get_account_scores']);

  const inputs = await mcp(k, 'tools/call', { name: 'get_provider_inputs', arguments: { provider: 'chargebee' } });
  assert.deepEqual(inputs.body.result.structuredContent.inputs.map((i) => i.name), ['site', 'api_key']);

  const fail = await mcp(k, 'tools/call', { name: 'connect_provider', arguments: { provider: 'chargebee', inputs: { site: 'acme' } } });
  assert.equal(fail.body.result.isError, true);
  assert.match(fail.body.result.content[0].text, /INPUTS_INVALID/);

  simCalls = [];
  const bf = await mcp(k, 'tools/call', { name: 'start_backfill', arguments: { tenant_id: 'acme', max_batches: 5 } });
  assert.equal(bf.body.result.structuredContent.status, 'started');
  assert.equal(simCalls[0].url, 'https://sim.test/api/v2/workflows/wf-bf/execute');
  assert.deepEqual(simCalls[0].body, { input: { kind: 'backfill', max_batches: 5, tenant_id: 'mcpco' }, async: true }, 'tenant comes from the key, not args');
});

test('mapping confirm guards versions', async () => {
  const k = await tenant('mapco');
  await pgl.query(`INSERT INTO churnai.tenant_mappings(tenant_id, version, mapping, status) VALUES ('mapco', 1, '{}', 'proposed')`);
  assert.equal((await call('POST', '/api/v1/mapping/confirm', { key: k, body: { version: 2 } })).body.error, 'MAPPING_NOT_FOUND');
  assert.equal((await call('POST', '/api/v1/mapping/confirm', { key: k, body: { version: 1 } })).body.status, 'confirmed');
  assert.equal((await call('GET', '/api/v1/mapping', { key: k })).body.mapping.status, 'confirmed');
});
