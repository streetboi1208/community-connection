'use strict';
const crypto = require('crypto');
// Kiosk check-in on a shared iPad. No employee signs in: the device holds a kiosk token
// that only allows check-in/out for one opportunity, and expires after 18 hours.
const express = require('express');
const { q, one, many, tx, audit } = require('../db');
const A = require('../auth');
const { Bad, int, today } = require('../util');

const r = express.Router();
const UNDO_MINUTES = 5;

r.use(async (req, res, next) => {
  const t = String(req.get('x-kiosk') || '');
  if (!t) return res.status(401).json({ error: 'Kiosk not open.' });
  const k = await one(
    `SELECT k.token_hash, k.opp_id, k.opened_by, o.title, o.otype, o.location, n.name AS nonprofit
       FROM kiosks k JOIN opportunities o ON o.id=k.opp_id LEFT JOIN nonprofits n ON n.id=o.nonprofit_id
      WHERE k.token_hash=$1 AND k.expires_at > now() AND k.closed_at IS NULL`, [A.sha(t)]);
  if (!k) return res.status(401).json({ error: 'This kiosk is closed or expired. Ask a committee member to open it again.' });
  req.kiosk = k;
  next();
});

const nameOf = e => `${e.first_name} ${e.last_name.slice(0, 1)}.`;

r.get('/state', async (req, res) => {
  const k = req.kiosk;
  const ins = await many(
    `SELECT c.employee_id, c.guests, c.check_in, e.first_name, e.last_name FROM checkins c JOIN employees e ON e.id=c.employee_id
      WHERE c.opp_id=$1 ORDER BY c.check_in DESC`, [k.opp_id]);
  const done = await one(`SELECT count(*)::int AS n FROM hours WHERE opp_id=$1 AND source='kiosk' AND date=$2`, [k.opp_id, today()]);
  res.json({ title: k.title, nonprofit: k.nonprofit, location: k.location, otype: k.otype,
    checkedIn: ins.map(x => ({ id: x.employee_id, name: nameOf(x), guests: x.guests, since: x.check_in })), checkedOutToday: done.n });
});

// Search active employees by name; people signed up for this event come first.
r.get('/search', async (req, res) => {
  const s = String(req.query.q || '').trim().toLowerCase();
  if (s.length < 2) return res.json({ rows: [] });
  const rows = await many(
    `SELECT e.id, e.first_name, e.last_name, b.name AS branch,
            EXISTS (SELECT 1 FROM signups su JOIN shifts sh ON sh.id=su.shift_id WHERE sh.opp_id=$2 AND su.employee_id=e.id) AS signed_up,
            (SELECT max(jsonb_array_length(su.guests)) FROM signups su JOIN shifts sh ON sh.id=su.shift_id WHERE sh.opp_id=$2 AND su.employee_id=e.id AND sh.date=$3::date) AS guests,
            EXISTS (SELECT 1 FROM checkins c WHERE c.opp_id=$2 AND c.employee_id=e.id) AS checked_in
       FROM employees e LEFT JOIN branches b ON b.id=e.branch_id
      WHERE e.active AND (lower(e.first_name||' '||e.last_name) LIKE $1 OR lower(e.last_name) LIKE $1)
      ORDER BY signed_up DESC, e.first_name LIMIT 8`, [`%${s.replace(/[%_]/g, '')}%`, req.kiosk.opp_id, today()]);
  res.json({ rows: rows.map(x => ({ id: x.id, name: nameOf(x), branch: x.branch, signedUp: x.signed_up, guests: x.guests || 0, checkedIn: x.checked_in })) });
});

r.post('/checkin', async (req, res) => {
  const id = int(req.body?.employee_id, 'Employee', { min: 1 });
  const guests = int(req.body?.guests ?? 0, 'Guests', { min: 0, max: 10 });
  const e = await one('SELECT id, active FROM employees WHERE id=$1', [id]);
  if (!e || !e.active) throw new Bad('Employee not found.', 404);
  const ins = await q('INSERT INTO checkins (opp_id, employee_id, guests) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.kiosk.opp_id, id, guests]);
  if (!ins.rowCount) throw new Bad('Already checked in.', 409);
  await audit(null, 'kiosk.checkin', `opp:${req.kiosk.opp_id}`, { employee: id, guests });
  res.json({ ok: true });
});

// Undo a check-in made by mistake (within a few minutes).
r.post('/undo', async (req, res) => {
  const id = int(req.body?.employee_id, 'Employee', { min: 1 });
  const d = await q(`DELETE FROM checkins WHERE opp_id=$1 AND employee_id=$2 AND check_in > now() - ($3 || ' minutes')::interval`, [req.kiosk.opp_id, id, String(UNDO_MINUTES)]);
  if (!d.rowCount) throw new Bad(`Undo only works within ${UNDO_MINUTES} minutes of checking in.`);
  await audit(null, 'kiosk.undo', `opp:${req.kiosk.opp_id}`, { employee: id });
  res.json({ ok: true });
});

// Check out: logs actual time (rounded to the nearest minute) as approved volunteer hours.
// Off-the-clock (social) events record attendance only, no hours.
r.post('/checkout', async (req, res) => {
  const id = int(req.body?.employee_id, 'Employee', { min: 1 });
  const k = req.kiosk;
  const out = await tx(async c => {
    const ci = (await c.query('DELETE FROM checkins WHERE opp_id=$1 AND employee_id=$2 RETURNING check_in, guests', [k.opp_id, id])).rows[0];
    if (!ci) throw new Bad('Not checked in.', 409);
    const minutes = Math.max(1, Math.round((Date.now() - new Date(ci.check_in).getTime()) / 60000));
    if (k.otype === 'social') return { minutes: 0 };
    await c.query(
      `INSERT INTO hours (employee_id, opp_id, source, date, minutes, otype, guests, check_in, check_out, status, decided_by, decided_at, created_by)
       VALUES ($1,$2,'kiosk',$3,$4,$5,$6,$7,now(),'approved',$8,now(),$8)`,
      [id, k.opp_id, today(), Math.min(minutes, 24 * 60), k.otype, ci.guests, ci.check_in, k.opened_by]);
    // Friends and family: each guest is credited to this employee. Names stay on the sign-up, not here.
    if (ci.guests) {
      const names = ((await c.query(`SELECT su.guests FROM signups su JOIN shifts sh ON sh.id=su.shift_id
                                      WHERE sh.opp_id=$1 AND su.employee_id=$2 AND sh.date=$3::date LIMIT 1`, [k.opp_id, id, today()])).rows[0] || { guests: [] }).guests;
      for (let i = 0; i < ci.guests; i++) {
        const who = names[i] ? names[i].name.toLowerCase() : `walk-in ${new Date(ci.check_in).getTime()}-${i}`;
        const code = 'K' + crypto.createHash('sha1').update(`${id}|${who}`).digest('hex').slice(0, 10);
        await c.query(`INSERT INTO guest_hours (host_ids, guest_code, date, minutes, otype, org_name, details)
                       VALUES ($1,$2,$3,$4,$5,$6,'Kiosk check-in')`, [[id], code, today(), Math.min(minutes, 24 * 60), k.otype, k.nonprofit || k.title]);
      }
    }
    return { minutes };
  });
  await audit(null, 'kiosk.checkout', `opp:${k.opp_id}`, { employee: id, minutes: out.minutes });
  res.json({ ok: true, minutes: out.minutes });
});

r.post('/close', async (req, res) => {
  await q('UPDATE kiosks SET closed_at=now() WHERE token_hash=$1', [req.kiosk.token_hash]);
  await audit(null, 'kiosk.closed', `opp:${req.kiosk.opp_id}`);
  res.json({ ok: true });
});

module.exports = r;
