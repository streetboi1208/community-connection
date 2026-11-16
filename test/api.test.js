'use strict';
// Integration tests against a real PostgreSQL database.
// Set TEST_DATABASE_URL to a throwaway database; every table is wiped first.
const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.TEST_DATABASE_URL) {
  test('integration tests', { skip: 'TEST_DATABASE_URL not set' }, () => {});
  return;
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { pool, one, q } = require('../src/db');
const { migrate } = require('../db/migrate');
const { hashPassword } = require('../src/auth');
const { createApp } = require('../src/server');
const { today } = require('../src/util');

let base, server;
const PW = 'Test-Password-123';
const addDays = n => { const d = new Date(today() + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body, { csrf = true, headers = {} } = {}) {
    const r = await fetch(base + path, {
      method, headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(csrf ? { 'x-requested-with': 'cc' } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined, redirect: 'manual'
    });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  }
  get(p, o) { return this.req('GET', p, null, o); }
  post(p, b, o) { return this.req('POST', p, b || {}, o); }
  async login(u, pw = PW) { const r = await this.post('/api/login', { username: u, password: pw }); assert.equal(r.status, 200, JSON.stringify(r.data)); return this; }
}

let M, ids = {};
async function emp(username, roles, market, { mustChange = false, empNo } = {}) {
  const e = await one(
    `INSERT INTO employees (emp_no, first_name, last_name, market_id, username, pass_hash, must_change, roles)
     VALUES ($1,$2,'Tester',$3,$4,$5,$6,$7) RETURNING id`,
    [empNo || 'T-' + username, username.split('.')[0], M[market], username, hashPassword(PW), mustChange, roles]);
  return e.id;
}

test.before(async () => {
  await migrate();
  await q('TRUNCATE checkins, kiosks, hours, signups, shifts, opportunities, nonprofits, sessions, audit_log, employees, branches, departments RESTART IDENTITY CASCADE');
  M = Object.fromEntries((await q('SELECT id, name FROM markets')).rows.map(r => [r.name, r.id]));
  ids.admin = await emp('ana.admin', ['admin'], 'Permian Basin');
  ids.emp = await emp('eli.emp', [], 'Permian Basin');
  ids.emp2 = await emp('eva.emp', [], 'Permian Basin');
  ids.lbkEmp = await emp('leo.lbk', [], 'Lubbock');
  ids.mkt = await emp('max.mkt', ['mkt'], 'Permian Basin');
  ids.comp = await emp('cy.comp', ['comp'], 'Permian Basin');
  ids.ccm = await emp('cc.ccm', ['ccm'], 'Permian Basin');
  ids.mkta = await emp('lu.mkta', ['mkta'], 'Lubbock');
  ids.newbie = await emp('new.hire', [], 'Permian Basin', { mustChange: true });
  server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await pool.end(); });

test('sign-in: wrong password is rejected and 5 misses lock the account', async () => {
  const c = new Client();
  for (let i = 0; i < 4; i++) assert.equal((await c.post('/api/login', { username: 'eva.emp', password: 'nope-nope-nope' })).status, 401);
  assert.equal((await c.post('/api/login', { username: 'eva.emp', password: 'nope-nope-nope' })).status, 401);
  assert.equal((await c.post('/api/login', { username: 'eva.emp', password: PW })).status, 423, 'locked even with the right password');
  await q('UPDATE employees SET locked_until=NULL WHERE id=$1', [ids.emp2]);
  await c.login('eva.emp');
});

test('state-changing calls without the CSRF header are blocked', async () => {
  const c = new Client();
  assert.equal((await c.post('/api/login', { username: 'eli.emp', password: PW }, { csrf: false })).status, 403);
});

test('a temporary password must be changed before anything else', async () => {
  const c = await new Client().login('new.hire');
  assert.equal((await c.get('/api/home')).status, 403);
  assert.equal((await c.post('/api/me/password', { current: PW, next: 'short' })).status, 400);
  assert.equal((await c.post('/api/me/password', { current: PW, next: 'Brand-New-Pass-42' })).status, 200);
  assert.equal((await c.get('/api/home')).status, 200);
});

test('employees cannot reach admin pages', async () => {
  const c = await new Client().login('eli.emp');
  assert.equal((await c.get('/api/admin/people')).status, 403);
  assert.equal((await c.get('/api/admin/reports/participation')).status, 403);
});

let oppId, shiftId;
test('Marketing can create CNB events but not volunteer opportunities', async () => {
  const c = await new Client().login('max.mkt');
  const body = { otype: 'community', market_id: M['Permian Basin'], title: 'Food sort', nonprofit: 'Food Bank', location: 'Warehouse', shifts: [{ date: addDays(3), start: '09:00', end: '12:00', capacity: 1 }] };
  assert.equal((await c.post('/api/admin/opps', body)).status, 403);
  assert.equal((await c.post('/api/admin/opps', { ...body, otype: 'bank', title: 'Float build' })).status, 200);
});

test('Administrator creates an opportunity; sign-up respects capacity', async () => {
  const a = await new Client().login('ana.admin');
  const r = await a.post('/api/admin/opps', { otype: 'community', market_id: M['Permian Basin'], title: 'Food sort', nonprofit: 'Food Bank', location: 'Warehouse', cra: true,
    shifts: [{ date: addDays(3), start: '09:00', end: '12:00', capacity: 1 }] });
  assert.equal(r.status, 200); oppId = r.data.id;
  shiftId = (await one('SELECT id FROM shifts WHERE opp_id=$1', [oppId])).id;
  const e1 = await new Client().login('eli.emp');
  const list = await e1.get('/api/opps');
  assert.ok(list.data.opps.some(o => o.id === oppId));
  assert.equal((await e1.post(`/api/opps/${oppId}/signup`, { shiftIds: [shiftId] })).status, 200);
  const e2 = await new Client().login('eva.emp');
  assert.equal((await e2.post(`/api/opps/${oppId}/signup`, { shiftIds: [shiftId] })).status, 409, 'shift is full');
  // A Lubbock employee does not see it by default, but does with View all
  const l = await new Client().login('leo.lbk');
  assert.ok(!(await l.get('/api/opps')).data.opps.some(o => o.id === oppId));
  assert.ok((await l.get('/api/opps?market=all')).data.opps.some(o => o.id === oppId));
  // Capacity can't be cut below the people already signed up
  const cut = await a.req('PUT', `/api/admin/opps/${oppId}`, { otype: 'community', market_id: M['Permian Basin'], title: 'Food sort', nonprofit: 'Food Bank', location: 'Warehouse', shifts: [] });
  assert.equal(cut.status, 400);
});

test('self-logged hours go to approvals; you cannot approve your own', async () => {
  const e = await new Client().login('eli.emp');
  assert.equal((await e.post('/api/hours', { date: addDays(1), hours: 2, org_name: 'X', details: 'Y' })).status, 400, 'no future dates');
  const h = await e.post('/api/hours', { date: addDays(-2), hours: 2, org_name: 'Habitat', details: 'Framing' });
  assert.equal(h.status, 200);
  const a = await new Client().login('ana.admin');
  const ap = await a.get('/api/admin/approvals');
  assert.ok(ap.data.rows.some(x => x.id === h.data.id));
  assert.equal((await a.post(`/api/admin/hours/${h.data.id}/decide`, { decision: 'approved' })).status, 200);
  assert.equal((await a.post(`/api/admin/hours/${h.data.id}/decide`, { decision: 'approved' })).status, 409, 'already decided');
  const mine = await a.post('/api/hours', { date: addDays(-1), hours: 1, org_name: 'Z', details: 'Z' });
  assert.equal((await a.post(`/api/admin/hours/${mine.data.id}/decide`, { decision: 'approved' })).status, 403);
});

test('Market admin is limited to the market on their profile', async () => {
  const lbk = await new Client().login('leo.lbk');
  const ph = await lbk.post('/api/hours', { date: addDays(-1), hours: 1, org_name: 'Food Bank', details: 'Sort' });
  const pb = await new Client().login('eva.emp');
  const pbh = await pb.post('/api/hours', { date: addDays(-1), hours: 1, org_name: 'Food Bank', details: 'Sort' });
  const m = await new Client().login('lu.mkta');
  const ap = await m.get('/api/admin/approvals');
  assert.ok(ap.data.rows.some(x => x.id === ph.data.id), 'sees Lubbock');
  assert.ok(!ap.data.rows.some(x => x.id === pbh.data.id), 'does not see Permian Basin');
  assert.equal((await m.post(`/api/admin/hours/${pbh.data.id}/decide`, { decision: 'approved' })).status, 403);
  assert.equal((await m.get(`/api/admin/people/${ids.emp}`)).status, 403);
  assert.equal((await m.req('PATCH', `/api/admin/people/${ids.lbkEmp}`, { roles: ['admin'] })).status, 403, 'cannot assign roles');
  assert.equal((await m.req('PATCH', `/api/admin/people/${ids.lbkEmp}`, { title: 'Teller' })).status, 200);
  const rep = await m.get('/api/admin/reports/participation');
  assert.deepEqual(rep.data.rows.map(r => r.group), ['Lubbock']);
  assert.equal((await m.get('/api/admin/reports/hours?cra=1')).status, 403, 'no CRA report for market admins');
});

test('Compliance pulls reports only', async () => {
  const c = await new Client().login('cy.comp');
  assert.equal((await c.get('/api/admin/reports/hours?cra=1')).status, 200);
  assert.equal((await c.get('/api/admin/reports/participation?format=csv')).status, 200);
  assert.equal((await c.post('/api/admin/opps', {})).status, 403);
  assert.equal((await c.get('/api/admin/people')).status, 403);
});

test('account reset issues a temp password and signs the person out', async () => {
  const a = await new Client().login('ana.admin');
  const e = await new Client().login('eli.emp');
  const r = await a.post(`/api/admin/people/${ids.emp}/account`);
  assert.equal(r.status, 200);
  assert.match(r.data.tempPassword, /^[A-Za-z]+-[A-Za-z]+-\d{4}$/);
  assert.equal((await e.get('/api/home')).status, 401, 'old session ended');
  const again = await new Client().login('eli.emp', r.data.tempPassword);
  assert.equal((await again.get('/api/home')).status, 403, 'must change first');
  await again.post('/api/me/password', { current: r.data.tempPassword, next: PW + 'x' });
  await q('UPDATE employees SET pass_hash=$2 WHERE id=$1', [ids.emp, hashPassword(PW)]);
});

test('roster import previews, then loads; participation uses the whole roster', async () => {
  const a = await new Client().login('ana.admin');
  const csv = 'emp_no,first_name,last_name,market,branch,department,officer\n' +
    'R1,Rae,One,Permian Basin,Midland HQ,Retail,Y\nR2,Ray,Two,Permian Basin,Midland HQ,Retail,N\nR3,Roy,Three,Nowhere,,,\n';
  const bad = await a.post('/api/admin/roster/import', { csv, commit: true });
  assert.equal(bad.data.committed, false);
  assert.equal(bad.data.summary.errorCount, 1);
  const good = await a.post('/api/admin/roster/import', { csv: csv.split('\n').slice(0, 3).join('\n'), commit: true });
  assert.equal(good.data.committed, true);
  assert.equal(good.data.summary.adds, 2);
  const rep = await a.get('/api/admin/reports/participation?by=market');
  const pb = rep.data.rows.find(r => r.group === 'Permian Basin');
  const roster = (await one(`SELECT count(*)::int AS n FROM employees WHERE active AND market_id=$1`, [M['Permian Basin']])).n;
  assert.equal(pb.employees, roster);
  assert.ok(pb.volunteers >= 1 && pb.participation > 0);
  // CSV export neutralizes formulas
  await q(`UPDATE employees SET first_name='=HYPERLINK(1)' WHERE emp_no='R1'`);
  await q(`INSERT INTO hours (employee_id, source, date, minutes, org_name, status) SELECT id,'admin',$1,60,'X','approved' FROM employees WHERE emp_no='R1'`, [addDays(-1)]);
  const out = await a.get('/api/admin/reports/hours?format=csv');
  assert.ok(out.data.includes("'=HYPERLINK(1)"));
});

test('kiosk: committee opens it, people check in and out, hours are logged', async () => {
  const cc = await new Client().login('cc.ccm');
  const k = await cc.post('/api/admin/kiosk', { opp_id: oppId });
  assert.equal(k.status, 200);
  const kc = new Client();
  const H = { headers: { 'x-kiosk': k.data.token } };
  assert.equal((await kc.get('/api/kiosk/state', { headers: { 'x-kiosk': 'bogus' } })).status, 401);
  const s = await kc.get('/api/kiosk/search?q=eva', H);
  assert.equal(s.data.rows[0].name, 'eva T.');
  assert.equal((await kc.req('POST', '/api/kiosk/checkin', { employee_id: ids.emp2, guests: 1 }, H)).status, 200);
  assert.equal((await kc.req('POST', '/api/kiosk/checkin', { employee_id: ids.emp2 }, H)).status, 409);
  await q(`UPDATE checkins SET check_in = now() - interval '90 minutes' WHERE employee_id=$1`, [ids.emp2]);
  const out = await kc.req('POST', '/api/kiosk/checkout', { employee_id: ids.emp2 }, H);
  assert.equal(out.status, 200);
  assert.ok(Math.abs(out.data.minutes - 90) <= 1);
  const h = await one(`SELECT status, guests, source FROM hours WHERE employee_id=$1 AND source='kiosk'`, [ids.emp2]);
  assert.deepEqual(h, { status: 'approved', guests: 1, source: 'kiosk' });
  assert.equal((await kc.req('POST', '/api/kiosk/close', {}, H)).status, 200);
  assert.equal((await kc.get('/api/kiosk/state', H)).status, 401, 'closed kiosk stops working');
  // Employees cannot open kiosks
  const e = await new Client().login('eli.emp');
  assert.equal((await e.post('/api/admin/kiosk', { opp_id: oppId })).status, 403);
});

test('audit log records admin actions', async () => {
  const n = (await one(`SELECT count(*)::int AS n FROM audit_log WHERE action IN ('opp.create','hours.approved','account.reset','roster.imported','kiosk.opened')`)).n;
  assert.ok(n >= 5);
});
