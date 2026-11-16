'use strict';
// Loads CNB's real volunteer history from Galaxy Digital (2025 and 2026, exported Nov 16, 2026)
// into the pilot: the employee roster (names, market, branch, department, officer level) and
// approved volunteer hours. Approved by Eddie Montoya on Nov 16, 2026. No emails, phone numbers,
// birthdays, addresses or emergency contacts are included.
//
// Runs on every start and does nothing while the files are unchanged. When they change, it re-syncs:
// employees upsert by emp_no ("G-..." ids), people no longer in the file are set inactive, and all
// imported hours are replaced. The first run also retires the fictional sample employees and their
// sample hours so reports show real numbers. Demo sign-in accounts are kept.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { pool, q, tx } = require('../src/db');
const { parseCsv } = require('../src/util');

const DIR = path.join(__dirname, '..', 'data', 'galaxy');
const read = f => {
  const rows = parseCsv(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const head = rows[0];
  return rows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
};

async function importGalaxy({ log = console.log } = {}) {
  if (!fs.existsSync(path.join(DIR, 'roster.csv'))) return { skipped: true };
  await q(`ALTER TABLE hours ADD COLUMN IF NOT EXISTS import_key text`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS hours_import_key ON hours(import_key) WHERE import_key IS NOT NULL`);
  const hash = crypto.createHash('sha1').update(fs.readFileSync(path.join(DIR, 'roster.csv'))).update(fs.readFileSync(path.join(DIR, 'hours.csv'))).digest('hex');
  const prev = (await q(`SELECT value FROM settings WHERE key='galaxy_import'`)).rows[0];
  if (prev && prev.value && prev.value.hash === hash) { log('Galaxy history: already up to date.'); return { unchanged: true }; }
  const roster = read('roster.csv');
  const hours = read('hours.csv');
  const result = await tx(async c => {
    const mk = Object.fromEntries((await c.query('SELECT id, name FROM markets')).rows.map(r => [r.name, r.id]));
    const branch = {}; const dept = {};
    const branchId = async (name, marketId) => {
      if (!name) return null;
      if (!branch[name]) branch[name] = (await c.query(
        'INSERT INTO branches (name, market_id) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id', [name, marketId])).rows[0].id;
      return branch[name];
    };
    const deptId = async name => {
      if (!name) return null;
      if (!dept[name]) dept[name] = (await c.query(
        'INSERT INTO departments (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id', [name])).rows[0].id;
      return dept[name];
    };
    const first = !prev;
    if (first) {
      // Retire the fictional sample people (E####) and their sample hours. Demo accounts (D-...) stay.
      await c.query(`DELETE FROM hours WHERE employee_id IN (SELECT id FROM employees WHERE emp_no ~ '^E[0-9]+$') AND import_key IS NULL`);
      await c.query(`UPDATE employees SET active=false, updated_at=now() WHERE emp_no ~ '^E[0-9]+$'`);
    }
    const ids = {};
    for (const x of roster) {
      const m = mk[x.market] || mk['Permian Basin'];
      const r = await c.query(
        `INSERT INTO employees (emp_no, first_name, last_name, market_id, branch_id, department_id, title, officer, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (emp_no) DO UPDATE SET first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name, market_id=EXCLUDED.market_id,
           branch_id=EXCLUDED.branch_id, department_id=EXCLUDED.department_id, title=EXCLUDED.title, officer=EXCLUDED.officer,
           active=EXCLUDED.active, updated_at=now()
         RETURNING id`,
        [x.emp_no, x.first_name, x.last_name || '-', m, await branchId(x.branch, m), await deptId(x.department), x.title || null,
          x.officer === 'yes', x.active === 'yes']);
      ids[x.emp_no] = r.rows[0].id;
    }
    await c.query(`UPDATE employees SET active=false, updated_at=now() WHERE emp_no LIKE 'G-%' AND NOT (emp_no = ANY($1::text[]))`, [roster.map(x => x.emp_no)]);
    await c.query(`DELETE FROM hours WHERE import_key IS NOT NULL`);
    let added = 0;
    for (const h of hours) {
      const minutes = Math.round(Number(h.hours) * 60);
      if (!ids[h.emp_no] || !(minutes > 0) || minutes > 1440) continue;
      const r = await c.query(
        `INSERT INTO hours (employee_id, source, date, minutes, otype, org_name, details, status, import_key)
         VALUES ($1,'admin',$2,$3,$4,$5,$6,'approved',$7) ON CONFLICT (import_key) WHERE import_key IS NOT NULL DO NOTHING`,
        [ids[h.emp_no], h.date, minutes, h.type === 'bank' ? 'bank' : 'community', h.organization || null,
          (h.activity ? h.activity + ' ' : '') + '(Galaxy import)', h.import_key]);
      added += r.rowCount;
    }
    await c.query(`INSERT INTO settings (key, value) VALUES ('galaxy_import', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [JSON.stringify({ at: new Date().toISOString(), hash, people: roster.length, hours: hours.length })]);
    await c.query(`INSERT INTO audit_log (action, target, detail) VALUES ('galaxy.imported', 'roster+hours', $1)`,
      [JSON.stringify({ people: roster.length, hours_rows: hours.length, hash })]);
    if (first) {
      // Eddie, Nov 16 2026: Independent Sector's Texas value of volunteer time (2025), replacing the $30 placeholder.
      await c.query(`UPDATE settings SET value='34.99' WHERE key='impact_rate' AND value::text IN ('30','26')`);
    }
    return { first, people: roster.length, hoursAdded: added };
  });
  log(`Galaxy history: ${result.people} people on the roster, ${result.hoursAdded} hour records loaded${result.first ? ' (first import; sample people retired)' : ''}.`);
  return result;
}

if (require.main === module) {
  importGalaxy().then(() => pool.end()).catch(e => { console.error(e); process.exit(1); });
}
module.exports = { importGalaxy };
