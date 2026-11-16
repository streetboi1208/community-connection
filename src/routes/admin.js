'use strict';
const express = require('express');
const { q, one, many, tx, audit, setting } = require('../db');
const A = require('../auth');
const { Bad, str, int, bool, isoDate, hhmm, oneOf, today, parseCsv, toCsv } = require('../util');

const r = express.Router();

// Every admin route needs a signed-in user with at least one role.
r.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  if (req.user.must_change) return res.status(403).json({ error: 'Please set a new password first.', mustChange: true });
  if (!A.isAdminish(req.user)) return res.status(403).json({ error: "You don't have access to that." });
  next();
});

// Market admins only act inside the market on their own profile.
function assertMarket(user, marketId) {
  const m = A.marketScope(user);
  if (m && Number(marketId) !== Number(m)) throw new Bad('That belongs to another market.', 403);
}
async function employeeInScope(user, id) {
  const e = await one('SELECT id, market_id, first_name, last_name, username, roles FROM employees WHERE id=$1', [id]);
  if (!e) throw new Bad('Employee not found.', 404);
  assertMarket(user, e.market_id);
  return e;
}

// ================= Opportunities =================
r.get('/opps', A.requirePerm('opps.create', 'rosters.view', 'kiosk.run'), async (req, res) => {
  const m = A.marketScope(req.user);
  const rows = await many(
    `SELECT o.id, o.otype, o.title, o.status, o.location, m.name AS market, n.name AS nonprofit, o.market_id,
            (SELECT min(date) FROM shifts WHERE opp_id=o.id) AS first_date,
            (SELECT max(date) FROM shifts WHERE opp_id=o.id) AS last_date,
            (SELECT COALESCE(sum(capacity),0)::int FROM shifts WHERE opp_id=o.id) AS cap,
            (SELECT count(*)::int FROM signups su JOIN shifts s ON s.id=su.shift_id WHERE s.opp_id=o.id) AS filled
       FROM opportunities o JOIN markets m ON m.id=o.market_id LEFT JOIN nonprofits n ON n.id=o.nonprofit_id
      WHERE ($1::int IS NULL OR o.market_id=$1) AND ($2 OR (SELECT max(date) FROM shifts WHERE opp_id=o.id) >= $3::date)
      ORDER BY first_date DESC NULLS FIRST, o.id DESC LIMIT 300`, [m, req.query.past === '1', today()]);
  res.json({ opps: rows });
});

r.get('/opps/:id', A.requirePerm('opps.create', 'rosters.view', 'kiosk.run'), async (req, res) => {
  const id = int(req.params.id, 'id', { min: 1 });
  const o = await one(`SELECT o.*, n.name AS nonprofit FROM opportunities o LEFT JOIN nonprofits n ON n.id=o.nonprofit_id WHERE o.id=$1`, [id]);
  if (!o) throw new Bad('Not found.', 404);
  assertMarket(req.user, o.market_id);
  const shifts = await many(
    `SELECT id, label, date, to_char(start_time,'HH24:MI') AS start, to_char(end_time,'HH24:MI') AS "end", capacity
       FROM shifts WHERE opp_id=$1 ORDER BY date, start_time`, [id]);
  res.json({ opp: o, shifts });
});

async function saveOpp(req, id) {
  const b = req.body || {};
  const otype = oneOf(b.otype || 'community', 'Type', ['community', 'bank', 'social']);
  // Marketing creates events only (CNB and off-the-clock), not volunteer opportunities.
  if (otype === 'community' && !A.can(req.user, 'opps.createVolunteer')) throw new Bad('Your role can create CNB and off-the-clock events, not volunteer opportunities.', 403);
  const marketId = int(b.market_id, 'Market', { min: 1 });
  assertMarket(req.user, marketId);
  const title = str(b.title, 'Title', { max: 120 });
  const location = str(b.location, 'Location', { max: 120 });
  const address = str(b.address, 'Address', { max: 200, required: false });
  const description = str(b.description, 'Description', { max: 4000, required: false }) || '';
  const status = oneOf(b.status || 'published', 'Status', ['draft', 'published', 'cancelled']);
  let nonprofitId = null;
  if (otype === 'community') {
    const npName = str(b.nonprofit, 'Nonprofit', { max: 120 });
    const np = await one('INSERT INTO nonprofits (name, market_id) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id', [npName, marketId]);
    nonprofitId = np.id;
  }
  const shifts = (Array.isArray(b.shifts) ? b.shifts : []).map((s, i) => {
    const start = hhmm(s.start, `Shift ${i + 1} start`), end = hhmm(s.end, `Shift ${i + 1} end`);
    if (end <= start) throw new Bad(`Shift ${i + 1} must end after it starts.`);
    return {
      id: s.id ? int(s.id, 'Shift id', { min: 1 }) : null,
      date: isoDate(s.date, `Shift ${i + 1} date`), start, end,
      capacity: int(s.capacity, `Shift ${i + 1} spots`, { min: 1, max: 5000 }),
      label: str(s.label, 'Shift label', { max: 60, required: false })
    };
  });
  if (!shifts.length) throw new Bad('Add at least one shift.');
  const cols = [otype, title, nonprofitId, marketId, location, address, description, bool(b.collect_shirts), bool(b.cra),
    str(b.cra_note, 'CRA note', { max: 300, required: false }), status];
  return tx(async c => {
    let oppId = id;
    if (id) {
      const cur = (await c.query('SELECT market_id FROM opportunities WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw new Bad('Not found.', 404);
      assertMarket(req.user, cur.market_id);
      await c.query(`UPDATE opportunities SET otype=$2,title=$3,nonprofit_id=$4,market_id=$5,location=$6,address=$7,description=$8,
                     collect_shirts=$9,cra=$10,cra_note=$11,status=$12 WHERE id=$1`, [id, ...cols]);
    } else {
      oppId = (await c.query(`INSERT INTO opportunities (otype,title,nonprofit_id,market_id,location,address,description,collect_shirts,cra,cra_note,status,created_by)
                              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [...cols, req.user.id])).rows[0].id;
    }
    const keep = shifts.filter(s => s.id).map(s => s.id);
    // Removing a shift that has sign-ups is blocked so nobody is silently dropped.
    const dropped = (await c.query(`SELECT s.id FROM shifts s WHERE s.opp_id=$1 AND NOT (s.id = ANY($2::int[]))
                                     AND EXISTS (SELECT 1 FROM signups WHERE shift_id=s.id)`, [oppId, keep])).rows;
    if (dropped.length) throw new Bad('A shift you removed has people signed up. Move or cancel them first.', 409);
    await c.query('DELETE FROM shifts WHERE opp_id=$1 AND NOT (id = ANY($2::int[]))', [oppId, keep]);
    for (const s of shifts) {
      if (s.id) {
        const n = (await c.query('SELECT count(*)::int AS n FROM signups WHERE shift_id=$1', [s.id])).rows[0].n;
        if (s.capacity < n) throw new Bad(`A shift has ${n} people signed up; spots can't go below that.`, 409);
        const u = await c.query('UPDATE shifts SET date=$3,start_time=$4,end_time=$5,capacity=$6,label=$7 WHERE id=$1 AND opp_id=$2',
          [s.id, oppId, s.date, s.start, s.end, s.capacity, s.label]);
        if (!u.rowCount) throw new Bad('A shift was not found.');
      } else {
        await c.query('INSERT INTO shifts (opp_id,date,start_time,end_time,capacity,label) VALUES ($1,$2,$3,$4,$5,$6)',
          [oppId, s.date, s.start, s.end, s.capacity, s.label]);
      }
    }
    await audit(req.user.id, id ? 'opp.update' : 'opp.create', `opp:${oppId}`, { title, status }, c);
    return oppId;
  });
}
r.post('/opps', A.requirePerm('opps.create'), async (req, res) => res.json({ ok: true, id: await saveOpp(req, null) }));
r.put('/opps/:id', A.requirePerm('opps.create'), async (req, res) => res.json({ ok: true, id: await saveOpp(req, int(req.params.id, 'id', { min: 1 })) }));

// Roster: who signed up, by shift
r.get('/opps/:id/roster', A.requirePerm('rosters.view', 'kiosk.run'), async (req, res) => {
  const id = int(req.params.id, 'id', { min: 1 });
  const o = await one('SELECT id, title, market_id FROM opportunities WHERE id=$1', [id]);
  if (!o) throw new Bad('Not found.', 404);
  assertMarket(req.user, o.market_id);
  const rows = await many(
    `SELECT s.id AS shift_id, s.date, to_char(s.start_time,'HH24:MI') AS start, to_char(s.end_time,'HH24:MI') AS "end", s.capacity, s.label,
            e.id AS employee_id, e.first_name, e.last_name, b.name AS branch, su.shirt_size
       FROM shifts s LEFT JOIN signups su ON su.shift_id=s.id LEFT JOIN employees e ON e.id=su.employee_id
       LEFT JOIN branches b ON b.id=e.branch_id
      WHERE s.opp_id=$1 ORDER BY s.date, s.start_time, e.last_name`, [id]);
  if (req.query.format === 'csv') {
    res.type('text/csv').attachment(`roster-${id}.csv`);
    return res.send(toCsv(['Date', 'Start', 'End', 'Shift', 'First', 'Last', 'Branch', 'Shirt'],
      rows.filter(x => x.employee_id).map(x => [x.date, x.start, x.end, x.label, x.first_name, x.last_name, x.branch, x.shirt_size])));
  }
  res.json({ opp: o, rows });
});

// ================= Hours and approvals =================
r.get('/approvals', A.requirePerm('hours.approve'), async (req, res) => {
  const m = A.marketScope(req.user);
  const rows = await many(
    `SELECT h.id, h.date, h.minutes, h.otype, h.org_name, h.details, h.created_at, e.id AS employee_id, e.first_name, e.last_name,
            mk.name AS market, b.name AS branch
       FROM hours h JOIN employees e ON e.id=h.employee_id JOIN markets mk ON mk.id=e.market_id LEFT JOIN branches b ON b.id=e.branch_id
      WHERE h.status='pending' AND ($1::int IS NULL OR e.market_id=$1) ORDER BY h.created_at`, [m]);
  res.json({ rows });
});

r.post('/hours/:id/decide', A.requirePerm('hours.approve'), async (req, res) => {
  const id = int(req.params.id, 'id', { min: 1 });
  const decision = oneOf(req.body?.decision, 'Decision', ['approved', 'rejected']);
  const note = str(req.body?.note, 'Note', { max: 300, required: decision === 'rejected' });
  const h = await one('SELECT h.id, h.status, h.employee_id, e.market_id FROM hours h JOIN employees e ON e.id=h.employee_id WHERE h.id=$1', [id]);
  if (!h) throw new Bad('Not found.', 404);
  assertMarket(req.user, h.market_id);
  if (h.employee_id === req.user.id) throw new Bad("You can't approve your own hours.", 403);
  if (h.status !== 'pending') throw new Bad('That entry was already decided.', 409);
  await q('UPDATE hours SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1', [id, decision, req.user.id, note]);
  await audit(req.user.id, `hours.${decision}`, `hours:${id}`, { note });
  res.json({ ok: true });
});

// Admin adds hours for someone (approved right away)
r.post('/hours', A.requirePerm('hours.approve'), async (req, res) => {
  const b = req.body || {};
  const emp = await employeeInScope(req.user, int(b.employee_id, 'Employee', { min: 1 }));
  const date = isoDate(b.date, 'Date');
  if (date > today()) throw new Bad("Hours can't be for a future date.");
  const minutes = Math.round(Number(b.hours) * 60);
  if (!Number.isFinite(minutes) || minutes < 15 || minutes > 16 * 60) throw new Bad('Hours must be between 0.25 and 16.');
  const oppId = b.opp_id ? int(b.opp_id, 'Opportunity', { min: 1 }) : null;
  let otype = oneOf(b.otype || 'community', 'Type', ['community', 'bank']);
  if (oppId) { const o = await one('SELECT otype, market_id FROM opportunities WHERE id=$1', [oppId]); if (!o) throw new Bad('Opportunity not found.'); if (o.otype === 'social') throw new Bad('Off-the-clock events do not log volunteer hours.'); otype = o.otype; }
  const h = await one(
    `INSERT INTO hours (employee_id, opp_id, source, date, minutes, otype, org_name, details, status, decided_by, decided_at, created_by)
     VALUES ($1,$2,'admin',$3,$4,$5,$6,$7,'approved',$8,now(),$8) RETURNING id`,
    [emp.id, oppId, date, minutes, otype, str(b.org_name, 'Organization', { max: 120, required: !oppId }), str(b.details, 'Details', { max: 1000, required: false }), req.user.id]);
  await audit(req.user.id, 'hours.added', `hours:${h.id}`, { employee: emp.id, minutes });
  res.json({ ok: true, id: h.id });
});

// ================= People =================
r.get('/people', A.requirePerm('people.view'), async (req, res) => {
  const m = A.marketScope(req.user);
  const s = String(req.query.q || '').trim().toLowerCase().slice(0, 60);
  const rows = await many(
    `SELECT e.id, e.emp_no, e.first_name, e.last_name, e.username, e.roles, e.active, e.officer, e.title,
            mk.name AS market, b.name AS branch, d.name AS department,
            (SELECT COALESCE(sum(minutes),0)::int FROM hours WHERE employee_id=e.id AND status='approved' AND date >= date_trunc('year', $3::date)) AS ytd_min
       FROM employees e JOIN markets mk ON mk.id=e.market_id LEFT JOIN branches b ON b.id=e.branch_id LEFT JOIN departments d ON d.id=e.department_id
      WHERE ($1::int IS NULL OR e.market_id=$1)
        AND ($2 = '' OR lower(e.first_name||' '||e.last_name) LIKE '%'||$2||'%' OR lower(COALESCE(e.username,'')) LIKE '%'||$2||'%' OR e.emp_no = $2)
      ORDER BY e.active DESC, e.last_name, e.first_name LIMIT 500`, [m, s, today()]);
  res.json({ rows });
});

r.get('/people/:id', A.requirePerm('people.view'), async (req, res) => {
  const e0 = await employeeInScope(req.user, int(req.params.id, 'id', { min: 1 }));
  const e = await one(
    `SELECT e.id, e.emp_no, e.first_name, e.last_name, e.username, e.roles, e.active, e.officer, e.title, e.hire_date,
            e.market_id, e.branch_id, e.department_id, e.shirt_size, e.must_change, e.locked_until,
            (e.pass_hash IS NOT NULL) AS has_account,
            CASE WHEN $2 THEN e.phone END AS phone, CASE WHEN $2 THEN e.personal_email END AS personal_email
       FROM employees e WHERE e.id=$1`, [e0.id, req.user.roles.includes('admin')]);
  const hours = await many(
    `SELECT h.id, h.date, h.minutes, h.status, h.source, COALESCE(o.title, h.org_name) AS what
       FROM hours h LEFT JOIN opportunities o ON o.id=h.opp_id WHERE h.employee_id=$1 ORDER BY h.date DESC LIMIT 100`, [e0.id]);
  res.json({ person: e, hours });
});

r.patch('/people/:id', A.requirePerm('people.edit'), async (req, res) => {
  const e = await employeeInScope(req.user, int(req.params.id, 'id', { min: 1 }));
  const b = req.body || {};
  const isAdmin = req.user.roles.includes('admin');
  const set = {};
  if (b.first_name !== undefined) set.first_name = str(b.first_name, 'First name', { max: 60 });
  if (b.last_name !== undefined) set.last_name = str(b.last_name, 'Last name', { max: 60 });
  if (b.title !== undefined) set.title = str(b.title, 'Title', { max: 80, required: false });
  if (b.officer !== undefined) set.officer = bool(b.officer);
  if (b.active !== undefined) set.active = bool(b.active);
  if (b.branch_id !== undefined) set.branch_id = b.branch_id ? int(b.branch_id, 'Branch', { min: 1 }) : null;
  if (b.department_id !== undefined) set.department_id = b.department_id ? int(b.department_id, 'Department', { min: 1 }) : null;
  if (b.market_id !== undefined) {
    if (!isAdmin) throw new Bad('Only Administrators can move someone to another market.', 403);
    set.market_id = int(b.market_id, 'Market', { min: 1 });
  }
  if (b.roles !== undefined) {
    if (!A.can(req.user, 'roles.assign')) throw new Bad('Only Administrators can assign roles.', 403);
    const roles = (Array.isArray(b.roles) ? b.roles : []).map(x => oneOf(x, 'Role', ['admin', 'mkt', 'comp', 'ccm', 'mkta']));
    if (e.id === req.user.id && !roles.includes('admin')) throw new Bad("You can't remove your own Administrator role.");
    set.roles = [...new Set(roles)];
  }
  if (set.branch_id) {
    const br = await one('SELECT market_id FROM branches WHERE id=$1', [set.branch_id]);
    if (!br) throw new Bad('Branch not found.');
    if (br.market_id !== (set.market_id || e.market_id)) throw new Bad("That branch is in a different market than this person's profile.");
  }
  const keys = Object.keys(set); // fixed whitelist
  if (!keys.length) return res.json({ ok: true });
  await q(`UPDATE employees SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`, [e.id, ...keys.map(k => set[k])]);
  if (set.active === false) await q('DELETE FROM sessions WHERE employee_id=$1', [e.id]);
  await audit(req.user.id, set.roles ? 'roles.changed' : 'person.updated', `employee:${e.id}`, set);
  res.json({ ok: true });
});

// Create a sign-in for an employee, or reset it. Returns a temporary password to read to them once.
r.post('/people/:id/account', A.requirePerm('people.edit'), async (req, res) => {
  const e = await employeeInScope(req.user, int(req.params.id, 'id', { min: 1 }));
  let username = e.username;
  if (!username) {
    const base = `${e.first_name}.${e.last_name}`.toLowerCase().normalize('NFD').replace(/[^a-z.]/g, '').slice(0, 40) || `user${e.id}`;
    username = base;
    for (let i = 2; await one('SELECT 1 FROM employees WHERE lower(username)=$1', [username]); i++) username = `${base}${i}`;
  }
  const temp = A.tempPassword();
  await q(`UPDATE employees SET username=$2, pass_hash=$3, must_change=true, failed_logins=0, locked_until=NULL, updated_at=now() WHERE id=$1`,
    [e.id, username, A.hashPassword(temp)]);
  await q('DELETE FROM sessions WHERE employee_id=$1', [e.id]);
  await audit(req.user.id, e.username ? 'account.reset' : 'account.created', `employee:${e.id}`);
  res.json({ ok: true, username, tempPassword: temp });
});

// ================= Roster import (all employees, for participation %) =================
// CSV columns: emp_no, first_name, last_name, market, branch, department, title, officer, hire_date, active
r.post('/roster/import', A.requirePerm('roster.import'), async (req, res) => {
  const commit = req.body?.commit === true;
  const deactivateMissing = req.body?.deactivateMissing === true;
  const rows = parseCsv(req.body?.csv || '');
  if (rows.length < 2) throw new Bad('The file needs a header row and at least one employee.');
  if (rows.length > 20001) throw new Bad('That file is too large (20,000 rows max).');
  const head = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z_]/g, '_'));
  const need = ['emp_no', 'first_name', 'last_name', 'market'];
  const missing = need.filter(n => !head.includes(n));
  if (missing.length) throw new Bad(`Missing column(s): ${missing.join(', ')}.`);
  const col = n => head.indexOf(n);
  const markets = Object.fromEntries((await many('SELECT id, lower(name) AS n FROM markets')).map(m => [m.n, m.id]));
  const errors = []; const recs = []; const seen = new Set();
  rows.slice(1).forEach((r0, i) => {
    const g = n => (col(n) >= 0 ? String(r0[col(n)] || '').trim() : '');
    const line = i + 2;
    const rec = { emp_no: g('emp_no'), first_name: g('first_name'), last_name: g('last_name'), market: g('market'),
      branch: g('branch') || null, department: g('department') || null, title: g('title') || null,
      officer: bool(g('officer')), hire_date: g('hire_date') || null, active: col('active') >= 0 ? !['n', 'no', 'false', '0', 'inactive'].includes(g('active').toLowerCase()) : true };
    if (!rec.emp_no || !rec.first_name || !rec.last_name) return errors.push(`Row ${line}: employee number, first and last name are required.`);
    if (seen.has(rec.emp_no)) return errors.push(`Row ${line}: employee number ${rec.emp_no} appears twice.`);
    seen.add(rec.emp_no);
    rec.market_id = markets[rec.market.toLowerCase()];
    if (!rec.market_id) return errors.push(`Row ${line}: market "${rec.market}" is not one of: ${Object.keys(markets).join(', ')}.`);
    if (rec.hire_date && !/^\d{4}-\d{2}-\d{2}$/.test(rec.hire_date)) return errors.push(`Row ${line}: hire date must be YYYY-MM-DD.`);
    recs.push(rec);
  });
  const existing = new Set((await many('SELECT emp_no FROM employees')).map(x => x.emp_no));
  const adds = recs.filter(x => !existing.has(x.emp_no)).length;
  const updates = recs.length - adds;
  const missingCount = deactivateMissing ? (await one('SELECT count(*)::int AS n FROM employees WHERE active AND NOT (emp_no = ANY($1::text[]))', [[...seen]])).n : 0;
  const summary = { rows: rows.length - 1, valid: recs.length, adds, updates, deactivations: missingCount, errors: errors.slice(0, 50), errorCount: errors.length };
  if (!commit || errors.length) return res.json({ ok: !errors.length, committed: false, summary });
  await tx(async c => {
    const branchId = async (name, marketId) => name ? (await c.query(
      'INSERT INTO branches (name, market_id) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id, market_id', [name, marketId])).rows[0].id : null;
    const deptId = async name => name ? (await c.query(
      'INSERT INTO departments (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id', [name])).rows[0].id : null;
    for (const x of recs) {
      await c.query(
        `INSERT INTO employees (emp_no, first_name, last_name, market_id, branch_id, department_id, title, officer, hire_date, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (emp_no) DO UPDATE SET first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name, market_id=EXCLUDED.market_id,
           branch_id=EXCLUDED.branch_id, department_id=EXCLUDED.department_id, title=EXCLUDED.title, officer=EXCLUDED.officer,
           hire_date=EXCLUDED.hire_date, active=EXCLUDED.active, updated_at=now()`,
        [x.emp_no, x.first_name, x.last_name, x.market_id, await branchId(x.branch, x.market_id), await deptId(x.department), x.title, x.officer, x.hire_date, x.active]);
    }
    if (deactivateMissing) {
      await c.query('UPDATE employees SET active=false, updated_at=now() WHERE active AND NOT (emp_no = ANY($1::text[]))', [[...seen]]);
      await c.query('DELETE FROM sessions WHERE employee_id IN (SELECT id FROM employees WHERE NOT active)');
    }
    await audit(req.user.id, 'roster.imported', 'roster', summary, c);
  });
  res.json({ ok: true, committed: true, summary });
});

// ================= Reports =================
function yearRange(req) {
  const y = int(req.query.year || today().slice(0, 4), 'Year', { min: 2020, max: 2100 });
  return [`${y}-01-01`, `${y}-12-31`, y];
}
// Participation: volunteers / active employees on the roster, by market, branch or department.
r.get('/reports/participation', A.requirePerm('reports.hours'), async (req, res) => {
  const [from, to, year] = yearRange(req);
  const by = oneOf(req.query.by || 'market', 'Group by', ['market', 'branch', 'department', 'officer']);
  const m = A.marketScope(req.user);
  const rate = Number(await setting('impact_rate', 30));
  const grp = { market: 'mk.name', branch: "COALESCE(b.name,'(no branch)')", department: "COALESCE(d.name,'(no department)')", officer: "CASE WHEN e.officer THEN 'Officers' ELSE 'Non-officers' END" }[by];
  const rows = await many(
    `WITH h AS (SELECT employee_id, sum(minutes) AS min, sum(minutes) FILTER (WHERE otype='community') AS comm
                  FROM hours WHERE status='approved' AND date BETWEEN $1 AND $2 GROUP BY employee_id)
     SELECT ${grp} AS grp, count(*)::int AS employees, count(h.employee_id)::int AS volunteers,
            COALESCE(sum(h.min),0)::int AS minutes, COALESCE(sum(h.comm),0)::int AS comm_minutes
       FROM employees e JOIN markets mk ON mk.id=e.market_id LEFT JOIN branches b ON b.id=e.branch_id
       LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN h ON h.employee_id=e.id
      WHERE e.active AND ($3::int IS NULL OR e.market_id=$3)
      GROUP BY 1 ORDER BY 1`, [from, to, m]);
  const out = rows.map(x => ({ group: x.grp, employees: x.employees, volunteers: x.volunteers,
    participation: x.employees ? Math.round((x.volunteers / x.employees) * 1000) / 10 : 0,
    hours: Math.round(x.minutes / 6) / 10, impact: Math.round((x.comm_minutes / 60) * rate) }));
  const tot = out.reduce((a, x) => ({ employees: a.employees + x.employees, volunteers: a.volunteers + x.volunteers, hours: a.hours + x.hours, impact: a.impact + x.impact }), { employees: 0, volunteers: 0, hours: 0, impact: 0 });
  tot.participation = tot.employees ? Math.round((tot.volunteers / tot.employees) * 1000) / 10 : 0;
  tot.hours = Math.round(tot.hours * 10) / 10;
  if (req.query.format === 'csv') {
    res.type('text/csv').attachment(`participation-${by}-${year}.csv`);
    return res.send(toCsv([by, 'Employees on roster', 'Volunteers', 'Participation %', 'Hours', `Impact $ (community hrs x $${rate})`],
      [...out.map(x => [x.group, x.employees, x.volunteers, x.participation, x.hours, x.impact]), ['Total', tot.employees, tot.volunteers, tot.participation, tot.hours, tot.impact]]));
  }
  res.json({ year, by, rate, rows: out, total: tot, scope: m ? req.user.market : 'All markets' });
});

// Detailed hours (Compliance and Market admins). CRA column shows CRA-eligible service.
r.get('/reports/hours', A.requirePerm('reports.hours'), async (req, res) => {
  const [from, to, year] = yearRange(req);
  const m = A.marketScope(req.user);
  const craOnly = req.query.cra === '1';
  if (craOnly && !A.can(req.user, 'reports.cra')) throw new Bad("You don't have access to CRA reports.", 403);
  const rows = await many(
    `SELECT h.date, e.emp_no, e.first_name, e.last_name, mk.name AS market, b.name AS branch, d.name AS department,
            COALESCE(n.name, h.org_name) AS organization, COALESCE(o.title, h.details) AS activity, h.otype,
            round(h.minutes/60.0, 2)::float AS hours, COALESCE(o.cra,false) AS cra, o.cra_note, h.source
       FROM hours h JOIN employees e ON e.id=h.employee_id JOIN markets mk ON mk.id=e.market_id
       LEFT JOIN branches b ON b.id=e.branch_id LEFT JOIN departments d ON d.id=e.department_id
       LEFT JOIN opportunities o ON o.id=h.opp_id LEFT JOIN nonprofits n ON n.id=o.nonprofit_id
      WHERE h.status='approved' AND h.date BETWEEN $1 AND $2 AND ($3::int IS NULL OR e.market_id=$3) AND (NOT $4 OR o.cra)
      ORDER BY h.date DESC, e.last_name LIMIT 20000`, [from, to, m, craOnly]);
  if (req.query.format === 'csv') {
    res.type('text/csv').attachment(`${craOnly ? 'cra-' : ''}hours-${year}.csv`);
    return res.send(toCsv(['Date', 'Emp #', 'First', 'Last', 'Market', 'Branch', 'Department', 'Organization', 'Activity', 'Type', 'Hours', 'CRA', 'CRA note', 'Source'],
      rows.map(x => [x.date, x.emp_no, x.first_name, x.last_name, x.market, x.branch, x.department, x.organization, x.activity, x.otype, x.hours, x.cra ? 'Yes' : 'No', x.cra_note, x.source])));
  }
  res.json({ year, rows: rows.slice(0, 500), count: rows.length });
});

// ================= Settings =================
r.get('/settings', A.requirePerm('settings.edit'), async (req, res) => {
  res.json({ impact_rate: Number(await setting('impact_rate', 30)) });
});
r.put('/settings', A.requirePerm('settings.edit'), async (req, res) => {
  const rate = Number(req.body?.impact_rate);
  if (!(rate > 0 && rate < 500)) throw new Bad('Impact rate must be a dollar amount.');
  await q(`INSERT INTO settings (key, value) VALUES ('impact_rate', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(rate)]);
  await audit(req.user.id, 'settings.impact_rate', 'settings', { rate });
  res.json({ ok: true });
});

r.get('/audit', A.requirePerm('settings.edit'), async (req, res) => {
  res.json({ rows: await many(
    `SELECT a.at, a.action, a.target, a.detail, e.first_name||' '||e.last_name AS actor
       FROM audit_log a LEFT JOIN employees e ON e.id=a.actor_id ORDER BY a.at DESC LIMIT 300`) });
});

// ================= Kiosk =================
r.post('/kiosk', A.requirePerm('kiosk.run'), async (req, res) => {
  const oppId = int(req.body?.opp_id, 'Opportunity', { min: 1 });
  const o = await one('SELECT id, otype, market_id, status FROM opportunities WHERE id=$1', [oppId]);
  if (!o || o.status !== 'published') throw new Bad('Opportunity not found.', 404);
  assertMarket(req.user, o.market_id);
  const token = A.newToken();
  await q(`INSERT INTO kiosks (token_hash, opp_id, opened_by, expires_at) VALUES ($1,$2,$3, now() + interval '18 hours')`, [A.sha(token), oppId, req.user.id]);
  await audit(req.user.id, 'kiosk.opened', `opp:${oppId}`);
  res.json({ ok: true, token, url: `/kiosk.html#${token}` });
});

module.exports = r;
