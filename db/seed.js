'use strict';
// SAMPLE DATA ONLY. Never run against a database holding real employee records.
// Creates fictional employees, one demo account per role, and sample opportunities.
const { pool, one, q } = require('../src/db');
const { migrate } = require('./migrate');
const { importGalaxy } = require('./import-galaxy');
const { hashPassword, tempPassword } = require('../src/auth');
const { today } = require('../src/util');

const BR = { 'Permian Basin': ['Midland HQ', 'A Street', 'Cuthbert', 'Odessa HQ', 'Big Spring'], Lubbock: ['Lubbock HQ', 'Lubbock 82nd St'], Dallas: ['Dallas Uptown'] };
const DEPTS = ['Retail Banking', 'Commercial Lending', 'Mortgage', 'Operations', 'Marketing', 'Compliance', 'Human Resources', 'Treasury Management'];
const FIRST = 'Ashley Luis Maria Rosa Tara Daniel James Priya Brooke Mia Carlos Hannah Ethan Olivia Noah Sofia Liam Grace Diego Emma Mason Ava Lucas Chloe Mateo Lily Owen Zoe Caleb Nora Isaac Ruby Eli Ivy Jonah Leah Gabe Maya Wyatt Elena'.split(' ');
const LAST = 'Walker Perez Garcia Villa Nguyen Kim Torres Shah Hughes Rivera Lopez Brooks Reed Cole Price Diaz Ward Gray Ortiz Bell Hayes Long Ross Fox Cruz Wells Park Lane Stone Hart Moss Lowe Webb Rice Hale Ford Snow West Dunn Kerr'.split(' ');

function addDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function seed() {
  await migrate();
  const exists = await one('SELECT count(*)::int AS n FROM employees');
  if (exists.n > 0 && !process.argv.includes('--force')) { console.log('Employees already exist; seed skipped (use --force on a throwaway database).'); return; }
  if (process.argv.includes('--force')) await q('TRUNCATE board_seats, waitlist, profile_requests, checkins, kiosks, hours, signups, shifts, opportunities, nonprofits, sessions, audit_log, employees, branches, departments RESTART IDENTITY CASCADE');

  const mk = Object.fromEntries((await q('SELECT id, name FROM markets')).rows.map(r => [r.name, r.id]));
  const br = {};
  for (const [m, list] of Object.entries(BR)) for (const b of list) br[b] = (await one('INSERT INTO branches (name, market_id) VALUES ($1,$2) RETURNING id', [b, mk[m]])).id;
  const dp = {};
  for (const d of DEPTS) dp[d] = (await one('INSERT INTO departments (name) VALUES ($1) RETURNING id', [d])).id;

  // 120 fictional employees: 70 Permian Basin, 32 Lubbock, 18 Dallas
  const plan = [['Permian Basin', 70], ['Lubbock', 32], ['Dallas', 18]];
  let n = 0; const emps = [];
  for (const [m, count] of plan) {
    for (let i = 0; i < count; i++, n++) {
      const branches = BR[m];
      const e = await one(
        `INSERT INTO employees (emp_no, first_name, last_name, market_id, branch_id, department_id, title, officer, hire_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, market_id`,
        [`E${String(1001 + n)}`, FIRST[n % FIRST.length], LAST[(n * 7) % LAST.length], mk[m], br[branches[i % branches.length]],
          dp[DEPTS[i % DEPTS.length]], i % 5 === 0 ? 'Vice President' : 'Banker', i % 5 === 0, addDays('2018-01-15', n * 23)]);
      emps.push(e);
    }
  }

  // Demo accounts, one per role. Passwords are printed once and must be changed at first sign-in.
  const demo = [
    ['demo.admin', ['admin'], 'Permian Basin', 'Demo', 'Administrator'],
    ['demo.employee', [], 'Permian Basin', 'Demo', 'Employee'],
    ['demo.marketing', ['mkt'], 'Permian Basin', 'Demo', 'Marketing'],
    ['demo.compliance', ['comp'], 'Permian Basin', 'Demo', 'Compliance'],
    ['demo.committee', ['ccm'], 'Permian Basin', 'Demo', 'Committee'],
    ['demo.lubbock', ['mkta'], 'Lubbock', 'Demo', 'Lubbock Admin'],
    ['demo.helpdesk', ['it'], 'Permian Basin', 'Demo', 'Help Desk']
  ];
  const creds = [];
  for (const [u, roles, m, f, l] of demo) {
    const pw = process.env.DEMO_PASSWORD || tempPassword();
    await q(`INSERT INTO employees (emp_no, first_name, last_name, market_id, branch_id, username, pass_hash, must_change, roles)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [`D-${u}`, f, l, mk[m], br[BR[m][0]], u, hashPassword(pw), !process.env.DEMO_PASSWORD, roles]);
    creds.push([u, pw]);
  }

  // Fictional managers so the profile check-in has something to show.
  await q(`UPDATE employees e SET manager_name = CASE m.name WHEN 'Lubbock' THEN 'Jordan Blake' WHEN 'Dallas' THEN 'Renee Castillo' ELSE 'Morgan Hale' END
             FROM markets m WHERE m.id = e.market_id AND e.manager_name IS NULL`);
  const t = today();
  const opps = [
    ['community', 'Mobile Food Pantry', 'West Texas Food Bank', 'Permian Basin', 'Mobile pantry site, Odessa', '1601 Westcliff Dr, Odessa, TX', 'Help hand out fresh produce and shelf-stable food to families. Closed-toe shoes required.', true, false, [[1, '08:00', '11:00', 12], [8, '08:00', '11:00', 12]]],
    ['community', 'Holiday Meal Delivery', 'Meals on Wheels', 'Permian Basin', 'Meals on Wheels kitchen', '2400 W Wall St, Midland, TX', 'Deliver warm meals to homebound seniors. Drivers need a valid license.', false, false, [[4, '10:30', '12:30', 10]]],
    ['community', 'Homebuying class for first-time buyers', 'Casa de Amigos', 'Permian Basin', 'Casa de Amigos', '1101 Garfield St, Midland, TX', 'Teach the basics of budgeting and homebuying.', false, true, [[10, '18:00', '20:00', 4]]],
    ['community', 'Produce sort', 'South Plains Food Bank', 'Lubbock', 'South Plains Food Bank', '5605 MLK Blvd, Lubbock, TX', 'Sort donated produce for distribution.', true, false, [[3, '09:00', '12:00', 15]]],
    ['community', 'Reading buddies', 'Dallas Public Library (sample)', 'Dallas', 'Uptown branch library', 'Dallas, TX', 'Read with elementary students after school.', false, true, [[6, '15:30', '17:00', 6]]],
    ['bank', 'Christmas Parade Float Build', null, 'Permian Basin', 'CNB Midland HQ, back lot', 'Midland, TX', 'Help build and decorate the CNB parade float.', true, false, [[12, '17:30', '20:30', 20]]]
  ];
  for (const [otype, title, np, m, loc, addr, desc, shirts, cra, shifts] of opps) {
    const npId = np ? (await one('INSERT INTO nonprofits (name, market_id) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id', [np, mk[m]])).id : null;
    const o = await one(
      `INSERT INTO opportunities (otype, title, nonprofit_id, market_id, location, address, description, collect_shirts, cra, cra_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [otype, title, npId, mk[m], loc, addr, desc, shirts, cra, cra ? 'Financial education for low- and moderate-income families' : null]);
    for (const [d, s, e, cap] of shifts) await q('INSERT INTO shifts (opp_id, date, start_time, end_time, capacity) VALUES ($1,$2,$3,$4,$5)', [o.id, addDays(t, d), s, e, cap]);
  }

  // Past approved hours for about 40% of employees so reports have something to show.
  for (let i = 0; i < emps.length; i++) {
    if (i % 5 > 1) continue;
    const e = emps[i];
    await q(`INSERT INTO hours (employee_id, source, date, minutes, otype, org_name, details, status)
             VALUES ($1,'admin',$2,$3,$4,$5,'Sample past volunteering','approved')`,
      [e.id, addDays(t, -((i * 11) % 200) - 1), 60 * (1 + (i % 4)), i % 7 === 0 ? 'bank' : 'community', i % 7 === 0 ? 'CNB event' : 'Sample nonprofit']);
  }

  console.log('\nSample data loaded. Demo sign-ins (change at first sign-in):');
  for (const [u, pw] of creds) console.log(`  ${u.padEnd(18)} ${pw}`);
}

seed().then(() => importGalaxy()).then(() => pool.end()).catch(e => { console.error(e); process.exit(1); });
