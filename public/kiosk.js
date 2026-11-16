'use strict';
(function () {
  // The kiosk token arrives in the URL fragment (never sent to the server in logs), then moves to this tab's storage.
  const frag = location.hash.slice(1);
  if (frag) { sessionStorage.setItem('cc_kiosk', frag); history.replaceState(null, '', '/kiosk.html'); }
  const token = sessionStorage.getItem('cc_kiosk');
  const main = document.getElementById('main');
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = m => { const t = document.getElementById('toast'); t.textContent = m; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 3500); };
  async function api(method, path, body) {
    const r = await fetch('/api/kiosk' + path, { method, headers: { 'X-Kiosk': token || '', 'X-Requested-With': 'cc', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Something went wrong.');
    return d;
  }
  let st = null; let lastIn = null;
  const since = t => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  async function load() {
    try { st = await api('GET', '/state'); paint(); } catch (e) { main.innerHTML = `<div class="panel"><h1>Kiosk closed</h1><p>${esc(e.message)}</p></div>`; }
  }
  function paint(results) {
    main.innerHTML = `<div class="panel"><div class="eyebrow">${esc(st.nonprofit || 'Community National Bank')}</div><h1>${esc(st.title)}</h1>
        <p class="muted" style="margin:0">${esc(st.location)} · ${st.checkedIn.length} here now · ${st.checkedOutToday} checked out today${st.otype === 'social' ? ' · attendance only' : ''}</p></div>
      <div class="panel"><h2>Check in</h2><input class="input kbig" id="q" placeholder="Type your name" autocomplete="off" autocapitalize="words">
        <div class="field"><label for="g">Guests with you</label><select class="input" id="g">${[0, 1, 2, 3, 4, 5].map(n => `<option>${n}</option>`).join('')}</select></div>
        <div class="kres" id="res">${results || ''}</div>
        ${lastIn ? `<div class="note ok">${esc(lastIn.name)} is checked in. <button class="btn sm ghost" id="undo">Undo</button></div>` : ''}</div>
      <div class="panel"><h2>Here now</h2>${st.checkedIn.length ? `<div class="kres">${st.checkedIn.map(c => `<button class="btn ghost kbig" data-out="${c.id}" data-n="${esc(c.name)}"><span>${esc(c.name)}${c.guests ? ` +${c.guests}` : ''}</span><small class="muted">in at ${since(c.since)} · tap to check out</small></button>`).join('')}</div>` : '<p class="muted" style="margin:0">Nobody checked in yet.</p>'}</div>
      <div><button class="btn ghost sm" id="close">Close kiosk</button></div>`;
    const q = document.getElementById('q');
    let h;
    q.addEventListener('input', () => { clearTimeout(h); h = setTimeout(() => search(q.value), 250); });
    if (results !== undefined) { q.focus(); }
    main.querySelectorAll('[data-out]').forEach(b => b.addEventListener('click', async () => {
      if (!window.confirm(`Check out ${b.dataset.n}?`)) return;
      try { const r = await api('POST', '/checkout', { employee_id: Number(b.dataset.out) }); toast(st.otype === 'social' ? 'Thanks for coming!' : `Thank you! ${(r.minutes / 60).toFixed(1)} hours logged.`); lastIn = null; load(); } catch (e) { toast(e.message); }
    }));
    const u = document.getElementById('undo');
    if (u) u.addEventListener('click', async () => { try { await api('POST', '/undo', { employee_id: lastIn.id }); toast('Check-in undone.'); lastIn = null; load(); } catch (e) { toast(e.message); } });
    document.getElementById('close').addEventListener('click', async () => {
      if (!window.confirm('Close this kiosk? People still checked in will need to be checked out first or have hours added by an admin.')) return;
      await api('POST', '/close').catch(() => {}); sessionStorage.removeItem('cc_kiosk'); load();
    });
  }
  async function search(text) {
    const res = document.getElementById('res');
    if (text.trim().length < 2) { res.innerHTML = ''; return; }
    try {
      const { rows } = await api('GET', '/search?q=' + encodeURIComponent(text));
      res.innerHTML = rows.length ? rows.map(r => `<button class="btn ${r.checkedIn ? 'ghost' : 'red'} kbig" data-in="${r.id}" data-n="${esc(r.name)}" ${r.checkedIn ? 'disabled' : ''}><span>${esc(r.name)}</span><small>${esc(r.branch || '')}${r.signedUp ? ' · signed up' : ' · walk-in'}${r.checkedIn ? ' · already here' : ''}</small></button>`).join('') : '<p class="muted" style="margin:0">No match. Check the spelling or ask a committee member.</p>';
      res.querySelectorAll('[data-in]').forEach(b => b.addEventListener('click', async () => {
        try {
          await api('POST', '/checkin', { employee_id: Number(b.dataset.in), guests: Number(document.getElementById('g').value) });
          lastIn = { id: Number(b.dataset.in), name: b.dataset.n }; toast(`Welcome, ${b.dataset.n}!`); load();
        } catch (e) { toast(e.message); }
      }));
    } catch (e) { toast(e.message); }
  }
  if (!token) main.innerHTML = '<div class="panel"><h1>Kiosk not open</h1><p>Open it from Admin view &gt; Opportunities &gt; Kiosk.</p></div>';
  else load();
})();
