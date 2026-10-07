// Analytics adapters. `collect` makes bulk calls (one query or one export per day),
// never one call per customer, and returns one record per tracked user:
//   {id, email, email_domain, name, group_id, events_28d, events_prev_28d,
//    active_users_28d (1 if seen in the last 28d), last_seen_at, properties}
// Windows are anchored on `end`: [end-28d, end) and the previous 28 days before it.
// The enrich endpoint later rolls user records up to the mapped link key (e.g. domain).
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { AppError } from '../providers.js';
import { DAY, basic, bearer, domainOf, flat, iso, request } from './util.js';

const MAX_ENTITIES = 200000;

class Agg {
  constructor(end) { this.end = end; this.mid = end - 28 * DAY; this.start = end - 56 * DAY; this.m = new Map(); }
  add(id, ts, attrs = {}) {
    if (id == null || id === '' || !(ts >= this.start && ts < this.end)) return;
    let r = this.m.get(id);
    if (!r) {
      if (this.m.size >= MAX_ENTITIES) throw new AppError('SOURCE_TOO_LARGE', `More than ${MAX_ENTITIES} tracked users in the window.`, 502, { retryable: false });
      r = { id: String(id), email: null, name: null, group_id: null, events_28d: 0, events_prev_28d: 0, last: 0, properties: {} };
      this.m.set(id, r);
    }
    if (ts >= this.mid) r.events_28d++; else r.events_prev_28d++;
    if (ts > r.last) r.last = ts;
    for (const k of ['email', 'name', 'group_id']) if (r[k] == null && attrs[k] != null && attrs[k] !== '') r[k] = String(attrs[k]);
    if (attrs.properties) Object.assign(r.properties, flat(attrs.properties));
  }
  records() {
    return [...this.m.values()].map(({ last, ...r }) => ({ ...r, email_domain: domainOf(r.email), active_users_28d: r.events_28d > 0 ? 1 : 0,
      last_seen_at: last ? new Date(last).toISOString() : null }));
  }
}
const ymd = (t) => new Date(t).toISOString().slice(0, 10);

// ---- PostHog: one HogQL aggregate query, paged ---------------------------------
async function posthog(ctx, c, { end, maxEntities = MAX_ENTITIES }) {
  const url = `https://${c.region === 'eu' ? 'eu' : 'us'}.posthog.com/api/projects/${c.project_id}/query/`;
  const out = []; const pageSize = 10000;
  for (let offset = 0; out.length < maxEntities; offset += pageSize) {
    const body = { query: { kind: 'HogQLQuery', values: { start: iso(end - 56 * DAY), mid: iso(end - 28 * DAY), end: iso(end) },
      query: `SELECT person_id, any(distinct_id), any(person.properties.email), any(person.properties.name), any(properties.$group_0),
        countIf(timestamp >= toDateTime({mid})), countIf(timestamp < toDateTime({mid})), max(timestamp)
        FROM events WHERE timestamp >= toDateTime({start}) AND timestamp < toDateTime({end})
        GROUP BY person_id ORDER BY person_id LIMIT ${pageSize} OFFSET ${offset}` } };
    const j = await request(ctx, url, { method: 'POST', headers: { Authorization: bearer(c.personal_api_key), 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeout: 120000 });
    const rows = j.results || [];
    for (const [pid, did, email, name, group, e28, eprev, last] of rows)
      out.push({ id: String(pid), distinct_id: did ?? null, email: email ?? null, email_domain: domainOf(email), name: name ?? null, group_id: group ?? null,
        events_28d: Number(e28) || 0, events_prev_28d: Number(eprev) || 0, active_users_28d: Number(e28) > 0 ? 1 : 0, last_seen_at: iso(last), properties: {} });
    if (rows.length < pageSize) break;
  }
  return out.slice(0, maxEntities);
}

// ---- Mixpanel: raw export (streamed JSONL) + profile lookup for emails ---------
async function* lines(res) {
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) yield l; }
  }
  if (buf.trim()) yield buf.trim();
}

async function mixpanel(ctx, c, { end, days = 56 }) {
  const dataHost = { eu: 'data-eu.mixpanel.com', in: 'data-in.mixpanel.com' }[c.region] || 'data.mixpanel.com';
  const apiHost = { eu: 'eu.mixpanel.com', in: 'in.mixpanel.com' }[c.region] || 'mixpanel.com';
  const auth = { Authorization: basic(c.service_account_username, c.service_account_secret) };
  const agg = new Agg(end);
  const q = new URLSearchParams({ project_id: c.project_id, from_date: ymd(end - days * DAY), to_date: ymd(end - 1) });
  const res = await request(ctx, `https://${dataHost}/api/2.0/export?${q}`, { headers: { ...auth, Accept: 'text/plain' }, timeout: 600000 }, { raw: true });
  for await (const l of lines(res)) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    const p = e.properties || {};
    agg.add(p.distinct_id, Number(p.time) * 1000, { group_id: p.company_id ?? p.$group_id ?? null });
  }
  const recs = agg.records();
  const byId = new Map(recs.map((r) => [r.id, r]));
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += 1000) {
    const form = new URLSearchParams({ distinct_ids: JSON.stringify(ids.slice(i, i + 1000)), output_properties: JSON.stringify(['$email', '$name']) });
    const j = await request(ctx, `https://${apiHost}/api/query/engage?project_id=${encodeURIComponent(c.project_id)}`,
      { method: 'POST', headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    for (const p of j.results || []) {
      const r = byId.get(String(p.$distinct_id)); if (!r) continue;
      r.email = p.$properties?.$email ?? r.email; r.name = p.$properties?.$name ?? r.name; r.email_domain = domainOf(r.email);
    }
  }
  return recs;
}

// ---- Amplitude: Export API, one zip of gzipped JSONL per day -------------------
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new AppError('PROVIDER_BAD_RESPONSE', 'Amplitude export is not a zip archive.', 502);
  const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff) throw new AppError('PROVIDER_BAD_RESPONSE', 'Zip64 exports are not supported.', 502);
  const files = [];
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new AppError('PROVIDER_BAD_RESPONSE', 'Corrupt zip directory.', 502);
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const lo = buf.readUInt32LE(p + 42); const name = buf.toString('utf8', p + 46, p + 46 + nl);
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const data = buf.subarray(start, start + size);
    if (!name.endsWith('/')) files.push({ name, data: method === 8 ? inflateRawSync(data) : method === 0 ? data : null });
    p += 46 + nl + xl + cl;
  }
  return files.filter((f) => f.data);
}

async function amplitude(ctx, c, { end, days = 56 }) {
  const host = c.region === 'eu' ? 'analytics.eu.amplitude.com' : 'amplitude.com';
  const agg = new Agg(end);
  const day = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
  for (let t = end - days * DAY; t < end; t += DAY) {
    const res = await request(ctx, `https://${host}/api/2/export?start=${day(t)}T00&end=${day(t)}T23`,
      { headers: { Authorization: basic(c.api_key, c.secret_key) }, timeout: 600000 }, { raw: true, notFoundOk: true });
    if (!res) continue; // 404 = no data that day
    for (const f of unzip(Buffer.from(await res.arrayBuffer()))) {
      const text = (f.name.endsWith('.gz') ? gunzipSync(f.data) : f.data).toString('utf8');
      for (const l of text.split('\n')) {
        if (!l.trim()) continue;
        let e; try { e = JSON.parse(l); } catch { continue; }
        const up = e.user_properties || {};
        const grp = e.groups && Object.values(e.groups)[0];
        agg.add(e.user_id ?? e.device_id ?? e.amplitude_id, Date.parse(String(e.event_time).replace(' ', 'T') + 'Z'),
          { email: up.email ?? up.Email ?? (/@/.test(e.user_id || '') ? e.user_id : null), name: up.name ?? null, group_id: Array.isArray(grp) ? grp[0] : grp ?? null });
      }
    }
  }
  return agg.records();
}

export const ANALYTICS = { posthog, mixpanel, amplitude };
