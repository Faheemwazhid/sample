// CRM and support adapters. Each `collect` lists the tenant's accounts in bulk (paged,
// capped) and returns flat records.
// CRM (one per company):  {id, name, domain, lifecycle_stage, owner, open_opportunities,
//                          expansion_interest, last_activity_at, properties}
// Support (one per requester): {id, email, email_domain, name, organization_id, open_tickets,
//                          tickets_28d, escalations_28d, csat, csat_rated, last_ticket_at}
import { AppError } from '../providers.js';
import { DAY, basic, bearer, domainOf, flat, iso, lower, request } from './util.js';

const MAX_RECORDS = 100000;
const cap = (arr) => { if (arr.length > MAX_RECORDS) throw new AppError('SOURCE_TOO_LARGE', `More than ${MAX_RECORDS} records.`, 502, { retryable: false }); };
const hostOf = (website) => { const w = lower(website); if (!w) return null; try { return new URL(w.includes('://') ? w : `https://${w}`).hostname.replace(/^www\./, ''); } catch { return null; } };

// ---- CRM -------------------------------------------------------------------
async function hubspot(ctx, c, { maxRecords = MAX_RECORDS }) {
  const props = ['name', 'domain', 'website', 'lifecyclestage', 'hubspot_owner_id', 'hs_num_open_deals', 'notes_last_updated', 'hs_lastmodifieddate', 'num_associated_contacts'];
  const out = []; let after = null;
  do {
    const q = new URLSearchParams({ limit: '100', properties: props.join(','), archived: 'false' }); if (after) q.set('after', after);
    const j = await request(ctx, `https://api.hubapi.com/crm/v3/objects/companies?${q}`, { headers: { Authorization: bearer(c.access_token) } });
    for (const r of j.results || []) {
      const p = r.properties || {};
      out.push({ id: String(r.id), name: p.name ?? null, domain: lower(p.domain) ?? hostOf(p.website), lifecycle_stage: p.lifecyclestage ?? null,
        owner: p.hubspot_owner_id ?? null, open_opportunities: p.hs_num_open_deals != null ? Number(p.hs_num_open_deals) : null, expansion_interest: null,
        last_activity_at: iso(p.notes_last_updated ?? p.hs_lastmodifieddate), properties: flat(p) });
    }
    after = j.paging?.next?.after ?? null; cap(out);
  } while (after && out.length < maxRecords);
  return out.slice(0, maxRecords);
}

async function salesforce(ctx, c, { maxRecords = MAX_RECORDS }) {
  const host = `https://${c.my_domain}.my.salesforce.com`;
  const tok = await request(ctx, `${host}/services/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.client_id, client_secret: c.client_secret }).toString() });
  const h = { Authorization: bearer(tok.access_token) };
  const soql = async (q, onRow) => {
    let url = `${host}/services/data/v60.0/query?q=${encodeURIComponent(q)}`; let n = 0;
    while (url) {
      const j = await request(ctx, url, { headers: h });
      for (const r of j.records || []) { onRow(r); n++; }
      if (n > MAX_RECORDS) cap({ length: n });
      url = j.done || n >= maxRecords ? null : new URL(j.nextRecordsUrl, host).origin === host ? new URL(j.nextRecordsUrl, host).toString() : null;
    }
  };
  const open = new Map();
  await soql('SELECT AccountId FROM Opportunity WHERE IsClosed = false AND AccountId != null', (r) => open.set(r.AccountId, (open.get(r.AccountId) || 0) + 1));
  const out = [];
  await soql('SELECT Id, Name, Website, Type, Industry, NumberOfEmployees, Owner.Name, LastActivityDate, LastModifiedDate FROM Account ORDER BY Id', (r) => {
    out.push({ id: r.Id, name: r.Name ?? null, domain: hostOf(r.Website), lifecycle_stage: r.Type ?? null, owner: r.Owner?.Name ?? null,
      open_opportunities: open.get(r.Id) ?? 0, expansion_interest: null, last_activity_at: iso(r.LastActivityDate ?? r.LastModifiedDate),
      properties: flat({ ...r, Owner: undefined, attributes: undefined }) });
  });
  return out.slice(0, maxRecords);
}

async function pipedrive(ctx, c, { maxRecords = MAX_RECORDS }) {
  const out = []; let start = 0;
  for (;;) {
    const j = await request(ctx, `https://api.pipedrive.com/v1/organizations?start=${start}&limit=500`, { headers: { 'x-api-token': c.api_token } });
    for (const o of j.data || []) {
      out.push({ id: String(o.id), name: o.name ?? null, domain: hostOf(o.website ?? null), lifecycle_stage: o.label != null ? String(o.label) : null,
        owner: o.owner_name ?? o.owner_id?.name ?? null, open_opportunities: o.open_deals_count ?? null, expansion_interest: null,
        last_activity_at: iso(o.last_activity_date ?? o.update_time), properties: flat(o) });
    }
    cap(out);
    const pg = j.additional_data?.pagination;
    if (!pg?.more_items_in_collection || out.length >= maxRecords) break;
    start = pg.next_start;
  }
  return out.slice(0, maxRecords);
}

// Attio values are arrays of typed objects; take the first value's useful scalar.
const attioValue = (arr) => {
  const v = Array.isArray(arr) ? arr[0] : null; if (!v) return null;
  return v.value ?? v.domain ?? v.email_address ?? v.option?.title ?? v.status?.title ?? v.currency_value ?? v.target_record_id ?? v.referenced_actor_id ?? v.full_name ?? null;
};
async function attio(ctx, c, { maxRecords = MAX_RECORDS }) {
  const out = [];
  for (let offset = 0; out.length < maxRecords; offset += 500) {
    const j = await request(ctx, 'https://api.attio.com/v2/objects/companies/records/query',
      { method: 'POST', headers: { Authorization: bearer(c.access_token), 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 500, offset }) });
    for (const r of j.data || []) {
      const p = Object.fromEntries(Object.entries(r.values || {}).map(([k, v]) => [k, attioValue(v)]));
      out.push({ id: r.id?.record_id ?? null, name: p.name ?? null, domain: lower(p.domains), lifecycle_stage: p.categories ?? null,
        owner: p.team ?? null, open_opportunities: null, expansion_interest: null,
        last_activity_at: iso(p.last_interaction ?? p.last_email_interaction ?? p.last_calendar_interaction), properties: flat(p) });
    }
    cap(out);
    if ((j.data || []).length < 500) break;
  }
  return out.slice(0, maxRecords);
}

// ---- Support ---------------------------------------------------------------
class Tickets {
  constructor(end) { this.cut = end - 28 * DAY; this.m = new Map(); }
  add(id, who, t) {
    if (id == null) return;
    let r = this.m.get(String(id));
    if (!r) {
      r = { id: String(id), email: null, name: null, organization_id: null, open_tickets: 0, tickets_28d: 0, escalations_28d: 0, csat_rated: 0, csat_good: 0, last: 0 };
      this.m.set(String(id), r);
      if (this.m.size > MAX_RECORDS) cap({ length: this.m.size });
    }
    for (const k of ['email', 'name', 'organization_id']) if (r[k] == null && who[k] != null) r[k] = String(who[k]);
    const created = Date.parse(t.created_at);
    if (t.open) r.open_tickets++;
    if (created >= this.cut) { r.tickets_28d++; if (t.escalated) r.escalations_28d++; }
    if (t.csat != null) { r.csat_rated++; if (t.csat) r.csat_good++; }
    if (created > r.last) r.last = created;
  }
  records() {
    return [...this.m.values()].map(({ last, csat_good, ...r }) => ({ ...r, email_domain: domainOf(r.email),
      csat: r.csat_rated ? Math.round((csat_good / r.csat_rated) * 100) / 100 : null, csat_good, last_ticket_at: last ? new Date(last).toISOString() : null }));
  }
}
const esc = (tags) => (tags || []).some((t) => /escalat/i.test(typeof t === 'string' ? t : t?.tag || t?.name || ''));

async function zendesk(ctx, c, { end, maxRecords = MAX_RECORDS }) {
  const base = `https://${c.subdomain}.zendesk.com`;
  const h = { Authorization: basic(`${c.email}/token`, c.api_token) };
  const agg = new Tickets(end); let n = 0;
  let url = `${base}/api/v2/incremental/tickets/cursor.json?start_time=${Math.floor((end - 28 * DAY) / 1000)}&include=users`;
  while (url) {
    const j = await request(ctx, url, { headers: h });
    const users = new Map((j.users || []).map((u) => [u.id, u]));
    for (const t of j.tickets || []) {
      if (t.status === 'deleted') continue;
      const u = users.get(t.requester_id) || {};
      agg.add(t.requester_id, { email: u.email, name: u.name, organization_id: t.organization_id }, { created_at: t.created_at,
        open: ['new', 'open', 'pending', 'hold'].includes(t.status), escalated: t.priority === 'urgent' || esc(t.tags),
        csat: ['good', 'bad'].includes(t.satisfaction_rating?.score) ? t.satisfaction_rating.score === 'good' : null });
      n++;
    }
    url = j.end_of_stream || !j.after_cursor || agg.m.size >= maxRecords
      ? null : `${base}/api/v2/incremental/tickets/cursor.json?cursor=${encodeURIComponent(j.after_cursor)}&include=users`;
  }
  return agg.records().slice(0, maxRecords);
}

async function intercom(ctx, c, { end, maxRecords = MAX_RECORDS }) {
  const host = `https://${{ eu: 'api.eu.intercom.io', au: 'api.au.intercom.io' }[c.region] || 'api.intercom.io'}`;
  const h = { Authorization: bearer(c.access_token), 'Content-Type': 'application/json', Accept: 'application/json', 'Intercom-Version': '2.11' };
  const agg = new Tickets(end); let after = null;
  do {
    const body = { query: { field: 'updated_at', operator: '>', value: Math.floor((end - 28 * DAY) / 1000) }, pagination: { per_page: 150, ...(after && { starting_after: after }) } };
    const j = await request(ctx, `${host}/conversations/search`, { method: 'POST', headers: h, body: JSON.stringify(body) });
    for (const cv of j.conversations || []) {
      const a = cv.source?.author || {};
      const id = cv.contacts?.contacts?.[0]?.id ?? a.id;
      const r = cv.conversation_rating?.rating;
      agg.add(id, { email: a.email, name: a.name, organization_id: null }, { created_at: iso(cv.created_at),
        open: cv.state !== 'closed', escalated: cv.priority === 'priority' || esc(cv.tags?.tags), csat: r != null ? r >= 4 : null });
    }
    after = j.pages?.next?.starting_after ?? null;
  } while (after && agg.m.size < maxRecords);
  return agg.records().slice(0, maxRecords);
}

async function freshdesk(ctx, c, { end, maxRecords = MAX_RECORDS }) {
  const h = { Authorization: basic(c.api_key, 'X') };
  const agg = new Tickets(end);
  for (let page = 1; page <= 300 && agg.m.size < maxRecords; page++) {
    const q = new URLSearchParams({ updated_since: iso(end - 28 * DAY), include: 'requester', per_page: '100', page: String(page), order_by: 'updated_at', order_type: 'asc' });
    const j = await request(ctx, `https://${c.domain}.freshdesk.com/api/v2/tickets?${q}`, { headers: h });
    for (const t of j || []) {
      agg.add(t.requester_id, { email: t.requester?.email, name: t.requester?.name, organization_id: t.company_id },
        { created_at: t.created_at, open: t.status === 2 || t.status === 3, escalated: t.priority === 4 || t.is_escalated === true || esc(t.tags), csat: null });
    }
    if (!Array.isArray(j) || j.length < 100) break;
  }
  return agg.records().slice(0, maxRecords);
}

async function helpscout(ctx, c, { end, maxRecords = MAX_RECORDS }) {
  const tok = await request(ctx, 'https://api.helpscout.net/v2/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: c.app_id, client_secret: c.app_secret }) });
  const h = { Authorization: bearer(tok.access_token) };
  const agg = new Tickets(end);
  const since = iso(end - 28 * DAY).replace(/\.\d{3}Z$/, 'Z');
  for (let page = 1; agg.m.size < maxRecords; page++) {
    const j = await request(ctx, `https://api.helpscout.net/v2/conversations?${new URLSearchParams({ status: 'all', modifiedSince: since, page: String(page) })}`, { headers: h });
    for (const cv of j._embedded?.conversations || []) {
      if (cv.status === 'spam') continue;
      const p = cv.primaryCustomer || {};
      agg.add(p.id, { email: p.email, name: [p.first, p.last].filter(Boolean).join(' ') || null, organization_id: null },
        { created_at: cv.createdAt, open: cv.status === 'active' || cv.status === 'pending', escalated: esc(cv.tags), csat: null });
    }
    if (!j.page || page >= j.page.totalPages) break;
  }
  return agg.records().slice(0, maxRecords);
}

export const CRM = { hubspot, salesforce, pipedrive, attio };
export const SUPPORT = { zendesk, intercom, freshdesk, helpscout };
