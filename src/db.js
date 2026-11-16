'use strict';
const { Pool, types } = require('pg');

// Return DATE columns as 'YYYY-MM-DD' strings, not JS Dates shifted by time zone.
types.setTypeParser(1082, v => v);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://cc@localhost:5432/cc',
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: true } : undefined,
  max: Number(process.env.PG_POOL_MAX || 10)
});

const q = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
const many = async (text, params) => (await pool.query(text, params)).rows;

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

async function audit(actorId, action, target, detail, client) {
  await (client || pool).query(
    'INSERT INTO audit_log (actor_id, action, target, detail) VALUES ($1,$2,$3,$4)',
    [actorId || null, action, target || null, detail ? JSON.stringify(detail) : null]
  );
}

async function setting(key, fallback) {
  const r = await one('SELECT value FROM settings WHERE key=$1', [key]);
  return r ? r.value : fallback;
}

module.exports = { pool, q, one, many, tx, audit, setting };
