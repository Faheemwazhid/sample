// Provider catalog: what each provider needs from the customer and how to verify it.
// Every `test` builds a single read-only request (or token exchange) against the
// provider's fixed API host. Customer-supplied hostnames are restricted to a
// subdomain label so a tenant can never point the gateway at an arbitrary host.

const SUBDOMAIN = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const bearer = (t) => 'Bearer ' + t;

const secret = (name, label, help, pattern) => ({ name, label, type: 'secret', required: true, help, ...(pattern && { pattern }) });
const text = (name, label, help, pattern) => ({ name, label, type: 'string', required: true, help, ...(pattern && { pattern }) });
const choice = (name, label, options, dflt, help) => ({ name, label, type: 'enum', required: false, options, default: dflt, help });
const subdomain = (name, label, help) => text(name, label, help, SUBDOMAIN.source);

export const SOURCES = {
  billing: { label: 'Billing', required: true },
  analytics: { label: 'Product analytics', required: true },
  crm: { label: 'CRM', required: false },
  support: { label: 'Support', required: false },
};

export const PROVIDERS = {
  // ---- billing ------------------------------------------------------------
  stripe: {
    source: 'billing', name: 'Stripe', docs: 'https://docs.stripe.com/keys#create-restricted-api-secret-key',
    inputs: [secret('secret_key', 'Restricted API key', 'Dashboard → Developers → API keys → Create restricted key (read access to Customers, Subscriptions, Invoices).', '^(rk|sk)_(live|test)_[A-Za-z0-9]+$')],
    test: (i) => ({ url: 'https://api.stripe.com/v1/customers?limit=1', headers: { Authorization: bearer(i.secret_key) } }),
  },
  paddle: {
    source: 'billing', name: 'Paddle', docs: 'https://developer.paddle.com/api-reference/about/api-keys',
    inputs: [secret('api_key', 'API key', 'Paddle → Developer tools → Authentication → API keys (read-only).'),
      choice('environment', 'Environment', ['live', 'sandbox'], 'live')],
    test: (i) => ({ url: `https://${i.environment === 'sandbox' ? 'sandbox-api' : 'api'}.paddle.com/customers?per_page=1`, headers: { Authorization: bearer(i.api_key) } }),
  },
  chargebee: {
    source: 'billing', name: 'Chargebee', docs: 'https://www.chargebee.com/docs/2.0/api_keys.html',
    inputs: [subdomain('site', 'Site name', 'The part before .chargebee.com, e.g. "acme" for acme.chargebee.com.'),
      secret('api_key', 'Read-only API key', 'Settings → Configure Chargebee → API Keys → Add API key (read-only, all).')],
    test: (i) => ({ url: `https://${i.site}.chargebee.com/api/v2/customers?limit=1`, headers: { Authorization: basic(i.api_key, '') } }),
  },
  dodo_payments: {
    source: 'billing', name: 'Dodo Payments', docs: 'https://docs.dodopayments.com/api-reference/introduction',
    inputs: [secret('api_key', 'API key', 'Dashboard → Developer → API keys.'), choice('environment', 'Environment', ['live', 'test'], 'live')],
    test: (i) => ({ url: `https://${i.environment === 'test' ? 'test' : 'live'}.dodopayments.com/customers?page_size=1`, headers: { Authorization: bearer(i.api_key) } }),
  },
  // ---- analytics ----------------------------------------------------------
  amplitude: {
    source: 'analytics', name: 'Amplitude', docs: 'https://amplitude.com/docs/apis/authentication',
    inputs: [secret('api_key', 'API key', 'Settings → Projects → <project> → General → API Key.'),
      secret('secret_key', 'Secret key', 'Same page as the API key.'), choice('region', 'Data region', ['us', 'eu'], 'us')],
    test: (i) => ({ url: `https://${i.region === 'eu' ? 'analytics.eu.amplitude.com' : 'amplitude.com'}/api/2/events/list`, headers: { Authorization: basic(i.api_key, i.secret_key) } }),
  },
  mixpanel: {
    source: 'analytics', name: 'Mixpanel', docs: 'https://docs.mixpanel.com/docs/orgs-and-projects/service-accounts',
    inputs: [text('service_account_username', 'Service account username', 'Organization settings → Service accounts.'),
      secret('service_account_secret', 'Service account secret', 'Shown once when the service account is created.'),
      text('project_id', 'Project ID', 'Project settings → Overview → Project ID.', '^[0-9]{1,20}$'), choice('region', 'Data residency', ['us', 'eu', 'in'], 'us')],
    test: (i) => ({ url: `https://${{ eu: 'eu.mixpanel.com', in: 'in.mixpanel.com' }[i.region] || 'mixpanel.com'}/api/app/me`, headers: { Authorization: basic(i.service_account_username, i.service_account_secret) } }),
  },
  posthog: {
    source: 'analytics', name: 'PostHog', docs: 'https://posthog.com/docs/api#personal-api-keys',
    inputs: [secret('personal_api_key', 'Personal API key', 'Account settings → Personal API keys (read scopes for project, person, query).', '^phx_[A-Za-z0-9]+$'),
      text('project_id', 'Project ID', 'Project settings → Project ID.', '^[0-9]{1,20}$'), choice('region', 'Cloud region', ['us', 'eu'], 'us')],
    test: (i) => ({ url: `https://${i.region === 'eu' ? 'eu' : 'us'}.posthog.com/api/projects/${i.project_id}/`, headers: { Authorization: bearer(i.personal_api_key) } }),
  },
  // ---- crm ----------------------------------------------------------------
  hubspot: {
    source: 'crm', name: 'HubSpot', docs: 'https://developers.hubspot.com/docs/api/private-apps',
    inputs: [secret('access_token', 'Private app access token', 'Settings → Integrations → Private apps (scopes: crm.objects.companies.read, crm.objects.contacts.read, crm.objects.deals.read).', '^pat-[a-z0-9-]+$')],
    test: (i) => ({ url: 'https://api.hubapi.com/crm/v3/objects/companies?limit=1', headers: { Authorization: bearer(i.access_token) } }),
  },
  salesforce: {
    source: 'crm', name: 'Salesforce', docs: 'https://help.salesforce.com/s/articleView?id=sf.connected_app_client_credentials_setup.htm',
    inputs: [subdomain('my_domain', 'My Domain', 'The part before .my.salesforce.com, e.g. "acme" for acme.my.salesforce.com.'),
      text('client_id', 'Connected app consumer key', 'Connected app with the Client Credentials flow enabled.'),
      secret('client_secret', 'Connected app consumer secret', 'Same connected app.')],
    test: (i) => ({ url: `https://${i.my_domain}.my.salesforce.com/services/oauth2/token`, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: i.client_id, client_secret: i.client_secret }).toString() }),
  },
  pipedrive: {
    source: 'crm', name: 'Pipedrive', docs: 'https://pipedrive.readme.io/docs/how-to-find-the-api-token',
    inputs: [secret('api_token', 'API token', 'Personal preferences → API.')],
    test: (i) => ({ url: 'https://api.pipedrive.com/v1/users/me', headers: { 'x-api-token': i.api_token } }),
  },
  attio: {
    source: 'crm', name: 'Attio', docs: 'https://developers.attio.com/reference/authentication',
    inputs: [secret('access_token', 'Access token', 'Workspace settings → Developers → New integration (read scopes for records and objects).')],
    test: (i) => ({ url: 'https://api.attio.com/v2/self', headers: { Authorization: bearer(i.access_token) }, check: (j) => j?.active === true }),
  },
  // ---- support ------------------------------------------------------------
  zendesk: {
    source: 'support', name: 'Zendesk', docs: 'https://support.zendesk.com/hc/en-us/articles/4408889192858',
    inputs: [subdomain('subdomain', 'Subdomain', 'The part before .zendesk.com.'),
      text('email', 'Agent email', 'Email of the admin/agent that owns the token.', '^[^@\\s]+@[^@\\s]+$'),
      secret('api_token', 'API token', 'Admin Center → Apps and integrations → Zendesk API → API tokens.')],
    // /users/me answers 200 anonymously, so test an endpoint that rejects bad credentials.
    test: (i) => ({ url: `https://${i.subdomain}.zendesk.com/api/v2/tickets.json?page[size]=1`, headers: { Authorization: basic(`${i.email}/token`, i.api_token) } }),
  },
  intercom: {
    source: 'support', name: 'Intercom', docs: 'https://developers.intercom.com/docs/build-an-integration/learn-more/authentication',
    inputs: [secret('access_token', 'Access token', 'Developer Hub → Your app → Authentication.'), choice('region', 'Region', ['us', 'eu', 'au'], 'us')],
    test: (i) => ({ url: `https://${{ eu: 'api.eu.intercom.io', au: 'api.au.intercom.io' }[i.region] || 'api.intercom.io'}/me`, headers: { Authorization: bearer(i.access_token), Accept: 'application/json' } }),
  },
  freshdesk: {
    source: 'support', name: 'Freshdesk', docs: 'https://support.freshdesk.com/support/solutions/articles/215517',
    inputs: [subdomain('domain', 'Helpdesk domain', 'The part before .freshdesk.com.'), secret('api_key', 'API key', 'Profile settings → View API key.')],
    test: (i) => ({ url: `https://${i.domain}.freshdesk.com/api/v2/tickets?per_page=1`, headers: { Authorization: basic(i.api_key, 'X') } }),
  },
  helpscout: {
    source: 'support', name: 'Help Scout', docs: 'https://developer.helpscout.com/mailbox-api/overview/authentication/',
    inputs: [text('app_id', 'App ID', 'Your profile → My Apps → Create app.'), secret('app_secret', 'App secret', 'Same app.')],
    test: (i) => ({ url: 'https://api.helpscout.net/v2/oauth2/token', method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: i.app_id, client_secret: i.app_secret }) }),
  },
};

export class AppError extends Error {
  constructor(code, message, status = 400, extra) { super(message); this.code = code; this.status = status; this.extra = extra; }
}

/** Public description of a provider: never includes test logic. */
export function describeProvider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new AppError('UNKNOWN_PROVIDER', `Unknown provider "${id}". Call list_providers.`, 404);
  return { provider: id, name: p.name, source: p.source, source_required: SOURCES[p.source].required, docs: p.docs,
    inputs: p.inputs.map(({ name, label, type, required, options, default: d, help }) =>
      ({ name, label, type, required, ...(options && { options, default: d }), help })) };
}

export function listProviders(source) {
  if (source && !SOURCES[source]) throw new AppError('UNKNOWN_SOURCE', `source must be one of ${Object.keys(SOURCES).join(', ')}`);
  return Object.entries(SOURCES).filter(([s]) => !source || s === source).map(([s, meta]) => ({
    source: s, label: meta.label, required: meta.required,
    providers: Object.entries(PROVIDERS).filter(([, p]) => p.source === s).map(([id, p]) => ({ provider: id, name: p.name })),
  }));
}

/** Validate customer inputs against the provider's declared fields; returns a clean copy. */
export function validateInputs(id, raw) {
  const p = PROVIDERS[id];
  if (!p) throw new AppError('UNKNOWN_PROVIDER', `Unknown provider "${id}". Call list_providers.`, 404);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('INPUTS_REQUIRED', 'inputs must be an object of field → value.');
  const out = {}; const problems = [];
  for (const f of p.inputs) {
    let v = raw[f.name];
    if (v === undefined || v === null || v === '') {
      if (f.required) problems.push({ field: f.name, problem: 'missing' });
      else out[f.name] = f.default;
      continue;
    }
    if (typeof v !== 'string') { problems.push({ field: f.name, problem: 'must be a string' }); continue; }
    v = v.trim();
    if (v.length > 4096) problems.push({ field: f.name, problem: 'too long' });
    else if (f.options && !f.options.includes(v)) problems.push({ field: f.name, problem: `must be one of ${f.options.join(', ')}` });
    else if (f.pattern && !new RegExp(f.pattern).test(v)) problems.push({ field: f.name, problem: 'invalid format' });
    else out[f.name] = v;
  }
  const unknown = Object.keys(raw).filter((k) => !p.inputs.some((f) => f.name === k));
  for (const k of unknown) problems.push({ field: k, problem: 'unknown field' });
  if (problems.length) throw new AppError('INPUTS_INVALID', 'Some inputs are missing or invalid.', 400, { problems, expected: describeProvider(id).inputs });
  return out;
}

/** Make one live call to the provider. Returns {ok, error?}; never returns provider bodies or secrets. */
export async function testCredentials(id, inputs, fetchImpl = fetch) {
  const p = PROVIDERS[id];
  const req = p.test(inputs);
  let res;
  try {
    res = await fetchImpl(req.url, { method: req.method || 'GET', headers: req.headers, body: req.body, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  } catch {
    return { ok: false, error: 'PROVIDER_UNREACHABLE' };
  }
  if (res.status === 401 || res.status === 403 || (res.status === 400 && req.method === 'POST')) return { ok: false, error: 'PROVIDER_AUTH_FAILED', http_status: res.status };
  if (res.status === 404) return { ok: false, error: 'PROVIDER_ACCOUNT_NOT_FOUND', http_status: res.status };
  if (res.status === 429) return { ok: false, error: 'PROVIDER_RATE_LIMITED', http_status: res.status };
  if (res.status < 200 || res.status >= 300) return { ok: false, error: 'PROVIDER_ERROR', http_status: res.status };
  if (req.check) {
    let body = null; try { body = await res.json(); } catch { /* ignore */ }
    if (!req.check(body)) return { ok: false, error: 'PROVIDER_AUTH_FAILED', http_status: res.status };
  }
  return { ok: true };
}
