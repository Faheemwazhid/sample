// One registry drives both surfaces: each tool is a REST endpoint and an MCP tool.
// tenant_id is never an input — it always comes from the authenticated API key.
import { AppError, PROVIDERS, SOURCES, describeProvider, listProviders, testCredentials, validateInputs } from './providers.js';
import { decrypt, encrypt, newRef } from './vault.js';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const sourceEnum = { type: 'string', enum: Object.keys(SOURCES) };
const providerEnum = { type: 'string', enum: Object.keys(PROVIDERS) };

async function runWorkflow(ctx, key, input, { async = false } = {}) {
  const id = ctx.sim.workflows[key];
  if (!id || !ctx.sim.apiKey) throw new AppError('WORKFLOW_NOT_CONFIGURED', `Workflow "${key}" is not configured on this gateway.`, 503);
  let res;
  try {
    res = await ctx.fetch(`${ctx.sim.base}/workflows/${encodeURIComponent(id)}/execute`, {
      method: 'POST', headers: { 'X-API-Key': ctx.sim.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { ...input, tenant_id: ctx.tenantId }, ...(async && { async: true }) }),
      signal: AbortSignal.timeout(async ? 30000 : 290000),
    });
  } catch {
    throw new AppError('WORKFLOW_UNREACHABLE', 'Could not reach the workflow engine.', 502);
  }
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  const out = body?.data?.output ?? body?.output ?? body?.data ?? body;
  if (res.status === 422 || out?.status === 'failed')
    throw new AppError(out?.error || 'WORKFLOW_FAILED', `Workflow failed at stage "${out?.stage || 'unknown'}".`, 422, { stage: out?.stage, retryable: out?.retryable });
  if (!res.ok) throw new AppError('WORKFLOW_ERROR', `Workflow engine returned HTTP ${res.status}.`, 502);
  return async ? { status: 'started', execution_id: body?.data?.executionId ?? body?.executionId ?? null } : out;
}

export const TOOLS = [
  {
    name: 'list_providers', rest: ['GET', '/api/v1/providers'],
    description: 'Step 1 of connecting data. Lists the data sources (billing and analytics required; CRM and support optional) and the providers supported for each.',
    inputSchema: obj({ source: { ...sourceEnum, description: 'Only list providers for this source.' } }),
    handler: async (_ctx, a) => ({ sources: listProviders(a.source) }),
  },
  {
    name: 'get_provider_inputs', rest: ['GET', '/api/v1/providers/:provider'],
    description: 'Step 2. Returns the exact inputs (fields, help text and where to find them) the customer must supply to connect the chosen provider.',
    inputSchema: obj({ provider: { ...providerEnum, description: 'Provider id from list_providers.' } }, ['provider']),
    handler: async (_ctx, a) => describeProvider(a.provider),
  },
  {
    name: 'connect_provider', rest: ['POST', '/api/v1/connections'],
    description: 'Step 3. Verifies the inputs with a live read-only call to the provider, stores them encrypted, and makes the provider the active connection for its source (replacing any previous one).',
    inputSchema: obj({ provider: providerEnum, inputs: { type: 'object', description: 'Field → value, as described by get_provider_inputs.', additionalProperties: { type: 'string' } } }, ['provider', 'inputs']),
    handler: async (ctx, a) => {
      const clean = validateInputs(a.provider, a.inputs);
      const { source } = PROVIDERS[a.provider];
      const test = await testCredentials(a.provider, clean, ctx.fetch);
      if (!test.ok) throw new AppError(test.error, `${PROVIDERS[a.provider].name} rejected the connection test.`, 422, { http_status: test.http_status, retryable: test.error !== 'PROVIDER_AUTH_FAILED' });
      const ref = newRef(ctx.tenantId, source);
      await ctx.db.tx(async (q) => {
        const old = await q('SELECT connection_ref FROM churnai.tenant_connections WHERE tenant_id = $1 AND source = $2', [ctx.tenantId, source]);
        await q('INSERT INTO churnai.connection_secrets(connection_ref, tenant_id, source, provider, ciphertext) VALUES ($1,$2,$3,$4,$5)',
          [ref, ctx.tenantId, source, a.provider, encrypt(ctx.key, ctx.tenantId, ref, clean)]);
        await q('SELECT churnai.save_connections($1::jsonb)', [JSON.stringify({ tenant_id: ctx.tenantId, connections: [{ source, provider: a.provider, connection_ref: ref }] })]);
        if (old.rows[0]) await q('DELETE FROM churnai.connection_secrets WHERE tenant_id = $1 AND connection_ref = $2', [ctx.tenantId, old.rows[0].connection_ref]);
      });
      const status = await connectionStatus(ctx);
      return { status: 'connected', source, provider: a.provider, ...status };
    },
  },
  {
    name: 'list_connections', rest: ['GET', '/api/v1/connections'],
    description: 'Shows which sources are connected, with which provider, and whether the required sources are complete.',
    inputSchema: obj(),
    handler: async (ctx) => connectionStatus(ctx),
  },
  {
    name: 'disconnect_source', rest: ['DELETE', '/api/v1/connections/:source'],
    description: 'Removes the connection (and its stored credentials) for one source.',
    inputSchema: obj({ source: sourceEnum }, ['source']),
    handler: async (ctx, a) => {
      if (!SOURCES[a.source]) throw new AppError('UNKNOWN_SOURCE', 'Unknown source.');
      await ctx.db.tx(async (q) => {
        await q('DELETE FROM churnai.tenant_connections WHERE tenant_id = $1 AND source = $2', [ctx.tenantId, a.source]);
        await q('DELETE FROM churnai.connection_secrets WHERE tenant_id = $1 AND source = $2', [ctx.tenantId, a.source]);
      });
      return { status: 'disconnected', source: a.source, ...(await connectionStatus(ctx)) };
    },
  },
  {
    name: 'propose_mapping', rest: ['POST', '/api/v1/mapping/propose'],
    description: 'Runs the "Sample & Map" workflow: samples ~50 records per connected source and proposes how fields and accounts join. The proposal must be confirmed with confirm_mapping.',
    inputSchema: obj(),
    handler: async (ctx) => runWorkflow(ctx, 'map', {}),
  },
  {
    name: 'get_mapping', rest: ['GET', '/api/v1/mapping'],
    description: 'Returns the latest proposed or confirmed field mapping.',
    inputSchema: obj(),
    handler: async (ctx) => {
      const r = await ctx.db.query('SELECT churnai.get_tenant_context($1::jsonb) AS c', [JSON.stringify({ tenant_id: ctx.tenantId })]);
      return { mapping: r.rows[0]?.c?.mapping ?? null };
    },
  },
  {
    name: 'confirm_mapping', rest: ['POST', '/api/v1/mapping/confirm'],
    description: 'Confirms a proposed mapping version so backfill and sync can use it.',
    inputSchema: obj({ version: { type: 'integer', minimum: 1 } }, ['version']),
    handler: async (ctx, a) => {
      if (!Number.isInteger(a.version) || a.version < 1) throw new AppError('VERSION_INVALID', 'version must be a positive integer.');
      const r = await ctx.db.query("SELECT status FROM churnai.tenant_mappings WHERE tenant_id = $1 AND version = $2", [ctx.tenantId, a.version]);
      if (!r.rows[0]) throw new AppError('MAPPING_NOT_FOUND', 'No mapping with that version.', 404);
      if (r.rows[0].status !== 'proposed') throw new AppError('MAPPING_NOT_PROPOSED', `Mapping is ${r.rows[0].status}.`, 409);
      await ctx.db.query('SELECT churnai.confirm_mapping($1, $2)', [ctx.tenantId, a.version]);
      return { status: 'confirmed', version: a.version };
    },
  },
  {
    name: 'start_backfill', rest: ['POST', '/api/v1/backfill'],
    description: 'Starts the "Backfill Controller" workflow in the background: ingests all billing customers (50 per batch) with analytics/CRM/support data, then scores them. Re-run to resume.',
    inputSchema: obj({ max_batches: { type: 'integer', minimum: 1, maximum: 200, description: 'Batches of 50 per run (default 40).' } }),
    handler: async (ctx, a) => runWorkflow(ctx, 'backfill', { kind: 'backfill', ...(a.max_batches && { max_batches: a.max_batches }) }, { async: true }),
  },
  {
    name: 'run_incremental_sync', rest: ['POST', '/api/v1/sync'],
    description: 'Starts an incremental sync now (only customers changed since the last sync). The daily schedule does this automatically.',
    inputSchema: obj({ max_batches: { type: 'integer', minimum: 1, maximum: 200 } }),
    handler: async (ctx, a) => runWorkflow(ctx, 'backfill', { kind: 'incremental', max_batches: a.max_batches || 200 }, { async: true }),
  },
  {
    name: 'score_accounts', rest: ['POST', '/api/v1/score'],
    description: 'Runs the "Score Batch" workflow: churn and expansion scores for up to 50 accounts (specific keys, or those flagged as needing scoring).',
    inputSchema: obj({ account_keys: { type: 'array', items: { type: 'string', maxLength: 256 }, maxItems: 50 } }),
    handler: async (ctx, a) => runWorkflow(ctx, 'score', a.account_keys ? { account_keys: a.account_keys } : {}),
  },
  {
    name: 'get_account_scores', rest: ['GET', '/api/v1/accounts'],
    description: 'Lists scored accounts, highest churn risk first (or highest expansion when sort=expansion).',
    inputSchema: obj({ sort: { type: 'string', enum: ['churn', 'expansion'] }, limit: { type: 'integer', minimum: 1, maximum: 200 } }),
    handler: async (ctx, a) => {
      const col = a.sort === 'expansion' ? 'expansion_score' : 'churn_score';
      const limit = Math.min(Math.max(parseInt(a.limit, 10) || 50, 1), 200);
      const r = await ctx.db.query(`SELECT account_key, churn_score, expansion_score, churn_confidence, expansion_confidence, score_reasons, scored_at
        FROM churnai.accounts WHERE tenant_id = $1 AND scored_at IS NOT NULL ORDER BY ${col} DESC NULLS LAST LIMIT $2`, [ctx.tenantId, limit]);
      return { accounts: r.rows };
    },
  },
];

async function connectionStatus(ctx) {
  const r = await ctx.db.query('SELECT source, provider, verified_at FROM churnai.tenant_connections WHERE tenant_id = $1 ORDER BY source', [ctx.tenantId]);
  const have = new Set(r.rows.map((x) => x.source));
  const missing = Object.entries(SOURCES).filter(([s, m]) => m.required && !have.has(s)).map(([s]) => s);
  return { connections: r.rows, missing_required: missing, ready_for_mapping: missing.length === 0 };
}

/** Gateway side used by the Sim "Connect Sources" workflow: re-test stored refs for a tenant. */
export async function gatewayTestConnections(ctx, body) {
  const tenant = body?.tenant_id; const list = Array.isArray(body?.connections) ? body.connections : [];
  const results = [];
  for (const c of list) {
    const row = (await ctx.db.query('SELECT provider, source, ciphertext FROM churnai.connection_secrets WHERE tenant_id = $1 AND connection_ref = $2',
      [tenant, c?.connection_ref])).rows[0];
    if (!row || row.provider !== c.provider || row.source !== c.source) { results.push({ source: c?.source, ok: false, error: 'CONNECTION_REF_UNKNOWN' }); continue; }
    const t = await testCredentials(row.provider, decrypt(ctx.key, tenant, c.connection_ref, row.ciphertext), ctx.fetch);
    results.push({ source: c.source, ok: t.ok, ...(t.error && { error: t.error }) });
  }
  return { results };
}

/** Load decrypted credentials for a tenant's ref (for gateway data endpoints). */
export async function resolveCredentials(ctx, tenantId, ref) {
  const row = (await ctx.db.query('SELECT provider, ciphertext FROM churnai.connection_secrets WHERE tenant_id = $1 AND connection_ref = $2', [tenantId, ref])).rows[0];
  if (!row) throw new AppError('CONNECTION_REF_UNKNOWN', 'Unknown connection_ref.', 404);
  return { provider: row.provider, inputs: decrypt(ctx.key, tenantId, ref, row.ciphertext) };
}
