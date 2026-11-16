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
  await q('TRUNCATE board_seats, waitlist, profile_requests, checkins, kiosks, hours, signups, shifts, opportunities, nonprofits, sessions, audit_log, employees, branches, departments RESTART IDENTITY CASCADE');
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
  ids.it = await emp('ivy.it', ['it'], 'Permian Basin');
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
  const full = await e2.post(`/api/opps/${oppId}/signup`, { shiftIds: [shiftId] });
  assert.equal(full.status, 200); assert.deepEqual(full.data.waitlisted, [shiftId], 'a full shift puts you on the waitlist');
  const wid = (await one('SELECT id FROM waitlist WHERE shift_id=$1 AND employee_id=$2', [shiftId, ids.emp2])).id;
  assert.equal((await e2.req('DELETE', `/api/waitlist/${wid}`)).status, 200);
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

test('IT help desk can only find people and reset non-admin sign-ins', async () => {
  const it = await new Client().login('ivy.it');
  const list = await it.get('/api/admin/people?q=leo');
  assert.equal(list.status, 200);
  assert.equal(list.data.rows[0].ytd_min, null, 'no hours for the help desk');
  const lbk = await it.get(`/api/admin/people/${ids.lbkEmp}`);
  assert.equal(lbk.data.limited, true, 'all markets, limited view');
  assert.deepEqual(lbk.data.hours, []);
  const r = await it.post(`/api/admin/people/${ids.lbkEmp}/account`);
  assert.equal(r.status, 200);
  assert.equal((await it.post(`/api/admin/people/${ids.admin}/account`)).status, 403, 'cannot reset an Administrator');
  assert.equal((await it.post(`/api/admin/people/${ids.mkta}/account`)).status, 403, 'cannot reset any role holder');
  assert.equal((await it.req('PATCH', `/api/admin/people/${ids.lbkEmp}`, { title: 'X' })).status, 403, 'cannot edit profiles');
  assert.equal((await it.get('/api/admin/approvals')).status, 403);
  assert.equal((await it.get('/api/admin/reports/participation')).status, 403);
  await q('UPDATE employees SET pass_hash=$2, must_change=false WHERE id=$1', [ids.lbkEmp, hashPassword(PW)]);
});

test('sign-in page shows the help desk email once an admin sets it', async () => {
  const anon = new Client();
  await q(`DELETE FROM settings WHERE key='helpdesk_email'`);
  assert.equal((await anon.get('/api/public-config')).data.helpdeskEmail, null);
  const a = await new Client().login('ana.admin');
  assert.equal((await a.req('PUT', '/api/admin/settings', { impact_rate: 30, helpdesk_email: 'not-an-email' })).status, 400);
  assert.equal((await a.req('PUT', '/api/admin/settings', { impact_rate: 30, helpdesk_email: 'helpdesk@example.com' })).status, 200);
  assert.equal((await anon.get('/api/public-config')).data.helpdeskEmail, 'helpdesk@example.com');
});

test('audit log records admin actions', async () => {
  const n = (await one(`SELECT count(*)::int AS n FROM audit_log WHERE action IN ('opp.create','hours.approved','account.reset','roster.imported','kiosk.opened')`)).n;
  assert.ok(n >= 5);
});

test('profile check-in: confirm, request a change, and admin review rules', async () => {
  const pb = (await one(`INSERT INTO branches (name, market_id) VALUES ('Check HQ', $1) RETURNING id`, [M['Permian Basin']])).id;
  const lb = (await one(`INSERT INTO branches (name, market_id) VALUES ('Check Lubbock', $1) RETURNING id`, [M.Lubbock])).id;
  const dep = (await one(`INSERT INTO departments (name) VALUES ('Check Dept') RETURNING id`)).id;
  await q(`UPDATE settings SET value='12' WHERE key='profile_check_months'`);

  // Never confirmed, so the check-in is due; confirming clears it.
  const e = await new Client().login('leo.lbk');
  assert.equal((await e.get('/api/me')).data.checkin.due, true);
  assert.equal((await e.post('/api/me/confirm')).status, 200);
  assert.equal((await e.get('/api/me')).data.checkin.due, false);
  // Overdue again after a year
  await q(`UPDATE employees SET info_confirmed_at = now() - interval '13 months' WHERE id=$1`, [ids.lbkEmp]);
  assert.equal((await e.get('/api/me')).data.checkin.due, true);

  // An empty request is refused; a real one is stored and does NOT change the profile yet.
  assert.equal((await e.post('/api/me/change-request', {})).status, 400);
  const r1 = await e.post('/api/me/change-request', { department_id: dep, manager_name: 'Pat Doe', note: 'New team' });
  assert.equal(r1.status, 200);
  const me = (await e.get('/api/me')).data;
  assert.equal(me.user.department_id, null);
  assert.equal(me.checkin.due, false);
  assert.ok(me.checkin.pending);
  assert.equal((await e.post('/api/me/change-request', { note: 'again' })).status, 409, 'one pending request at a time');

  // A Market admin in another market can't see or decide it; the Lubbock one can.
  const outside = await new Client().login('max.mkt');
  assert.equal((await outside.get('/api/admin/profile-requests')).status, 403);
  const lu = await new Client().login('lu.mkta');
  const list = (await lu.get('/api/admin/profile-requests')).data.rows;
  assert.equal(list.length, 1);
  assert.equal((await lu.post(`/api/admin/profile-requests/${r1.data.id}/decide`, { decision: 'rejected' })).status, 400, 'decline needs a reason');
  assert.equal((await lu.post(`/api/admin/profile-requests/${r1.data.id}/decide`, { decision: 'approved' })).status, 200);
  const after = await one('SELECT department_id, manager_name FROM employees WHERE id=$1', [ids.lbkEmp]);
  assert.equal(after.department_id, dep);
  assert.equal(after.manager_name, 'Pat Doe');

  // A branch in another market needs an Administrator.
  const r2 = await e.post('/api/me/change-request', { branch_id: pb });
  assert.equal(r2.status, 200);
  assert.equal((await lu.post(`/api/admin/profile-requests/${r2.data.id}/decide`, { decision: 'approved' })).status, 403);
  const admin = await new Client().login('ana.admin');
  assert.equal((await admin.post(`/api/admin/profile-requests/${r2.data.id}/decide`, { decision: 'approved' })).status, 200);
  const moved = await one('SELECT branch_id, market_id FROM employees WHERE id=$1', [ids.lbkEmp]);
  assert.equal(moved.branch_id, pb);
  assert.equal(moved.market_id, M['Permian Basin']);
  await q('UPDATE employees SET market_id=$2, branch_id=$3 WHERE id=$1', [ids.lbkEmp, M.Lubbock, lb]);

  // Nobody approves their own change.
  const r3 = await (await new Client().login('lu.mkta')).post('/api/me/change-request', { note: 'my title is wrong' });
  assert.equal((await lu.post(`/api/admin/profile-requests/${r3.data.id}/decide`, { decision: 'approved' })).status, 403);

  // Admin can turn the check-in off.
  assert.equal((await admin.req('PUT', '/api/admin/settings', { impact_rate: 30, profile_check_months: 0 })).status, 200);
  await q(`UPDATE employees SET info_confirmed_at = NULL WHERE id=$1`, [ids.emp]);
  assert.equal((await (await new Client().login('eli.emp')).get('/api/me')).data.checkin.due, false);
  assert.equal((await admin.req('PUT', '/api/admin/settings', { impact_rate: 30, profile_check_months: 3 })).status, 400);
  await admin.req('PUT', '/api/admin/settings', { impact_rate: 30, profile_check_months: 12 });
});

test('full preview needs a signed-in user', async () => {
  const anon = await new Client().get('/preview');
  assert.equal(anon.status, 302);
  const signed = await (await new Client().login('eli.emp')).get('/preview');
  assert.equal(signed.status, 200);
});

test('waitlist moves people up first come, first served', async () => {
  const a = await new Client().login('ana.admin');
  const body = cap => ({ otype: 'community', market_id: M['Permian Basin'], title: 'Coat drive', nonprofit: 'Coats', location: 'HQ',
    shifts: [{ id: wsid, date: addDays(5), start: '09:00', end: '11:00', capacity: cap }] });
  let wsid;
  const o = await a.post('/api/admin/opps', { ...body(1), shifts: [{ date: addDays(5), start: '09:00', end: '11:00', capacity: 1 }] });
  wsid = (await one('SELECT id FROM shifts WHERE opp_id=$1', [o.data.id])).id;
  const eli = await new Client().login('eli.emp'), eva = await new Client().login('eva.emp'), it = await new Client().login('ivy.it'), cc = await new Client().login('cc.ccm');
  assert.deepEqual((await eli.post(`/api/opps/${o.data.id}/signup`, { shiftIds: [wsid] })).data.added, [wsid]);
  assert.deepEqual((await eva.post(`/api/opps/${o.data.id}/signup`, { shiftIds: [wsid] })).data.waitlisted, [wsid]);
  assert.deepEqual((await it.post(`/api/opps/${o.data.id}/signup`, { shiftIds: [wsid] })).data.waitlisted, [wsid]);
  assert.deepEqual((await cc.post(`/api/opps/${o.data.id}/signup`, { shiftIds: [wsid] })).data.waitlisted, [wsid]);
  const d = await it.get(`/api/opps/${o.data.id}`);
  const sh = d.data.shifts.find(x => x.id === wsid);
  assert.equal(sh.waiting, 3); assert.equal(sh.my_place, 2);
  // Eli cancels: Eva (first in line) moves up
  const sid = (await one('SELECT id FROM signups WHERE shift_id=$1 AND employee_id=$2', [wsid, ids.emp])).id;
  assert.equal((await eli.req('DELETE', `/api/signups/${sid}`)).status, 200);
  const evaAct = await eva.get('/api/activity');
  assert.ok(evaAct.data.upcoming.some(u => u.shift_id === wsid || u.opp_id === o.data.id && u.from_waitlist), 'Eva moved up');
  assert.equal((await it.get('/api/activity')).data.waiting[0].place, 1, 'IT is now first in line');
  // Admin adds a spot: IT moves up next, committee member stays waiting
  assert.equal((await a.req('PUT', `/api/admin/opps/${o.data.id}`, body(2))).status, 200);
  const signed = (await q('SELECT employee_id FROM signups WHERE shift_id=$1 ORDER BY id', [wsid])).rows.map(r => r.employee_id);
  assert.deepEqual(signed, [ids.emp2, ids.it]);
  assert.equal((await cc.get('/api/activity')).data.waiting.length, 1);
  const ro = await a.get(`/api/admin/opps/${o.data.id}/roster`);
  assert.deepEqual(ro.data.waiting.map(w => w.first_name), ['cc']);
});

test('CRA questions on events and logged hours feed the CRA export', async () => {
  const a = await new Client().login('ana.admin');
  const mk = (lmi, fin, otype = 'community') => a.post('/api/admin/opps', { otype, market_id: M['Permian Basin'], title: `CRA ${lmi}${fin}${otype}`, nonprofit: 'Casa', location: 'Casa',
    cra_lmi: lmi, cra_finance: fin, shifts: [{ date: addDays(2), start: '18:00', end: '20:00', capacity: 5 }] });
  const both = await mk(true, true), one1 = await mk(true, false), soc = await mk(true, true, 'social');
  const row = id => one('SELECT cra, cra_lmi, cra_finance FROM opportunities WHERE id=$1', [id]);
  assert.deepEqual(await row(both.data.id), { cra: true, cra_lmi: true, cra_finance: true });
  assert.deepEqual(await row(one1.data.id), { cra: false, cra_lmi: true, cra_finance: false });
  assert.deepEqual(await row(soc.data.id), { cra: false, cra_lmi: false, cra_finance: false }, 'off-the-clock events never count');
  const e = await new Client().login('eva.emp');
  const h = await e.post('/api/hours', { date: addDays(-3), hours: 2, org_name: 'Casa de Amigos', details: 'Taught budgeting', cra_lmi: true, cra_finance: true });
  assert.equal((await a.post(`/api/admin/hours/${h.data.id}/decide`, { decision: 'approved' })).status, 200);
  const c = await new Client().login('cy.comp');
  const csv = await c.get(`/api/admin/reports/hours?year=${today().slice(0, 4)}&cra=1&format=csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.data, /Serves LMI,Uses financial knowledge,CRA qualifying/);
  assert.match(csv.data, /Casa de Amigos.*,Yes,Yes,Yes,/);
});

test('board seats: employees add them, a coordinator reviews, CRA export lists them', async () => {
  const e = await new Client().login('eva.emp');
  assert.equal((await e.post('/api/board-seats', { org_name: 'Habitat', title: 'Treasurer', start_date: addDays(-400), is_current: false, description: 'x' })).status, 400, 'end date needed');
  const s = await e.post('/api/board-seats', { org_name: 'Habitat for Humanity', title: 'Treasurer', start_date: addDays(-400), is_current: true, description: 'Board finance', cra_lmi: true, cra_finance: true });
  assert.equal(s.status, 200);
  const other = await new Client().login('eli.emp');
  assert.equal((await other.req('DELETE', `/api/board-seats/${s.data.id}`)).status, 404, 'cannot touch someone else\'s seat');
  assert.equal((await new Client().login('lu.mkta').then(m => m.post(`/api/admin/board-seats/${s.data.id}/decide`, { decision: 'approved' }))).status, 403, 'other market');
  const a = await new Client().login('ana.admin');
  assert.ok((await a.get('/api/admin/board-seats?status=pending')).data.rows.some(x => x.id === s.data.id));
  assert.equal((await a.post(`/api/admin/board-seats/${s.data.id}/decide`, { decision: 'rejected' })).status, 400, 'decline needs a reason');
  assert.equal((await a.post(`/api/admin/board-seats/${s.data.id}/decide`, { decision: 'approved' })).status, 200);
  const own = await a.post('/api/board-seats', { org_name: 'Rotary', title: 'Member', start_date: addDays(-10), is_current: true, description: 'Club' });
  assert.equal((await a.post(`/api/admin/board-seats/${own.data.id}/decide`, { decision: 'approved' })).status, 403, 'no self-approval');
  const csv = await (await new Client().login('cy.comp')).get('/api/admin/board-seats?format=csv');
  assert.equal(csv.status, 200);
  assert.match(csv.data, /Habitat for Humanity,Treasurer,Yes,.*,Yes,Yes,Yes,Board finance,approved/);
  // Editing sends it back for review
  assert.equal((await e.req('PUT', `/api/board-seats/${s.data.id}`, { org_name: 'Habitat for Humanity', title: 'Chair', start_date: addDays(-400), is_current: true, description: 'Board chair', cra_lmi: true, cra_finance: true })).status, 200);
  assert.equal((await one('SELECT status FROM board_seats WHERE id=$1', [s.data.id])).status, 'pending');
});

test('volunteer résumé shows approved hours and approved seats only', async () => {
  const a = await new Client().login('ana.admin');
  const e = await new Client().login('eli.emp');
  const seat = await e.post('/api/board-seats', { org_name: 'United Way', title: 'Board member', start_date: addDays(-100), is_current: true, description: 'Allocations' });
  let r = await e.get('/api/resume');
  assert.equal(r.status, 200);
  assert.ok(!r.data.seats.some(x => x.org_name === 'United Way'), 'pending seat not shown');
  await a.post(`/api/admin/board-seats/${seat.data.id}/decide`, { decision: 'approved' });
  r = await e.get('/api/resume');
  assert.ok(r.data.seats.some(x => x.org_name === 'United Way'));
  assert.ok(r.data.totals.hours >= 2, 'approved Habitat hours from earlier test');
  assert.equal(r.data.totals.rate, 30);
  assert.ok(r.data.activity.every(x => x.hours > 0));
});
