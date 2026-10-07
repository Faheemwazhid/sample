import pg from 'pg';
import { createApp } from './server.js';
import { loadKey } from './vault.js';

const env = process.env;
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });
const db = {
  query: (text, params) => pool.query(text, params),
  tx: async (fn) => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn((t, p) => c.query(t, p)); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  },
};

const app = createApp({
  db, fetch, key: loadKey(env.CHURNAI_ENCRYPTION_KEY),
  adminToken: env.CHURNAI_ADMIN_TOKEN, gatewayKey: env.CHURNAI_CONNECTOR_API_KEY,
  sim: { base: env.SIM_API_BASE || 'https://www.sim.ai/api/v2', apiKey: env.SIM_API_KEY,
    workflows: { map: env.CHURNAI_WF_MAP, backfill: env.CHURNAI_WF_BACKFILL, score: env.CHURNAI_WF_SCORE } },
});
const port = Number(env.PORT || 8080);
app.listen(port, () => console.log(`churnai gateway listening on :${port}`));
