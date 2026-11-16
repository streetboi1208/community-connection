'use strict';

class Bad extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

const str = (v, name, { max = 200, required = true } = {}) => {
  const s = v == null ? '' : String(v).trim();
  if (!s && required) throw new Bad(`${name} is required.`);
  if (s.length > max) throw new Bad(`${name} is too long (max ${max}).`);
  return s || null;
};
const int = (v, name, { min = -Infinity, max = Infinity, required = true } = {}) => {
  if ((v === undefined || v === null || v === '') && !required) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Bad(`${name} is not valid.`);
  return n;
};
const bool = v => v === true || v === 'true' || v === 1 || v === '1' || v === 'yes' || v === 'Y' || v === 'y';
const isoDate = (v, name, { required = true } = {}) => {
  if (!v && !required) return null;
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s + 'T00:00:00Z'))) throw new Bad(`${name} must be a date (YYYY-MM-DD).`);
  return s;
};
const hhmm = (v, name) => {
  const s = String(v || '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new Bad(`${name} must be a time (HH:MM).`);
  return s;
};
const oneOf = (v, name, list) => { if (!list.includes(v)) throw new Bad(`${name} is not valid.`); return v; };

// Today's date in the bank's time zone (Central).
const TZ = process.env.APP_TZ || 'America/Chicago';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// CSV helpers (RFC 4180-ish)
function parseCsv(text) {
  const rows = []; let row = []; let f = ''; let i = 0; let inQ = false;
  text = String(text || '').replace(/^﻿/, '');
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else inQ = false; } else f += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
    i++;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim() !== ''));
}
// Neutralize spreadsheet formula injection in exported cells.
const csvCell = v => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (headers, rows) => [headers.map(csvCell).join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\r\n') + '\r\n';

module.exports = { Bad, str, int, bool, isoDate, hhmm, oneOf, today, parseCsv, toCsv, TZ };
