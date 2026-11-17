'use strict';
const { audit } = require('./db');

// Spots used on a shift: each sign-up plus the guests they bring.
const SPOTS = 'COALESCE(sum(1 + jsonb_array_length(guests)), 0)::int';

// Fill open spots on a shift from its waitlist, oldest first (first come, first served).
// Runs inside the caller's transaction.
async function promoteWaitlist(c, shiftId) {
  const s = (await c.query('SELECT id, capacity FROM shifts WHERE id=$1 FOR UPDATE', [shiftId])).rows[0];
  if (!s) return [];
  const moved = [];
  for (;;) {
    const n = (await c.query(`SELECT ${SPOTS} AS n FROM signups WHERE shift_id=$1`, [shiftId])).rows[0].n;
    if (n >= s.capacity) break;
    const w = (await c.query('SELECT id, employee_id, shirt_size, guests FROM waitlist WHERE shift_id=$1 ORDER BY created_at, id LIMIT 1 FOR UPDATE', [shiftId])).rows[0];
    if (!w) break;
    if (n + 1 + w.guests.length > s.capacity) break; // first in line goes first, with their guests
    await c.query('DELETE FROM waitlist WHERE id=$1', [w.id]);
    const ins = await c.query(
      'INSERT INTO signups (shift_id, employee_id, shirt_size, guests, from_waitlist) VALUES ($1,$2,$3,$4,true) ON CONFLICT DO NOTHING', [shiftId, w.employee_id, w.shirt_size, JSON.stringify(w.guests)]);
    if (ins.rowCount) {
      moved.push(w.employee_id);
      await audit(null, 'waitlist.promoted', `shift:${shiftId}`, { employee: w.employee_id }, c);
    }
  }
  return moved;
}
module.exports = { promoteWaitlist, SPOTS };
