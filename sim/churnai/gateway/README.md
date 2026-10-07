# ChurnAI gateway: multi-tenant REST API + MCP server

One small Node service in front of the Sim workflows. Each customer (tenant) gets an
API key; every call is scoped to that tenant, so `tenant_id` is never a caller input.
The same 12 tools are exposed as REST endpoints and as MCP tools.

| Tool (MCP) | REST | What it does |
| --- | --- | --- |
| `list_providers` | `GET /api/v1/providers[?source=]` | Sources and their providers |
| `get_provider_inputs` | `GET /api/v1/providers/{provider}` | Inputs the customer must supply, with help text |
| `connect_provider` | `POST /api/v1/connections` `{provider, inputs}` | Live-tests, encrypts and stores the credentials |
| `list_connections` | `GET /api/v1/connections` | Connected sources + `missing_required` |
| `disconnect_source` | `DELETE /api/v1/connections/{source}` | Removes a connection and its secret |
| `propose_mapping` | `POST /api/v1/mapping/propose` | Sim workflow 2 · Sample & Map |
| `get_mapping` | `GET /api/v1/mapping` | Latest mapping |
| `confirm_mapping` | `POST /api/v1/mapping/confirm` `{version}` | Confirms a proposed mapping |
| `start_backfill` | `POST /api/v1/backfill` | Sim workflow 3 · Backfill (async) |
| `run_incremental_sync` | `POST /api/v1/sync` | Workflow 3 in incremental mode (workflow 5 runs it daily) |
| `score_accounts` | `POST /api/v1/score` | Sim workflow 4 · Score Batch |
| `get_account_scores` | `GET /api/v1/accounts?sort=churn\|expansion` | Scored accounts |

`GET /api/v1/tools` returns the same list with JSON schemas.

## Connect flow

1. `list_providers`: billing (Stripe, Paddle, Chargebee, Dodo Payments) and analytics
   (Amplitude, Mixpanel, PostHog) are required. CRM (HubSpot, Salesforce, Pipedrive, Attio)
   and support (Zendesk, Intercom, Freshdesk, Help Scout) are optional.
2. The customer picks a provider, then you call `get_provider_inputs`. For example, Stripe returns `secret_key`, and
   Chargebee returns `site` and `api_key`.
3. Ask the customer for exactly those inputs, then call `connect_provider`. Missing or malformed fields return
   `400 INPUTS_INVALID` with `problems` and the expected fields. Rejected credentials return
   `422 PROVIDER_AUTH_FAILED`. On success, the response shows `missing_required` and `ready_for_mapping`.

Credentials are AES-256-GCM encrypted (bound to tenant + ref) in `churnai.connection_secrets`. They are never
returned and never stored in Sim. Customer-supplied host parts are limited to a single subdomain label.

## Run

```bash
psql "$DATABASE_URL" -f sim/churnai/schema.sql -f sim/churnai/gateway.sql
cd sim/churnai/gateway && npm ci
DATABASE_URL=postgres://... \
CHURNAI_ENCRYPTION_KEY=$(openssl rand -base64 32) \
CHURNAI_ADMIN_TOKEN=...            # your backend uses this to provision tenants
CHURNAI_CONNECTOR_API_KEY=...      # same value as the Sim env var of that name
SIM_API_KEY=...                    # personal Sim key used to execute workflows
CHURNAI_WF_MAP=<id> CHURNAI_WF_BACKFILL=<id> CHURNAI_WF_SCORE=<id> \
npm start
npm test                           # end-to-end tests on in-memory Postgres
```

The Sim workflows must be **deployed** for the execute calls to work. Point Sim's
`CHURNAI_CONNECTOR_BASE_URL` at this service.

## Connector-gateway endpoints (called by Sim, `Authorization: Bearer $CHURNAI_CONNECTOR_API_KEY`)

| Endpoint | Workflow | Returns |
| --- | --- | --- |
| `POST /v1/connections/test` | 1 · Connect | `{results:[{source, ok, error?}]}` |
| `POST /v1/sample` `{tenant_id, connections, limit}` | 2 · Sample & Map | `{billing:[…], analytics:[…], crm:[…], support:[…]}`, up to 50 each. Source records that share a value with the billing sample come first, so link overlap can be measured. |
| `POST /v1/billing/customers` `{tenant_id, connection, cursor, limit, statuses}` | 3 · Backfill | `{customers:[…], next_cursor, has_more}`: active, trialing and non-renewing only |
| `POST /v1/billing/changes` | 3 · Incremental | Same billing page. `ingest_batch` re-scores only accounts whose content changed. |
| `POST /v1/enrich` `{tenant_id, connections, mapping, link_values, window_end}` | 3 · Backfill | One record per link value per source. For example, all users of `globex.com` are rolled into summed `events_28d`, `events_prev_28d`, `active_users_28d`, and the latest `last_seen_at`. |

Credentials are resolved from the tenant's own `connection_ref` (a ref from another tenant returns `404 CONNECTION_REF_UNKNOWN`)
and are never returned. Records are flat. Billing records include `id, email, email_domain, name, status, plan, mrr` (monthly, in major units),
`currency, trial_end, current_period_end, cancel_at_period_end, seats, created_at, metadata`. Analytics, CRM, and support records include
`email`/`email_domain`, `domain`, and the normalized metric fields named in the mapping prompt.

Analytics are pulled **in bulk** for the 56 days before `window_end`. PostHog uses one paged HogQL aggregate,
Mixpanel uses a streamed raw export plus a batched profile lookup, and Amplitude uses one Export API zip per day. Each export is cached per
(tenant, connection, window_end) for 2 hours, so all batches of one backfill job share a single export. CRM providers list companies
(HubSpot, Salesforce with open-opportunity counts, Pipedrive, Attio). Support providers aggregate tickets per requester over 28 days
(Zendesk incremental export, Intercom conversation search, Freshdesk, Help Scout). Provider 429 and 5xx responses are retried with backoff.
Results are capped at 200k analytics users and 100k CRM or support records per tenant. Above those caps, the endpoints return `SOURCE_TOO_LARGE`.

## Provision a customer (from your app's backend)

```bash
curl -X POST $GATEWAY/admin/tenants -H "Authorization: Bearer $CHURNAI_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"tenant_id":"acme_inc"}'
# → {"tenant_id":"acme_inc","api_key":"chk_..."}   (shown once; POST /admin/tenants/acme_inc/keys issues another)
```

## Customers connect the MCP server

Claude Code:

```bash
claude mcp add --transport http churnai https://<gateway-host>/mcp --header "Authorization: Bearer chk_..."
```

Claude Desktop / Cursor:

```json
{ "mcpServers": { "churnai": { "command": "npx",
  "args": ["-y", "mcp-remote", "https://<gateway-host>/mcp", "--header", "Authorization: Bearer chk_..."] } } }
```

Custom connectors in Claude on the web need an OAuth flow, which is not implemented yet. API-key headers work for
Claude Code, Claude Desktop (via mcp-remote), Cursor, and other MCP clients.
