-- Multi-tenant gateway objects (apply after schema.sql).
-- Tenant API keys are stored as SHA-256 hashes; provider credentials are
-- AES-256-GCM ciphertext keyed by CHURNAI_ENCRYPTION_KEY (never stored in Sim).

CREATE TABLE IF NOT EXISTS churnai.tenant_api_keys (
  key_hash   text PRIMARY KEY,
  tenant_id  text NOT NULL REFERENCES churnai.tenants(tenant_id),
  label      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS tenant_api_keys_tenant ON churnai.tenant_api_keys (tenant_id);

CREATE TABLE IF NOT EXISTS churnai.connection_secrets (
  connection_ref text PRIMARY KEY,
  tenant_id      text NOT NULL REFERENCES churnai.tenants(tenant_id),
  source         text NOT NULL,
  provider       text NOT NULL,
  ciphertext     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connection_secrets_tenant ON churnai.connection_secrets (tenant_id, source);
