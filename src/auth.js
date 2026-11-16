'use strict';
const crypto = require('crypto');
const { one, q, audit } = require('./db');

const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const COOKIE = 'cc_session';

// ---- passwords (scrypt, built into Node) ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
function checkPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, s, k] = stored.split('$');
  const want = Buffer.from(k, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(s, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}
// Rules: 10+ characters, not all one type, not the username.
function passwordProblem(pw, username) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 200) return 'That password is too long.';
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return "Don't include your username.";
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  if (kinds < 2) return 'Mix at least two of: lowercase, uppercase, numbers, symbols.';
  return null;
}
// Readable temporary password an admin reads to an employee, e.g. "Maple-Rocket-4821".
const WORDS = 'Amber Anchor Aspen Beacon Bison Canyon Cedar Comet Coral Cotton Falcon Harbor Juniper Lantern Maple Mesa Meteor Orchard Pecan Prairie Quartz Ranger Rocket Saddle Sierra Spruce Summit Thunder Willow Yucca'.split(' ');
function tempPassword() {
  const w = () => WORDS[crypto.randomInt(WORDS.length)];
  return `${w()}-${w()}-${crypto.randomInt(1000, 10000)}`;
}

// ---- sessions ----
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
function newToken() { return crypto.randomBytes(32).toString('base64url'); }

async function createSession(res, req, employeeId) {
  const token = newToken();
  await q(
    `INSERT INTO sessions (token_hash, employee_id, expires_at, ip, user_agent)
     VALUES ($1,$2, now() + ($3 || ' hours')::interval, $4, $5)`,
    [sha(token), employeeId, String(SESSION_HOURS), req.ip, String(req.get('user-agent') || '').slice(0, 300)]
  );
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_HOURS * 3600 * 1000,
    path: '/'
  });
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Loads req.user when a valid session cookie is present.
async function loadUser(req, res, next) {
  try {
    const token = readCookie(req, COOKIE);
    if (token) {
      const u = await one(
        `SELECT e.id, e.first_name, e.last_name, e.username, e.roles, e.market_id, m.name AS market,
                e.must_change, e.active, s.token_hash
           FROM sessions s JOIN employees e ON e.id = s.employee_id JOIN markets m ON m.id = e.market_id
          WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [sha(token)]
      );
      if (u && u.active) {
        req.user = u;
        q('UPDATE sessions SET last_seen = now() WHERE token_hash=$1', [u.token_hash]).catch(() => {});
      }
    }
    next();
  } catch (e) { next(e); }
}

async function destroySession(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) await q('DELETE FROM sessions WHERE token_hash=$1', [sha(token)]);
  res.clearCookie(COOKIE, { path: '/' });
}

async function login(req, res) {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const generic = { error: 'That username and password combination is not right.' };
  if (!username || !password) return res.status(400).json(generic);
  const u = await one('SELECT id, pass_hash, failed_logins, locked_until, active, must_change FROM employees WHERE lower(username)=$1', [username]);
  if (!u || !u.active) { checkPassword(password, 'scrypt$AAAA$AAAA'); return res.status(401).json(generic); }
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    return res.status(423).json({ error: `Too many tries. Try again in ${LOCK_MINUTES} minutes or ask an admin to reset your password.` });
  }
  if (!checkPassword(password, u.pass_hash)) {
    const fails = u.failed_logins + 1;
    if (fails >= MAX_FAILS) {
      await q(`UPDATE employees SET failed_logins=0, locked_until = now() + ($2 || ' minutes')::interval WHERE id=$1`, [u.id, String(LOCK_MINUTES)]);
      await audit(u.id, 'login.locked', `employee:${u.id}`);
    } else {
      await q('UPDATE employees SET failed_logins=$2 WHERE id=$1', [u.id, fails]);
    }
    await audit(u.id, 'login.failed', `employee:${u.id}`, { ip: req.ip });
    return res.status(401).json(generic);
  }
  await q('UPDATE employees SET failed_logins=0, locked_until=NULL WHERE id=$1', [u.id]);
  await createSession(res, req, u.id);
  await audit(u.id, 'login.ok', `employee:${u.id}`, { ip: req.ip });
  res.json({ ok: true, mustChange: u.must_change });
}

// ---- guards ----
function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  if (req.user.must_change && !req.allowMustChange) return res.status(403).json({ error: 'Please set a new password first.', mustChange: true });
  next();
}
// Roles: admin (everything), mkt (Marketing), comp (Compliance), ccm (Culture Committee), mkta (Market admin)
const can = (user, perm) => {
  const r = user?.roles || [];
  if (r.includes('admin')) return true;
  const P = {
    'opps.create': ['mkt', 'mkta'],
    'opps.createVolunteer': ['mkta'],
    'rosters.view': ['mkt', 'ccm', 'mkta'],
    'kiosk.run': ['ccm'],
    'people.view': ['mkta'],
    'people.edit': ['mkta'],
    'hours.approve': ['mkta'],
    'reports.hours': ['comp', 'mkta'],
    'reports.cra': ['comp'],
    'roster.import': [],
    'roles.assign': [],
    'settings.edit': []
  }[perm] || [];
  return r.some(x => P.includes(x));
};
// Market admins (and only they) are limited to the market on their own profile.
const marketScope = user => (user.roles.includes('admin') ? null : (user.roles.includes('mkta') ? user.market_id : null));
const isAdminish = user => (user?.roles || []).length > 0;

function requirePerm(...perms) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
    if (req.user.must_change) return res.status(403).json({ error: 'Please set a new password first.', mustChange: true });
    if (!perms.some(p => can(req.user, p))) return res.status(403).json({ error: "You don't have access to that." });
    next();
  };
}

module.exports = {
  hashPassword, checkPassword, passwordProblem, tempPassword,
  loadUser, login, destroySession, createSession,
  requireUser, requirePerm, can, marketScope, isAdminish, sha, newToken
};
