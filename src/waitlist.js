'use strict';
const { audit } = require('./db');

// Fill open spots on a shift from its waitlist, oldest first (first come, first served).
// Runs inside the caller's transaction.
async function promoteWaitlist(c, shiftId) {
  const s = (await c.query('SELECT id, capacity FROM shifts WHERE id=$1 FOR UPDATE', [shiftId])).rows[0];
  if (!s) return [];
  const moved = [];
  for (;;) {
    const n = (await c.query('SELECT count(*)::int AS n FROM signups WHERE shift_id=$1', [shiftId])).rows[0].n;
    if (n >= s.capacity) break;
    const w = (await c.query('SELECT id, employee_id, shirt_size FROM waitlist WHERE shift_id=$1 ORDER BY created_at, id LIMIT 1 FOR UPDATE', [shiftId])).rows[0];
    if (!w) break;
    await c.query('DELETE FROM waitlist WHERE id=$1', [w.id]);
    const ins = await c.query(
      'INSERT INTO signups (shift_id, employee_id, shirt_size, from_waitlist) VALUES ($1,$2,$3,true) ON CONFLICT DO NOTHING', [shiftId, w.employee_id, w.shirt_size]);
    if (ins.rowCount) {
      moved.push(w.employee_id);
      await audit(null, 'waitlist.promoted', `shift:${shiftId}`, { employee: w.employee_id }, c);
    }
  }
  return moved;
}
module.exports = { promoteWaitlist };
