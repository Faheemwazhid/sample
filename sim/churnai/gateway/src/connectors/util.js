// Shared helpers for provider data connectors. Every request goes to a host fixed by
// the provider adapter; customer input can only fill a validated subdomain label.
import { AppError } from '../providers.js';

export const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
export const bearer = (t) => 'Bearer ' + t;
export const DAY = 86400000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch → Response with provider error mapping and bounded retry on 429/5xx. */
export async function request(ctx, url, init = {}, { attempts = 3, raw = false, notFoundOk = false } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    let res;
    try {
      res = await ctx.fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(init.timeout || 60000) });
    } catch {
      last = new AppError('PROVIDER_UNREACHABLE', `Could not reach ${new URL(url).host}.`, 502, { retryable: true });
      await sleep(ctx.retryDelayMs ?? 500 * (i + 1));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers?.get?.('retry-after'));
      last = new AppError(res.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_ERROR', `${new URL(url).host} returned HTTP ${res.status}.`, 502, { retryable: true, http_status: res.status });
      await sleep(ctx.retryDelayMs ?? Math.min((Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** i), 30000));
      continue;
    }
    if (res.status === 404 && notFoundOk) return null;
    if (res.status === 401 || res.status === 403) throw new AppError('PROVIDER_AUTH_FAILED', `${new URL(url).host} rejected the stored credentials.`, 502, { retryable: false, http_status: res.status });
    if (res.status < 200 || res.status >= 300) throw new AppError('PROVIDER_ERROR', `${new URL(url).host} returned HTTP ${res.status}.`, 502, { retryable: false, http_status: res.status });
    if (raw) return res;
    try { return await res.json(); } catch { throw new AppError('PROVIDER_BAD_RESPONSE', `${new URL(url).host} returned non-JSON.`, 502, { retryable: true }); }
  }
  throw last;
}

export const iso = (v) => {
  if (v == null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
export const major = (minor, currency) => (minor == null ? null : Number(minor) / (ZERO_DECIMAL.has(String(currency || '').toLowerCase()) ? 1 : 100));

/** Convert an amount billed every `count` `interval`s to a monthly amount. */
export function monthly(amount, interval, count = 1) {
  if (amount == null || !Number.isFinite(Number(amount))) return null;
  const per = { day: 365 / 12, week: 52 / 12, month: 1, year: 1 / 12 }[String(interval || 'month').toLowerCase()];
  if (!per) return null;
  return Math.round((Number(amount) * per / (Number(count) || 1)) * 100) / 100;
}

/** Billing statuses ChurnAI keeps. Providers map their own states onto these. */
export const KEEP = ['active', 'trialing', 'non_renewing'];

export const lower = (v) => (v == null ? null : String(v).trim().toLowerCase() || null);
export const domainOf = (email) => { const e = lower(email); return e && e.includes('@') ? e.split('@').pop() : null; };
export const flat = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v == null || ['string', 'number', 'boolean'].includes(typeof v)));
