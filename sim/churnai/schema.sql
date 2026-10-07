-- ChurnAI shared Postgres schema used by the five Sim workflows
-- (Connect, Sample & Map, Backfill Controller, Score Batch, Incremental Sync).
-- Workflows call only the SECURITY DEFINER functions below with one jsonb argument
-- so tenant scoping and validation live in the database, not in workflow code.
-- Credentials are NOT stored here: tenant_connections keeps only an opaque
-- connection_ref that the connector gateway resolves from its secrets store.

CREATE SCHEMA IF NOT EXISTS churnai;

CREATE TABLE IF NOT EXISTS churnai.tenants (
  tenant_id      text PRIMARY KEY,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,
  sync_enabled   boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS churnai.tenant_connections (
  tenant_id      text NOT NULL REFERENCES churnai.tenants(tenant_id),
  source         text NOT NULL CHECK (source IN ('billing','analytics','crm','support')),
  provider       text NOT NULL,
  connection_ref text NOT NULL,
  verified_at    timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, source)
);

CREATE TABLE IF NOT EXISTS churnai.tenant_mappings (
  tenant_id    text NOT NULL REFERENCES churnai.tenants(tenant_id),
  version      integer NOT NULL,
  mapping      jsonb NOT NULL,
  status       text NOT NULL CHECK (status IN ('proposed','confirmed','superseded')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  PRIMARY KEY (tenant_id, version)
);

CREATE TABLE IF NOT EXISTS churnai.sync_jobs (
  job_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL REFERENCES churnai.tenants(tenant_id),
  kind            text NOT NULL CHECK (kind IN ('backfill','incremental')),
  status          text NOT NULL CHECK (status IN ('running','completed','failed')),
  cursor          text,
  window_start    timestamptz NOT NULL,
  window_end      timestamptz NOT NULL,
  mapping_version integer NOT NULL,
  batches_done    integer NOT NULL DEFAULT 0,
  accounts_done   integer NOT NULL DEFAULT 0,
  last_error      text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_jobs_one_running
  ON churnai.sync_jobs (tenant_id, kind) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS churnai.accounts (
  tenant_id         text NOT NULL REFERENCES churnai.tenants(tenant_id),
  account_key       text NOT NULL,              -- billing customer id
  source_ids        jsonb NOT NULL DEFAULT '{}', -- {analytics:..., crm:..., support:...}
  billing           jsonb NOT NULL,
  analytics         jsonb,
  crm               jsonb,
  support           jsonb,
  content_hash      text NOT NULL,
  ingested_at       timestamptz NOT NULL DEFAULT now(),
  needs_scoring     boolean NOT NULL DEFAULT true,
  churn_score       numeric CHECK (churn_score BETWEEN 0 AND 100),
  expansion_score   numeric CHECK (expansion_score BETWEEN 0 AND 100),
  churn_confidence  numeric,
  expansion_confidence numeric,
  score_reasons     jsonb,
  rubric_version    text,
  scored_at         timestamptz,
  PRIMARY KEY (tenant_id, account_key)
);
CREATE INDEX IF NOT EXISTS accounts_needs_scoring ON churnai.accounts (tenant_id) WHERE needs_scoring;

-- Workflow 1: Connect
CREATE OR REPLACE FUNCTION churnai.save_connections(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = churnai, pg_temp AS $$
DECLARE c jsonb;
BEGIN
  INSERT INTO tenants(tenant_id) VALUES (p->>'tenant_id') ON CONFLICT DO NOTHING;
  FOR c IN SELECT * FROM jsonb_array_elements(p->'connections') LOOP
    INSERT INTO tenant_connections(tenant_id, source, provider, connection_ref, verified_at)
    VALUES (p->>'tenant_id', c->>'source', c->>'provider', c->>'connection_ref', now())
    ON CONFLICT (tenant_id, source) DO UPDATE
      SET provider = EXCLUDED.provider, connection_ref = EXCLUDED.connection_ref, verified_at = now();
  END LOOP;
  RETURN jsonb_build_object('saved', true, 'tenant_id', p->>'tenant_id',
    'sources', (SELECT jsonb_agg(source ORDER BY source) FROM tenant_connections WHERE tenant_id = p->>'tenant_id'));
END $$;

-- Shared: connections + latest mapping for a tenant
CREATE OR REPLACE FUNCTION churnai.get_tenant_context(p jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = churnai, pg_temp AS $$
  SELECT jsonb_build_object(
    'tenant_id', t.tenant_id,
    'last_synced_at', t.last_synced_at,
    'connections', COALESCE((SELECT jsonb_agg(jsonb_build_object('source', source, 'provider', provider, 'connection_ref', connection_ref))
                             FROM tenant_connections WHERE tenant_id = t.tenant_id), '[]'),
    'mapping', (SELECT jsonb_build_object('version', version, 'status', status, 'mapping', mapping)
                FROM tenant_mappings WHERE tenant_id = t.tenant_id AND status <> 'superseded'
                ORDER BY version DESC LIMIT 1))
  FROM tenants t WHERE t.tenant_id = p->>'tenant_id';
$$;

-- Workflow 2: Sample & Map (saved as 'proposed'; a human confirms in the app)
CREATE OR REPLACE FUNCTION churnai.save_mapping(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = churnai, pg_temp AS $$
DECLARE v integer;
BEGIN
  SELECT COALESCE(max(version), 0) + 1 INTO v FROM tenant_mappings WHERE tenant_id = p->>'tenant_id';
  UPDATE tenant_mappings SET status = 'superseded' WHERE tenant_id = p->>'tenant_id' AND status = 'proposed';
  INSERT INTO tenant_mappings(tenant_id, version, mapping, status) VALUES (p->>'tenant_id', v, p->'mapping', 'proposed');
  RETURN jsonb_build_object('saved', true, 'tenant_id', p->>'tenant_id', 'version', v, 'status', 'proposed');
END $$;

CREATE OR REPLACE FUNCTION churnai.confirm_mapping(p_tenant text, p_version integer) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = churnai, pg_temp AS $$
  UPDATE tenant_mappings SET status = 'superseded' WHERE tenant_id = p_tenant AND status = 'confirmed';
  UPDATE tenant_mappings SET status = 'confirmed', confirmed_at = now() WHERE tenant_id = p_tenant AND version = p_version;
$$;

-- Workflows 3 & 5: start or resume a job (requires a confirmed mapping)
CREATE OR REPLACE FUNCTION churnai.start_job(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = churnai, pg_temp AS $$
DECLARE j sync_jobs; m tenant_mappings; t tenants;
BEGIN
  SELECT * INTO m FROM tenant_mappings WHERE tenant_id = p->>'tenant_id' AND status = 'confirmed' ORDER BY version DESC LIMIT 1;
  IF m IS NULL THEN RAISE EXCEPTION 'MAPPING_NOT_CONFIRMED'; END IF;
  SELECT * INTO t FROM tenants WHERE tenant_id = p->>'tenant_id';
  SELECT * INTO j FROM sync_jobs WHERE tenant_id = p->>'tenant_id' AND kind = p->>'kind' AND status = 'running';
  IF j IS NULL THEN -- resume the newest failed job unless a later job completed
    UPDATE sync_jobs SET status = 'running', last_error = NULL, updated_at = now()
    WHERE job_id = (SELECT f.job_id FROM sync_jobs f WHERE f.tenant_id = p->>'tenant_id' AND f.kind = p->>'kind' AND f.status = 'failed'
                      AND NOT EXISTS (SELECT 1 FROM sync_jobs c WHERE c.tenant_id = f.tenant_id AND c.kind = f.kind
                                      AND c.status = 'completed' AND c.started_at > f.started_at)
                    ORDER BY f.updated_at DESC LIMIT 1)
    RETURNING * INTO j;
  END IF;
  IF j IS NULL THEN
    INSERT INTO sync_jobs(tenant_id, kind, status, window_start, window_end, mapping_version)
    VALUES (p->>'tenant_id', p->>'kind', 'running',
            CASE WHEN p->>'kind' = 'incremental' THEN COALESCE(t.last_synced_at, now() - interval '28 days') ELSE now() - interval '28 days' END,
            now(), m.version)
    RETURNING * INTO j;
  END IF;
  RETURN jsonb_build_object('job_id', j.job_id, 'tenant_id', j.tenant_id, 'kind', j.kind, 'cursor', j.cursor,
    'window_start', j.window_start, 'window_end', j.window_end, 'mapping_version', m.version, 'mapping', m.mapping,
    'connections', (SELECT jsonb_agg(jsonb_build_object('source', source, 'provider', provider, 'connection_ref', connection_ref))
                    FROM tenant_connections WHERE tenant_id = j.tenant_id));
END $$;

-- Workflows 3 & 5: upsert one normalized batch and advance the cursor atomically.
-- Rows whose content_hash is unchanged are not flagged for re-scoring.
CREATE OR REPLACE FUNCTION churnai.ingest_batch(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = churnai, pg_temp AS $$
DECLARE a jsonb; changed text[] := '{}'; n integer := 0; prev text;
BEGIN
  PERFORM 1 FROM sync_jobs WHERE job_id = (p->>'job_id')::uuid AND tenant_id = p->>'tenant_id' AND status = 'running' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'JOB_NOT_RUNNING'; END IF;
  FOR a IN SELECT * FROM jsonb_array_elements(p->'accounts') LOOP
    SELECT content_hash INTO prev FROM accounts WHERE tenant_id = p->>'tenant_id' AND account_key = a->>'account_key';
    INSERT INTO accounts(tenant_id, account_key, source_ids, billing, analytics, crm, support, content_hash, ingested_at, needs_scoring)
    VALUES (p->>'tenant_id', a->>'account_key', COALESCE(a->'source_ids', '{}'), a->'billing', a->'analytics', a->'crm', a->'support',
            md5(concat_ws('|', a->'billing', a->'analytics', a->'crm', a->'support')), now(), true)
    ON CONFLICT (tenant_id, account_key) DO UPDATE SET
      source_ids = EXCLUDED.source_ids, billing = EXCLUDED.billing, analytics = EXCLUDED.analytics,
      crm = EXCLUDED.crm, support = EXCLUDED.support, ingested_at = now(),
      needs_scoring = accounts.needs_scoring OR accounts.content_hash IS DISTINCT FROM EXCLUDED.content_hash,
      content_hash = EXCLUDED.content_hash;
    IF prev IS DISTINCT FROM md5(concat_ws('|', a->'billing', a->'analytics', a->'crm', a->'support')) THEN
      changed := changed || (a->>'account_key');
    END IF;
    n := n + 1;
  END LOOP;
  UPDATE sync_jobs SET cursor = p->>'next_cursor', batches_done = batches_done + 1, accounts_done = accounts_done + n,
    status = CASE WHEN (p->>'has_more')::boolean THEN 'running' ELSE 'completed' END, updated_at = now()
  WHERE job_id = (p->>'job_id')::uuid;
  IF NOT (p->>'has_more')::boolean THEN
    UPDATE tenants SET last_synced_at = (SELECT window_end FROM sync_jobs WHERE job_id = (p->>'job_id')::uuid)
    WHERE tenant_id = p->>'tenant_id';
  END IF;
  RETURN jsonb_build_object('persisted', true, 'tenant_id', p->>'tenant_id', 'job_id', p->>'job_id',
    'upserted', n, 'changed_account_keys', to_jsonb(changed), 'has_more', (p->>'has_more')::boolean, 'cursor', p->>'next_cursor');
END $$;

CREATE OR REPLACE FUNCTION churnai.fail_job(p jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = churnai, pg_temp AS $$
  UPDATE sync_jobs SET status = 'failed', last_error = left(p->>'error', 500), updated_at = now()
  WHERE job_id = (p->>'job_id')::uuid AND tenant_id = p->>'tenant_id' AND status = 'running';
  SELECT jsonb_build_object('failed', true, 'job_id', p->>'job_id');
$$;

-- Workflow 4: Score Batch reads only from Postgres
CREATE OR REPLACE FUNCTION churnai.load_for_scoring(p jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = churnai, pg_temp AS $$
  SELECT jsonb_build_object('tenant_id', p->>'tenant_id', 'accounts', COALESCE(jsonb_agg(jsonb_build_object(
    'tenant_id', tenant_id, 'account_key', account_key, 'billing', billing, 'analytics', analytics,
    'crm', crm, 'support', support, 'content_hash', content_hash, 'ingested_at', ingested_at)), '[]'))
  FROM (SELECT * FROM accounts
        WHERE tenant_id = p->>'tenant_id'
          AND (CASE WHEN jsonb_typeof(p->'account_keys') = 'array'
                    THEN account_key IN (SELECT jsonb_array_elements_text(p->'account_keys'))
                    ELSE needs_scoring END)
        ORDER BY account_key LIMIT 50) s;
$$;

CREATE OR REPLACE FUNCTION churnai.record_score(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = churnai, pg_temp AS $$
BEGIN
  UPDATE accounts SET churn_score = (p->>'churn_score')::numeric, expansion_score = (p->>'expansion_score')::numeric,
    churn_confidence = (p->>'churn_confidence')::numeric, expansion_confidence = (p->>'expansion_confidence')::numeric,
    score_reasons = p->'reasons', rubric_version = p->>'rubric_version', scored_at = now(),
    -- only clear the flag if the data scored is still the current data
    needs_scoring = content_hash IS DISTINCT FROM p->>'content_hash'
  WHERE tenant_id = p->>'tenant_id' AND account_key = p->>'account_key';
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND'; END IF;
  RETURN jsonb_build_object('scored', true, 'tenant_id', p->>'tenant_id', 'account_key', p->>'account_key',
    'churn_score', (p->>'churn_score')::numeric, 'expansion_score', (p->>'expansion_score')::numeric);
END $$;

-- Workflow 5: tenants due for incremental sync
CREATE OR REPLACE FUNCTION churnai.tenants_due_for_sync(p jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = churnai, pg_temp AS $$
  SELECT jsonb_build_object('tenants', COALESCE(jsonb_agg(t.tenant_id ORDER BY t.tenant_id), '[]'))
  FROM tenants t
  WHERE t.sync_enabled AND t.last_synced_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM tenant_mappings m WHERE m.tenant_id = t.tenant_id AND m.status = 'confirmed')
    AND NOT EXISTS (SELECT 1 FROM sync_jobs j WHERE j.tenant_id = t.tenant_id AND j.status = 'running' AND j.kind = 'backfill');
$$;
