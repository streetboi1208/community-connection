'use strict';
// Custom report builder: admins pick a period, filters, a "group by", sorting and a top-N limit,
// and get a table they can export to CSV or print. Also: friends-and-family by employee, and saved reports.
const { q, one, many, audit, setting } = require('../db');
const A = require('../auth');
const { Bad, str, int, isoDate, oneOf, toCsv } = require('../util');

// Groupings. `roster: true` means the group is a property of the employee, so we can also count
// everyone on the roster in it (for participation %) and list who hasn't volunteered.
const GROUPS = {
  person: { label: 'Employee', key: 'e.id::text', name: "e.first_name || ' ' || e.last_name", roster: true },
  market: { label: 'Market', key: 'mk.name', roster: true },
  branch: { label: 'Branch', key: "COALESCE(b.name, '(no branch)')", roster: true },
  department: { label: 'Department', key: "COALESCE(d.name, '(no department)')", roster: true },
  officer: { label: 'Officer or not', key: "CASE WHEN e.officer THEN 'Officers' ELSE 'Non-officers' END", roster: true },
  title: { label: 'Officer level / job group', key: "COALESCE(NULLIF(e.title, ''), '(none)')", roster: true },
  committee: { label: 'Culture Committee', key: "CASE WHEN e.culture_committee THEN 'Culture Committee' ELSE 'Everyone else' END", roster: true },
  nonprofit: { label: 'Nonprofit', key: "COALESCE(h.org, '(none)')" },
  event: { label: 'Event', key: "h.event_date_key", name: 'h.event_label' },
  otype: { label: 'Type', key: "CASE h.otype WHEN 'community' THEN 'Community volunteering' ELSE 'CNB events' END" },
  week: { label: 'Week of', key: "to_char(date_trunc('week', h.date), 'YYYY-MM-DD')" },
  month: { label: 'Month', key: "to_char(h.date, 'YYYY-MM')" },
  quarter: { label: 'Quarter', key: "to_char(h.date, 'YYYY-\"Q\"Q')" },
  year: { label: 'Year', key: "to_char(h.date, 'YYYY')" }
};
const SORTS = ['group', 'employees', 'volunteers', 'participation', 'records', 'hours', 'impact', 'hours_each'];

function readParams(src, user) {
  const p = {};
  const today = new Date().toISOString().slice(0, 10);
  p.from = src.from ? isoDate(src.from, 'From') : `${today.slice(0, 4)}-01-01`;
  p.to = src.to ? isoDate(src.to, 'To') : `${today.slice(0, 4)}-12-31`;
  if (p.to < p.from) throw new Bad('The end date is before the start date.');
  p.group = oneOf(src.group || 'person', 'Group by', Object.keys(GROUPS));
  p.market = src.market ? int(src.market, 'Market', { min: 1 }) : null;
  const scope = A.marketScope(user);
  if (scope) {
    if (p.market && p.market !== scope) throw new Bad('That market is outside your access.', 403);
    p.market = scope;
  }
  p.branch = src.branch ? int(src.branch, 'Branch', { min: 1 }) : null;
  p.department = src.department ? int(src.department, 'Department', { min: 1 }) : null;
  p.title = src.title ? str(src.title, 'Officer level / job group', { max: 80 }) : null;
  p.officer = src.officer ? oneOf(src.officer, 'Officer', ['yes', 'no']) : null;
  p.committee = src.committee ? oneOf(src.committee, 'Culture Committee', ['yes', 'no']) : null;
  p.otype = src.otype ? oneOf(src.otype, 'Type', ['community', 'bank']) : null;
  p.nonprofit = src.nonprofit ? str(src.nonprofit, 'Nonprofit', { max: 200 }) : null;
  p.cra = src.cra ? oneOf(src.cra, 'CRA', ['any', 'qualifying']) : null;
  if (p.cra && !A.can(user, 'reports.cra')) throw new Bad("You don't have access to CRA reports.", 403);
  p.who = oneOf(src.who || 'volunteered', 'Who', ['volunteered', 'all', 'not']);
  p.minTimes = src.minTimes ? int(src.minTimes, 'At least', { min: 1, max: 1000 }) : null;
  p.maxTimes = src.maxTimes ? int(src.maxTimes, 'At most', { min: 1, max: 1000 }) : null;
  p.sort = oneOf(src.sort || 'hours', 'Sort', SORTS);
  p.dir = oneOf(src.dir || (p.sort === 'group' ? 'asc' : 'desc'), 'Order', ['asc', 'desc']);
  p.top = src.top ? int(src.top, 'Top', { min: 1, max: 5000 }) : null;
  if (!GROUPS[p.group].roster && p.who !== 'volunteered') p.who = 'volunteered';
  return p;
}

async function runReport(p) {
  const G = GROUPS[p.group];
  const rate = Number(await setting('impact_rate', 34.99));
  // Employee filters ($1..) and hour filters, built with numbered parameters.
  const args = [p.from, p.to];
  const arg = v => { args.push(v); return `$${args.length}`; };
  const ef = [];
  if (p.market) ef.push(`e.market_id = ${arg(p.market)}`);
  if (p.branch) ef.push(`e.branch_id = ${arg(p.branch)}`);
  if (p.department) ef.push(`e.department_id = ${arg(p.department)}`);
  if (p.title) ef.push(`e.title = ${arg(p.title)}`);
  if (p.officer) ef.push(`e.officer = ${p.officer === 'yes'}`);
  if (p.committee) ef.push(`e.culture_committee = ${p.committee === 'yes'}`);
  const hf = [];
  if (p.otype) hf.push(`h.otype = ${arg(p.otype)}`);
  if (p.nonprofit) hf.push(`COALESCE(n.name, h.org_name) = ${arg(p.nonprofit)}`);
  if (p.cra === 'qualifying') hf.push('COALESCE(o.cra_lmi, h.cra_lmi) AND COALESCE(o.cra_finance, h.cra_finance)');
  if (p.cra === 'any') hf.push('(COALESCE(o.cra_lmi, h.cra_lmi) OR COALESCE(o.cra_finance, h.cra_finance))');
  const H = `SELECT h.id, h.employee_id, h.date, h.minutes, h.otype, COALESCE(n.name, h.org_name) AS org,
      regexp_replace(COALESCE(o.title, h.details, ''), ' ?\\(Galaxy import\\)$', '') AS event_label,
      regexp_replace(COALESCE(o.title, h.details, ''), ' ?\\(Galaxy import\\)$', '') || ' · ' || COALESCE(n.name, h.org_name, '') || ' · ' || h.date AS event_date_key
    FROM hours h LEFT JOIN opportunities o ON o.id = h.opp_id LEFT JOIN nonprofits n ON n.id = o.nonprofit_id
    WHERE h.status = 'approved' AND h.date BETWEEN $1 AND $2 ${hf.length ? 'AND ' + hf.join(' AND ') : ''}`;
  const E = `employees e JOIN markets mk ON mk.id = e.market_id LEFT JOIN branches b ON b.id = e.branch_id LEFT JOIN departments d ON d.id = e.department_id`;
  const where = ef.length ? 'WHERE ' + ef.join(' AND ') : '';
  const nameExpr = G.name || G.key;
  const person = p.group === 'person';
  const extra = person ? `, max(mk.name) AS market, max(b.name) AS branch, max(d.name) AS department, max(e.title) AS title, bool_or(e.active) AS active` : '';
  const having = [];
  if (person && p.minTimes) having.push(`count(h.id) >= ${p.minTimes}`);
  if (person && p.maxTimes) having.push(`count(h.id) <= ${p.maxTimes}`);
  if (p.who === 'not') having.push('count(h.id) = 0');
  // Who hasn't volunteered: start from everyone active on the roster (LEFT JOIN); otherwise only people with hours.
  const join = p.who === 'volunteered' ? 'JOIN' : 'LEFT JOIN';
  const rosterOnly = p.who === 'volunteered' ? '' : `${where ? ' AND' : 'WHERE'} (e.active OR h.id IS NOT NULL) AND e.emp_no NOT LIKE 'D-%'`;
  const rows = await many(
    `WITH h AS (${H})
     SELECT ${G.key} AS gkey, max(${nameExpr}) AS label, count(DISTINCT h.employee_id)::int AS volunteers, count(h.id)::int AS records,
            COALESCE(sum(h.minutes), 0)::int AS minutes, COALESCE(sum(h.minutes) FILTER (WHERE h.otype = 'community'), 0)::int AS comm ${extra}
       FROM ${E} ${join} h ON h.employee_id = e.id ${where} ${rosterOnly}
      GROUP BY 1 ${having.length ? 'HAVING ' + having.join(' AND ') : ''}`, args);
  // Roster counts per group, for participation % (active employees only, demo accounts excluded).
  let roster = null;
  if (G.roster && !person) {
    const eargs = []; const efilt = [];
    const earg = v => { eargs.push(v); return `$${eargs.length}`; };
    if (p.market) efilt.push(`e.market_id = ${earg(p.market)}`);
    if (p.branch) efilt.push(`e.branch_id = ${earg(p.branch)}`);
    if (p.department) efilt.push(`e.department_id = ${earg(p.department)}`);
    if (p.title) efilt.push(`e.title = ${earg(p.title)}`);
    if (p.officer) efilt.push(`e.officer = ${p.officer === 'yes'}`);
    if (p.committee) efilt.push(`e.culture_committee = ${p.committee === 'yes'}`);
    efilt.push('e.active', "e.emp_no NOT LIKE 'D-%'");
    const rs = await many(`SELECT ${G.key} AS gkey, count(*)::int AS n FROM ${E} WHERE ${efilt.join(' AND ')} GROUP BY 1`, eargs);
    roster = Object.fromEntries(rs.map(x => [x.gkey, x.n]));
    for (const k of Object.keys(roster)) if (!rows.some(r => r.gkey === k) && p.who !== 'volunteered') rows.push({ gkey: k, label: k, volunteers: 0, records: 0, minutes: 0, comm: 0 });
  }
  let out = rows.map(x => {
    const hours = Math.round(x.minutes / 6) / 10;
    const o = { key: x.gkey, group: x.label || x.gkey, volunteers: x.volunteers, records: x.records, hours, impact: Math.round((x.comm / 60) * rate),
      hours_each: x.volunteers ? Math.round((hours / x.volunteers) * 10) / 10 : 0 };
    if (roster) { o.employees = roster[x.gkey] || 0; o.participation = o.employees ? Math.round((x.volunteers / o.employees) * 1000) / 10 : null; }
    if (person) Object.assign(o, { market: x.market, branch: x.branch, department: x.department, title: x.title, active: x.active });
    return o;
  });
  const val = r => (p.sort === 'group' ? String(r.group).toLowerCase() : (r[p.sort] ?? -1));
  out.sort((a, b) => { const A1 = val(a), B1 = val(b); const c = A1 < B1 ? -1 : A1 > B1 ? 1 : 0; return (p.dir === 'asc' ? c : -c) || String(a.group).localeCompare(String(b.group)); });
  const total = { groups: out.length, records: out.reduce((s, r) => s + r.records, 0), hours: Math.round(out.reduce((s, r) => s + r.hours, 0) * 10) / 10,
    impact: out.reduce((s, r) => s + r.impact, 0) };
  // Distinct volunteers across the whole report (a person can appear in several groups, e.g. by month).
  const v = await one(`WITH h AS (${H}) SELECT count(DISTINCT h.employee_id)::int AS n FROM ${E} JOIN h ON h.employee_id = e.id ${where}`, args);
  total.volunteers = v.n;
  if (p.top) out = out.slice(0, p.top);
  out.forEach((r, i) => { r.rank = i + 1; });
  return { params: p, groupLabel: G.label, rosterGroup: !!G.roster, rate, rows: out, total };
}

// Friends and family: guests (no CNB email) credited to the employee(s) on the same team for that shift.
async function runGuests(p) {
  const args = [p.from, p.to];
  const ef = [];
  if (p.market) { args.push(p.market); ef.push(`e.market_id = $${args.length}`); }
  const rows = await many(
    `WITH g AS (SELECT * FROM guest_hours WHERE date BETWEEN $1 AND $2),
          c AS (SELECT g.*, unnest(CASE WHEN cardinality(g.host_ids) = 0 THEN ARRAY[NULL::int] ELSE g.host_ids END) AS host FROM g)
     SELECT c.host, COALESCE(e.first_name || ' ' || e.last_name, 'Not linked to an employee') AS name, max(b.name) AS branch,
            count(DISTINCT c.guest_code)::int AS guests, count(*)::int AS signups,
            COALESCE(sum(c.minutes) FILTER (WHERE c.otype <> 'other'), 0)::int AS minutes
       FROM c LEFT JOIN employees e ON e.id = c.host LEFT JOIN branches b ON b.id = e.branch_id
      ${ef.length ? 'WHERE (c.host IS NULL OR ' + ef.join(' AND ') + ')' : ''}
      GROUP BY 1, 2 ORDER BY (c.host IS NULL), 4 DESC, 6 DESC, 2`, args);
  const t = await one(`SELECT count(DISTINCT guest_code)::int AS guests, count(*)::int AS signups, COALESCE(sum(minutes) FILTER (WHERE otype <> 'other'), 0)::int AS minutes
                         FROM guest_hours WHERE date BETWEEN $1 AND $2`, [p.from, p.to]);
  let out = rows.map(x => ({ group: x.name, branch: x.branch, guests: x.guests, signups: x.signups, hours: Math.round(x.minutes / 6) / 10, linked: x.host !== null }));
  if (p.top) out = out.filter(r => r.linked).slice(0, p.top).concat(out.filter(r => !r.linked));
  out.forEach((r, i) => { r.rank = r.linked ? i + 1 : null; });
  return { params: p, rows: out, total: { guests: t.guests, signups: t.signups, hours: Math.round(t.minutes / 6) / 10, hosts: rows.filter(x => x.host !== null).length } };
}

module.exports = function reportBuilder(r) {
  const perm = A.requirePerm('reports.hours');

  // Choices for the builder's dropdowns.
  r.get('/reports/options', perm, async (req, res) => {
    const scope = A.marketScope(req.user);
    const [titles, nonprofits, years] = await Promise.all([
      many(`SELECT DISTINCT title FROM employees WHERE title IS NOT NULL AND title <> '' AND emp_no NOT LIKE 'D-%' ORDER BY 1`),
      many(`SELECT DISTINCT COALESCE(n.name, h.org_name) AS name FROM hours h LEFT JOIN opportunities o ON o.id = h.opp_id
              LEFT JOIN nonprofits n ON n.id = o.nonprofit_id WHERE h.status = 'approved' AND COALESCE(n.name, h.org_name) IS NOT NULL ORDER BY 1`),
      many(`SELECT DISTINCT to_char(date, 'YYYY') AS y FROM hours WHERE status = 'approved' ORDER BY 1 DESC`)
    ]);
    res.json({ titles: titles.map(x => x.title), nonprofits: nonprofits.map(x => x.name), years: years.map(x => x.y), scope,
      groups: Object.fromEntries(Object.entries(GROUPS).map(([k, g]) => [k, { label: g.label, roster: !!g.roster }])), cra: A.can(req.user, 'reports.cra') });
  });

  r.get('/reports/custom', perm, async (req, res) => {
    const p = readParams(req.query, req.user);
    if (req.query.kind === 'guests') {
      const g = await runGuests(p);
      if (req.query.format === 'csv') {
        res.type('text/csv').attachment(`friends-and-family-${p.from}-to-${p.to}.csv`);
        return res.send(toCsv(['#', 'Employee who brought them', 'Branch', 'Guests', 'Guest sign-ups', 'Guest volunteer hours'],
          g.rows.map(x => [x.rank ?? '', x.group, x.branch || '', x.guests, x.signups, x.hours])));
      }
      return res.json(g);
    }
    const out = await runReport(p);
    if (req.query.format === 'csv') {
      const person = p.group === 'person';
      const head = ['#', out.groupLabel, ...(person ? ['Market', 'Branch', 'Department', 'Officer level / job group'] : []),
        ...(out.rosterGroup && !person ? ['Employees', 'Participation %'] : []), 'Volunteers', 'Activities', 'Hours', 'Hours each', `Impact $ (community hrs x $${out.rate})`];
      res.type('text/csv').attachment(`report-${p.group}-${p.from}-to-${p.to}.csv`);
      await audit(req.user.id, 'report.exported', `report:${p.group}`, p);
      return res.send(toCsv(head, out.rows.map(x => [x.rank, x.group, ...(person ? [x.market, x.branch, x.department, x.title] : []),
        ...(out.rosterGroup && !person ? [x.employees, x.participation] : []), x.volunteers, x.records, x.hours, x.hours_each, x.impact])));
    }
    res.json(out);
  });

  // Saved reports, shared by everyone who can run reports.
  r.get('/reports/saved', perm, async (req, res) => {
    res.json(await many(`SELECT s.id, s.name, s.params, s.created_at, e.first_name || ' ' || e.last_name AS by
                           FROM saved_reports s LEFT JOIN employees e ON e.id = s.created_by ORDER BY lower(s.name)`));
  });
  r.post('/reports/saved', perm, async (req, res) => {
    const name = str(req.body?.name, 'Report name', { max: 80 });
    const params = req.body?.params && typeof req.body.params === 'object' ? req.body.params : {};
    readParams(params, req.user); // validate
    const keep = Object.fromEntries(Object.entries(params).filter(([k, v]) => ['from', 'to', 'period', 'group', 'market', 'branch', 'department', 'title', 'officer', 'committee', 'otype', 'nonprofit', 'cra', 'who', 'minTimes', 'maxTimes', 'sort', 'dir', 'top', 'kind'].includes(k) && v !== null && v !== '' && typeof v !== 'object').map(([k, v]) => [k, String(v).slice(0, 200)]));
    const s = await one('INSERT INTO saved_reports (name, params, created_by) VALUES ($1,$2,$3) RETURNING id', [name, keep, req.user.id]);
    await audit(req.user.id, 'report.saved', `saved_report:${s.id}`, { name });
    res.json({ ok: true, id: s.id });
  });
  r.delete('/reports/saved/:id', perm, async (req, res) => {
    const id = int(req.params.id, 'id', { min: 1 });
    const s = await one('SELECT created_by FROM saved_reports WHERE id=$1', [id]);
    if (!s) throw new Bad('Report not found.', 404);
    if (s.created_by !== req.user.id && !req.user.roles.includes('admin')) throw new Bad('Only the person who saved it, or an Administrator, can delete it.', 403);
    await q('DELETE FROM saved_reports WHERE id=$1', [id]);
    await audit(req.user.id, 'report.deleted', `saved_report:${id}`);
    res.json({ ok: true });
  });
};
