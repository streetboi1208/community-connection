'use strict';
const express = require('express');
const { q, one, many, tx, audit, setting } = require('../db');
const A = require('../auth');
const { Bad, str, int, bool, isoDate, oneOf, today } = require('../util');

const r = express.Router();
const SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];

// ---------- session ----------
r.post('/login', A.login);
r.post('/logout', async (req, res) => { await A.destroySession(req, res); res.json({ ok: true }); });

r.get('/me', async (req, res) => {
  if (!req.user) return res.json({ user: null });
  const p = await one(
    `SELECT e.id, e.first_name, e.last_name, e.username, e.roles, e.market_id, m.name AS market, b.name AS branch,
            d.name AS department, e.title, e.officer, e.phone, e.personal_email, e.text_consent_at, e.shirt_size, e.show_name, e.must_change
       FROM employees e JOIN markets m ON m.id=e.market_id
       LEFT JOIN branches b ON b.id=e.branch_id LEFT JOIN departments d ON d.id=e.department_id
      WHERE e.id=$1`, [req.user.id]);
  const perms = ['opps.create', 'opps.createVolunteer', 'rosters.view', 'kiosk.run', 'people.view', 'people.edit',
    'hours.approve', 'reports.hours', 'reports.cra', 'roster.import', 'roles.assign', 'settings.edit'].filter(x => A.can(req.user, x));
  res.json({ user: p, perms });
});

// Password change works even when must_change is set.
r.post('/me/password', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  const u = await one('SELECT username, pass_hash FROM employees WHERE id=$1', [req.user.id]);
  if (!A.checkPassword(String(req.body?.current || ''), u.pass_hash)) throw new Bad('Your current password is not right.');
  const pw = String(req.body?.next || '');
  const prob = A.passwordProblem(pw, u.username);
  if (prob) throw new Bad(prob);
  if (A.checkPassword(pw, u.pass_hash)) throw new Bad('Choose a password different from the current one.');
  await q('UPDATE employees SET pass_hash=$2, must_change=false, updated_at=now() WHERE id=$1', [req.user.id, A.hashPassword(pw)]);
  // sign out other devices
  await q('DELETE FROM sessions WHERE employee_id=$1 AND token_hash<>$2', [req.user.id, req.user.token_hash]);
  await audit(req.user.id, 'password.changed', `employee:${req.user.id}`);
  res.json({ ok: true });
});

r.use(A.requireUser);

r.patch('/me', async (req, res) => {
  const b = req.body || {};
  const cur = await one('SELECT phone, text_consent_at FROM employees WHERE id=$1', [req.user.id]);
  const set = {};
  if (b.phone !== undefined) {
    const phone = str(b.phone, 'Phone', { max: 20, required: false });
    if (phone && !/^[0-9()+\-. ]{10,20}$/.test(phone)) throw new Bad('Phone number is not valid.');
    set.phone = phone;
    if (!phone) set.text_consent_at = null; // no phone, no texts
  }
  if (b.personal_email !== undefined) {
    const email = str(b.personal_email, 'Email', { max: 200, required: false });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Bad('Email is not valid.');
    set.personal_email = email;
  }
  if (b.shirt_size !== undefined) set.shirt_size = b.shirt_size ? oneOf(b.shirt_size, 'Shirt size', SIZES) : null;
  if (b.show_name !== undefined) set.show_name = bool(b.show_name);
  if (b.text_consent !== undefined) {
    const phone = set.phone !== undefined ? set.phone : cur.phone;
    if (bool(b.text_consent) && !phone) throw new Bad('Add a mobile number before turning on texts.');
    set.text_consent_at = bool(b.text_consent) ? (cur.text_consent_at || new Date()) : null;
  }
  const keys = Object.keys(set); // fixed whitelist above, never user-supplied column names
  if (keys.length) {
    await q(`UPDATE employees SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`,
      [req.user.id, ...keys.map(k => set[k])]);
  }
  if ('text_consent_at' in set && !!set.text_consent_at !== !!cur.text_consent_at) {
    await audit(req.user.id, set.text_consent_at ? 'texts.consented' : 'texts.stopped', `employee:${req.user.id}`);
  }
  res.json({ ok: true });
});

// ---------- lookups ----------
r.get('/meta', async (req, res) => {
  const [markets, branches, departments, nonprofits] = await Promise.all([
    many('SELECT id, name FROM markets ORDER BY id'),
    many('SELECT id, name, market_id FROM branches ORDER BY name'),
    many('SELECT id, name FROM departments ORDER BY name'),
    many('SELECT id, name, market_id FROM nonprofits ORDER BY name')
  ]);
  res.json({ markets, branches, departments, nonprofits, sizes: SIZES, impactRate: Number(await setting('impact_rate', 30)), today: today() });
});

// ---------- home ----------
r.get('/home', async (req, res) => {
  const year = today().slice(0, 4);
  const rate = Number(await setting('impact_rate', 30));
  const mine = await one(
    `SELECT COALESCE(sum(minutes),0)::int AS min FROM hours WHERE employee_id=$1 AND status='approved' AND date >= $2::date`,
    [req.user.id, `${year}-01-01`]);
  const mk = await one(
    `SELECT COALESCE(sum(h.minutes),0)::int AS min, COALESCE(sum(h.minutes) FILTER (WHERE h.otype='community'),0)::int AS comm
       FROM hours h JOIN employees e ON e.id=h.employee_id
      WHERE e.market_id=$1 AND h.status='approved' AND h.date >= $2::date`, [req.user.market_id, `${year}-01-01`]);
  const next = await one(
    `SELECT o.id, o.title, o.location, s.date, s.start_time, s.end_time, n.name AS nonprofit
       FROM signups su JOIN shifts s ON s.id=su.shift_id JOIN opportunities o ON o.id=s.opp_id LEFT JOIN nonprofits n ON n.id=o.nonprofit_id
      WHERE su.employee_id=$1 AND s.date >= $2::date AND o.status='published' ORDER BY s.date, s.start_time LIMIT 1`, [req.user.id, today()]);
  const pending = await one(`SELECT count(*)::int AS n FROM hours WHERE employee_id=$1 AND status='pending'`, [req.user.id]);
  res.json({
    year, myHours: mine.min / 60, market: req.user.market,
    marketHours: mk.min / 60, marketImpact: Math.round((mk.comm / 60) * rate), impactRate: rate,
    next, pendingHours: pending.n
  });
});

// ---------- opportunities ----------
async function oppRows(where, params, userId) {
  return many(
    `SELECT o.id, o.otype, o.title, o.location, o.address, o.description, o.collect_shirts, o.cra, o.market_id, m.name AS market,
            n.name AS nonprofit,
            (SELECT min(date) FROM shifts WHERE opp_id=o.id) AS first_date,
            (SELECT max(date) FROM shifts WHERE opp_id=o.id) AS last_date,
            (SELECT COALESCE(sum(capacity),0)::int FROM shifts WHERE opp_id=o.id AND date >= $${params.length + 1}::date) AS cap,
            (SELECT count(*)::int FROM signups su JOIN shifts s ON s.id=su.shift_id WHERE s.opp_id=o.id AND s.date >= $${params.length + 1}::date) AS filled,
            EXISTS (SELECT 1 FROM signups su JOIN shifts s ON s.id=su.shift_id WHERE s.opp_id=o.id AND su.employee_id=$${params.length + 2} AND s.date >= $${params.length + 1}::date) AS mine
       FROM opportunities o JOIN markets m ON m.id=o.market_id LEFT JOIN nonprofits n ON n.id=o.nonprofit_id
      WHERE ${where}
      ORDER BY first_date NULLS LAST, o.id`, [...params, today(), userId]);
}

r.get('/opps', async (req, res) => {
  const all = req.query.market === 'all';
  const params = all ? [] : [req.user.market_id];
  const t = `$${params.length + 1}`; // oppRows appends today() as the next parameter
  let where = `o.status='published' AND EXISTS (SELECT 1 FROM shifts s WHERE s.opp_id=o.id AND s.date >= ${t}::date)`;
  if (!all) where += ' AND o.market_id=$1';
  res.json({ opps: await oppRows(where, params, req.user.id), market: all ? 'All markets' : req.user.market });
});

r.get('/opps/:id', async (req, res) => {
  const id = int(req.params.id, 'id', { min: 1 });
  const [o] = await oppRows(`o.id=$1 AND o.status='published'`, [id], req.user.id);
  if (!o) throw new Bad('That opportunity was not found.', 404);
  const shifts = await many(
    `SELECT s.id, s.label, s.date, to_char(s.start_time,'HH24:MI') AS start, to_char(s.end_time,'HH24:MI') AS "end", s.capacity,
            (SELECT count(*)::int FROM signups WHERE shift_id=s.id) AS filled,
            (SELECT id FROM signups WHERE shift_id=s.id AND employee_id=$2) AS my_signup
       FROM shifts s WHERE s.opp_id=$1 AND s.date >= $3::date ORDER BY s.date, s.start_time`, [id, req.user.id, today()]);
  // Who's going: only people who allow their name to show.
  const going = await many(
    `SELECT DISTINCT e.first_name, left(e.last_name,1) AS li
       FROM signups su JOIN shifts s ON s.id=su.shift_id JOIN employees e ON e.id=su.employee_id
      WHERE s.opp_id=$1 AND s.date >= $2::date AND e.show_name ORDER BY 1 LIMIT 40`, [id, today()]);
  res.json({ opp: o, shifts, going });
});

r.post('/opps/:id/signup', async (req, res) => {
  const oppId = int(req.params.id, 'id', { min: 1 });
  const ids = Array.isArray(req.body?.shiftIds) ? req.body.shiftIds.map(x => int(x, 'Shift', { min: 1 })) : [];
  if (!ids.length) throw new Bad('Pick at least one shift.');
  const o = await one(`SELECT id, collect_shirts, status FROM opportunities WHERE id=$1`, [oppId]);
  if (!o || o.status !== 'published') throw new Bad('That opportunity is not open.', 404);
  let size = null;
  if (o.collect_shirts) {
    size = req.body?.shirt_size ? oneOf(req.body.shirt_size, 'Shirt size', SIZES) : null;
    if (!size) throw new Bad('Pick a shirt size.');
  }
  const added = await tx(async c => {
    const out = [];
    for (const sid of [...new Set(ids)]) {
      const s = (await c.query(`SELECT id, capacity, date FROM shifts WHERE id=$1 AND opp_id=$2 FOR UPDATE`, [sid, oppId])).rows[0];
      if (!s) throw new Bad('A shift was not found.');
      if (s.date < today()) throw new Bad('That shift already happened.');
      const n = (await c.query('SELECT count(*)::int AS n FROM signups WHERE shift_id=$1', [sid])).rows[0].n;
      const dup = (await c.query('SELECT 1 FROM signups WHERE shift_id=$1 AND employee_id=$2', [sid, req.user.id])).rows[0];
      if (dup) continue;
      if (n >= s.capacity) throw new Bad('Sorry, a shift you picked just filled up. Please pick another.', 409);
      await c.query('INSERT INTO signups (shift_id, employee_id, shirt_size) VALUES ($1,$2,$3)', [sid, req.user.id, size]);
      out.push(sid);
    }
    return out;
  });
  if (size) await q('UPDATE employees SET shirt_size=COALESCE(shirt_size,$2) WHERE id=$1', [req.user.id, size]);
  await audit(req.user.id, 'signup.add', `opp:${oppId}`, { shifts: added });
  res.json({ ok: true, added });
});

r.delete('/signups/:id', async (req, res) => {
  const id = int(req.params.id, 'id', { min: 1 });
  const s = await one(
    `SELECT su.id, s.date, s.opp_id FROM signups su JOIN shifts s ON s.id=su.shift_id WHERE su.id=$1 AND su.employee_id=$2`, [id, req.user.id]);
  if (!s) throw new Bad('Sign-up not found.', 404);
  if (s.date < today()) throw new Bad('That shift already happened.');
  await q('DELETE FROM signups WHERE id=$1', [id]);
  await audit(req.user.id, 'signup.cancel', `opp:${s.opp_id}`, { signup: id });
  res.json({ ok: true });
});

// ---------- my activity ----------
r.get('/activity', async (req, res) => {
  const upcoming = await many(
    `SELECT su.id AS signup_id, o.id AS opp_id, o.title, o.location, n.name AS nonprofit, s.date,
            to_char(s.start_time,'HH24:MI') AS start, to_char(s.end_time,'HH24:MI') AS "end", s.label, su.shirt_size
       FROM signups su JOIN shifts s ON s.id=su.shift_id JOIN opportunities o ON o.id=s.opp_id LEFT JOIN nonprofits n ON n.id=o.nonprofit_id
      WHERE su.employee_id=$1 AND s.date >= $2::date ORDER BY s.date, s.start_time`, [req.user.id, today()]);
  const hours = await many(
    `SELECT h.id, h.date, h.minutes, h.source, h.status, h.otype, h.decision_note, COALESCE(o.title, h.org_name) AS what, h.details
       FROM hours h LEFT JOIN opportunities o ON o.id=h.opp_id
      WHERE h.employee_id=$1 ORDER BY h.date DESC, h.id DESC LIMIT 200`, [req.user.id]);
  res.json({ upcoming, hours });
});

// Employee logs volunteering done outside the app (goes to approvals).
r.post('/hours', async (req, res) => {
  const b = req.body || {};
  const date = isoDate(b.date, 'Date');
  if (date > today()) throw new Bad("You can't log hours for a future date.");
  const minutes = Math.round(Number(b.hours) * 60);
  if (!Number.isFinite(minutes) || minutes < 15 || minutes > 12 * 60) throw new Bad('Hours must be between 0.25 and 12.');
  const org = str(b.org_name, 'Organization', { max: 120 });
  const details = str(b.details, 'What you did', { max: 1000 });
  const otype = oneOf(b.otype || 'community', 'Type', ['community', 'bank']);
  const h = await one(
    `INSERT INTO hours (employee_id, source, date, minutes, otype, org_name, details, status, created_by)
     VALUES ($1,'self',$2,$3,$4,$5,$6,'pending',$1) RETURNING id`, [req.user.id, date, minutes, otype, org, details]);
  await audit(req.user.id, 'hours.self_logged', `hours:${h.id}`, { minutes, date });
  res.json({ ok: true, id: h.id });
});

module.exports = r;
