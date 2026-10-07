// Billing adapters. Billing is the source of truth: a page returns at most `limit`
// customers whose subscription is active, trialing or non-renewing, as flat records:
//   {id, email, email_domain, name, subscription_id, status, provider_status, plan, mrr,
//    currency, trial_end, current_period_end, cancel_at_period_end, seats, created_at, metadata}
// `mrr` is in major currency units per month. Cursors are opaque strings owned by the adapter.
import { AppError } from '../providers.js';
import { KEEP, basic, bearer, domainOf, flat, iso, major, monthly, request } from './util.js';

const rec = (r) => ({ ...r, email_domain: domainOf(r.email), metadata: flat(r.metadata) });

/** Merge several subscriptions of the same customer within one page. */
function dedupe(rows) {
  const by = new Map();
  for (const r of rows) {
    const p = by.get(r.id);
    if (!p) { by.set(r.id, r); continue; }
    p.mrr = (p.mrr ?? 0) + (r.mrr ?? 0);
    p.seats = (p.seats ?? 0) + (r.seats ?? 0) || null;
    if (KEEP.indexOf(r.status) < KEEP.indexOf(p.status)) Object.assign(p, { status: r.status, provider_status: r.provider_status, plan: r.plan });
    p.current_period_end = [p.current_period_end, r.current_period_end].filter(Boolean).sort().pop() ?? null;
  }
  return [...by.values()];
}
const want = (statuses) => new Set(statuses?.length ? statuses : KEEP);

// ---- Stripe: walk subscriptions per status (trialing, then active) -------------
async function stripePage(ctx, c, { cursor, limit, statuses }) {
  const keep = want(statuses);
  const phases = ['trialing', 'active'].filter((s) => keep.has(s) || (s === 'active' && keep.has('non_renewing')));
  let [phase, after] = cursor ? String(cursor).split('|') : [phases[0], ''];
  if (!phases.includes(phase)) throw new AppError('CURSOR_INVALID', 'Unknown cursor.', 400);
  const q = new URLSearchParams({ status: phase, limit: String(limit) });
  q.append('expand[]', 'data.customer');
  if (after) q.set('starting_after', after);
  const j = await request(ctx, `https://api.stripe.com/v1/subscriptions?${q}`, { headers: { Authorization: bearer(c.secret_key) } });
  const rows = [];
  for (const s of j.data || []) {
    const cust = typeof s.customer === 'object' ? s.customer : { id: s.customer };
    if (cust.deleted) continue;
    const status = s.status === 'trialing' ? 'trialing' : s.cancel_at_period_end || s.cancel_at ? 'non_renewing' : 'active';
    if (!keep.has(status)) continue;
    const items = s.items?.data || [];
    const cur = s.currency || items[0]?.price?.currency;
    const mrr = items.reduce((n, it) => n + (monthly(major((it.price?.unit_amount ?? Number(it.price?.unit_amount_decimal)) * (it.quantity ?? 1), cur),
      it.price?.recurring?.interval, it.price?.recurring?.interval_count) ?? 0), 0);
    rows.push(rec({ id: cust.id, email: cust.email ?? null, name: cust.name ?? null, subscription_id: s.id, status, provider_status: s.status,
      plan: items[0]?.price?.nickname || items[0]?.price?.lookup_key || items[0]?.price?.product || null, mrr, currency: cur ?? null,
      trial_end: iso(s.trial_end), current_period_end: iso(s.current_period_end ?? items[0]?.current_period_end),
      cancel_at_period_end: status === 'non_renewing', seats: items.reduce((n, it) => n + (it.quantity ?? 0), 0) || null,
      created_at: iso(cust.created ?? s.created), metadata: { ...cust.metadata, ...s.metadata } }));
  }
  const last = j.data?.at(-1)?.id;
  const i = phases.indexOf(phase);
  const next = j.has_more && last ? `${phase}|${last}` : i + 1 < phases.length ? `${phases[i + 1]}|` : null;
  return { customers: dedupe(rows), next_cursor: next, has_more: next !== null };
}

// ---- Chargebee: subscriptions with status[in] filter, offset pagination ---------
async function chargebeePage(ctx, c, { cursor, limit, statuses }) {
  const keep = want(statuses);
  const cb = { active: 'active', trialing: 'in_trial', non_renewing: 'non_renewing' };
  const q = new URLSearchParams({ limit: String(limit), 'status[in]': JSON.stringify([...keep].map((s) => cb[s]).filter(Boolean)), 'sort_by[asc]': 'created_at' });
  if (cursor) q.set('offset', cursor);
  const j = await request(ctx, `https://${c.site}.chargebee.com/api/v2/subscriptions?${q}`, { headers: { Authorization: basic(c.api_key, '') } });
  const rows = (j.list || []).map(({ subscription: s = {}, customer: cu = {} }) => {
    const status = { in_trial: 'trialing', non_renewing: 'non_renewing', active: 'active' }[s.status];
    const items = s.subscription_items || [];
    return status && keep.has(status) ? rec({ id: cu.id ?? s.customer_id, email: cu.email ?? null,
      name: [cu.company, [cu.first_name, cu.last_name].filter(Boolean).join(' ')].find(Boolean) || null,
      subscription_id: s.id, status, provider_status: s.status,
      plan: items.find((x) => x.item_type === 'plan')?.item_price_id ?? s.plan_id ?? null,
      mrr: s.mrr != null ? major(s.mrr, s.currency_code) : null, currency: s.currency_code ?? null,
      trial_end: iso(s.trial_end), current_period_end: iso(s.current_term_end), cancel_at_period_end: status === 'non_renewing',
      seats: items.find((x) => x.item_type === 'plan')?.quantity ?? s.plan_quantity ?? null, created_at: iso(cu.created_at ?? s.created_at),
      metadata: { ...(cu.meta_data || {}), ...(s.meta_data || {}), ...Object.fromEntries(Object.entries(cu).filter(([k]) => k.startsWith('cf_'))) } }) : null;
  }).filter(Boolean);
  return { customers: dedupe(rows), next_cursor: j.next_offset ?? null, has_more: !!j.next_offset };
}

// ---- Paddle Billing: subscriptions + one batched customer lookup per page -------
async function paddlePage(ctx, c, { cursor, limit, statuses }) {
  const keep = want(statuses);
  const host = `https://${c.environment === 'sandbox' ? 'sandbox-api' : 'api'}.paddle.com`;
  const h = { Authorization: bearer(c.api_key) };
  const st = [...new Set([...keep].map((s) => (s === 'trialing' ? 'trialing' : 'active')))];
  const q = new URLSearchParams({ status: st.join(','), per_page: String(limit), order_by: 'id[ASC]' });
  if (cursor) q.set('after', cursor);
  const j = await request(ctx, `${host}/subscriptions?${q}`, { headers: h });
  const subs = j.data || [];
  const ids = [...new Set(subs.map((s) => s.customer_id).filter(Boolean))];
  const customers = new Map();
  if (ids.length) {
    const cj = await request(ctx, `${host}/customers?${new URLSearchParams({ id: ids.join(','), per_page: String(Math.max(ids.length, 1)) })}`, { headers: h });
    for (const cu of cj.data || []) customers.set(cu.id, cu);
  }
  const rows = [];
  for (const s of subs) {
    const status = s.status === 'trialing' ? 'trialing' : s.scheduled_change?.action === 'cancel' ? 'non_renewing' : 'active';
    if (!keep.has(status)) continue;
    const cu = customers.get(s.customer_id) || {};
    const items = s.items || [];
    const mrr = items.reduce((n, it) => n + (monthly(major(Number(it.price?.unit_price?.amount ?? 0) * (it.quantity ?? 1), s.currency_code),
      it.price?.billing_cycle?.interval ?? s.billing_cycle?.interval, it.price?.billing_cycle?.frequency ?? s.billing_cycle?.frequency) ?? 0), 0);
    rows.push(rec({ id: s.customer_id, email: cu.email ?? null, name: cu.name ?? null, subscription_id: s.id, status, provider_status: s.status,
      plan: items[0]?.price?.name || items[0]?.price?.description || items[0]?.price?.id || null, mrr, currency: s.currency_code ?? null,
      trial_end: iso(items.find((it) => it.trial_dates)?.trial_dates?.ends_at), current_period_end: iso(s.current_billing_period?.ends_at),
      cancel_at_period_end: status === 'non_renewing', seats: items.reduce((n, it) => n + (it.quantity ?? 0), 0) || null,
      created_at: iso(cu.created_at ?? s.created_at), metadata: { ...(cu.custom_data || {}), ...(s.custom_data || {}) } }));
  }
  const hasMore = j.meta?.pagination?.has_more === true && subs.length > 0;
  return { customers: dedupe(rows), next_cursor: hasMore ? subs.at(-1).id : null, has_more: hasMore };
}

// ---- Dodo Payments: page-number pagination over active subscriptions -----------
async function dodoPage(ctx, c, { cursor, limit, statuses }) {
  const keep = want(statuses);
  const page = cursor ? Number(cursor) : 0;
  if (!Number.isInteger(page) || page < 0) throw new AppError('CURSOR_INVALID', 'Unknown cursor.', 400);
  const q = new URLSearchParams({ status: 'active', page_size: String(limit), page_number: String(page) });
  const j = await request(ctx, `https://${c.environment === 'test' ? 'test' : 'live'}.dodopayments.com/subscriptions?${q}`, { headers: { Authorization: bearer(c.api_key) } });
  const items = j.items || [];
  const now = ctx.now?.() ?? Date.now();
  const rows = [];
  for (const s of items) {
    const trialEnd = s.trial_period_days ? new Date(new Date(s.created_at).getTime() + s.trial_period_days * 86400000) : null;
    const status = trialEnd && trialEnd.getTime() > now ? 'trialing' : s.cancel_at_next_billing_date ? 'non_renewing' : 'active';
    if (!keep.has(status)) continue;
    const cu = s.customer || {};
    rows.push(rec({ id: cu.customer_id ?? s.customer_id, email: cu.email ?? null, name: cu.name ?? null, subscription_id: s.subscription_id,
      status, provider_status: s.status, plan: s.product_id ?? null,
      mrr: monthly(major(s.recurring_pre_tax_amount, s.currency), s.payment_frequency_interval, s.payment_frequency_count),
      currency: s.currency ?? null, trial_end: iso(trialEnd), current_period_end: iso(s.next_billing_date),
      cancel_at_period_end: status === 'non_renewing', seats: s.quantity ?? null, created_at: iso(s.created_at), metadata: s.metadata }));
  }
  const hasMore = items.length === limit;
  return { customers: dedupe(rows), next_cursor: hasMore ? String(page + 1) : null, has_more: hasMore };
}

export const BILLING = { stripe: stripePage, chargebee: chargebeePage, paddle: paddlePage, dodo_payments: dodoPage };
