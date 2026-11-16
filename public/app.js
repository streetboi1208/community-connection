'use strict';
/* Community Connection, pilot phase 1. Vanilla JS single-page app; the server enforces every permission. */
(function () {
  const I = window.ICONS;
  const $ = s => document.querySelector(s);
  const main = $('#main');
  const S = { me: null, perms: [], meta: null, admin: false, checkin: null, checkinShown: false };

  // ---------- helpers ----------
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const can = p => S.perms.includes(p);
  const roles = () => (S.me && S.me.roles) || [];
  const hasAdmin = () => roles().length > 0;
  const n1 = x => (Math.round(x * 10) / 10).toLocaleString('en-US');
  const money = x => '$' + Math.round(x).toLocaleString('en-US');
  const d8 = iso => new Date(iso + 'T12:00:00');
  const fmtDate = (iso, o = { weekday: 'short', month: 'short', day: 'numeric' }) => iso ? d8(iso).toLocaleDateString('en-US', o) : '';
  const fmtT = t => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const hrs = m => n1(m / 60);
  const ROLE = { admin: 'Administrator', mkt: 'Marketing', comp: 'Compliance', ccm: 'Culture Committee', mkta: 'Market admin', it: 'IT help desk' };
  const OT = { community: 'Volunteer (nonprofit)', bank: 'CNB event', social: 'Off the clock' };
  const STATUS = { pending: '<span class="pill warn">Pending</span>', approved: '<span class="pill ok">Approved</span>', rejected: '<span class="pill">Not approved</span>' };

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 3200);
  }
  async function api(method, path, body) {
    const r = await fetch('/api' + path, {
      method, credentials: 'same-origin',
      headers: { 'X-Requested-With': 'cc', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    let data = {};
    try { data = await r.json(); } catch (e) { /* non-JSON */ }
    if (r.status === 401 && path !== '/login' && path !== '/me/password') { S.me = null; go('#/login'); throw new Error(data.error || 'Please sign in.'); }
    if (r.status === 403 && data.mustChange) { go('#/password'); throw new Error(data.error); }
    if (!r.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }
  const get = p => api('GET', p);
  const go = h => { if (location.hash !== h) location.hash = h; else route(); };
  const formData = form => Object.fromEntries(new FormData(form).entries());
  function showErr(el, e) { if (el) { el.textContent = e.message; el.hidden = false; } else toast(e.message); }
  // Download a CSV through fetch so the session cookie and headers apply.
  async function download(path, name) {
    const r = await fetch('/api' + path, { credentials: 'same-origin' });
    if (!r.ok) return toast('Download failed.');
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- chrome ----------
  function navItems() {
    if (S.admin) {
      const items = [['#/admin', 'Admin home', I.grid]];
      if (can('opps.create') || can('rosters.view') || can('kiosk.run')) items.push(['#/admin/opps', 'Opportunities', I.list]);
      if (can('hours.approve') || can('people.edit')) items.push(['#/admin/approvals', 'Approvals', I.check]);
      if (can('people.view') || can('accounts.reset')) items.push(['#/admin/people', can('people.view') ? 'People' : 'Password resets', I.user]);
      if (can('reports.hours')) items.push(['#/admin/reports', 'Reports', I.chart]);
      items.push(['/preview', 'Full preview', I.grid]);
      return items;
    }
    return [['#/', 'Home', I.home], ['#/volunteer', 'Volunteer', I.heart], ['#/activity', 'My activity', I.cal], ['#/profile', 'Profile', I.user], ['/preview', 'Full preview', I.grid]];
  }
  function paintChrome(hash) {
    const signedIn = !!S.me && !S.me.must_change;
    $('#top').hidden = !signedIn;
    $('#app').classList.toggle('adminmode', S.admin);
    const tb = $('#tabbar');
    tb.hidden = !signedIn;
    if (!signedIn) return;
    const items = navItems();
    const cur = h => (h === '#/' ? hash === '#/' || hash === '' : h === '#/admin' ? hash === '#/admin' : hash.startsWith(h));
    const link = ([h, l, ic]) => `<a href="${h}" ${cur(h) ? 'aria-current="true"' : ''}>${ic}<span>${l}</span></a>`;
    $('#nav').innerHTML = items.map(link).join('');
    tb.innerHTML = items.slice(0, 5).map(link).join('');
    const mb = $('#modeBtn');
    mb.hidden = !hasAdmin();
    mb.textContent = S.admin ? 'Employee view' : 'Admin view';
    $('#avBtn').textContent = (S.me.first_name[0] + S.me.last_name[0]).toUpperCase();
  }
  $('#modeBtn').addEventListener('click', () => { go(S.admin ? '#/' : '#/admin'); });

  // ---------- router ----------
  const routes = [
    [/^#\/login$/, vLogin], [/^#\/password$/, vPassword],
    [/^#\/?$/, vHome], [/^#\/volunteer$/, vVolunteer], [/^#\/opp\/(\d+)$/, vOpp], [/^#\/activity$/, vActivity],
    [/^#\/log$/, vLog], [/^#\/profile$/, vProfile], [/^#\/resume$/, vResume],
    [/^#\/admin$/, vAdminHome], [/^#\/admin\/opps$/, vAdminOpps], [/^#\/admin\/opp\/(new|\d+)$/, vAdminOppEdit],
    [/^#\/admin\/roster\/(\d+)$/, vAdminRoster], [/^#\/admin\/approvals$/, vApprovals], [/^#\/admin\/people$/, vPeople],
    [/^#\/admin\/person\/(\d+)$/, vPerson], [/^#\/admin\/import$/, vImport], [/^#\/admin\/reports$/, vReports],
    [/^#\/admin\/settings$/, vSettings]
  ];
  async function route() {
    const hash = location.hash || '#/';
    try {
      if (!S.me && hash !== '#/login') {
        const r = await get('/me');
        if (!r.user) return go('#/login');
        S.me = r.user; S.perms = r.perms; S.checkin = r.checkin || null;
      }
      if (S.me && S.me.must_change && hash !== '#/password') return go('#/password');
      if (S.me && !S.meta && !S.me.must_change) S.meta = await get('/meta');
      S.admin = hash.startsWith('#/admin');
      if (S.admin && !hasAdmin()) return go('#/');
      paintChrome(hash);
      const m = routes.find(([re]) => re.test(hash));
      if (!m) return go('#/');
      main.innerHTML = '<p class="muted">Loading…</p>';
      await m[1](...hash.match(m[0]).slice(1));
      window.scrollTo(0, 0);
      if (S.checkin && S.checkin.due && !S.checkinShown && S.meta) { S.checkinShown = true; checkinModal(); }
    } catch (e) {
      main.innerHTML = `<div class="panel"><p class="err">${esc(e.message)}</p><a class="btn ghost" href="#/">Go home</a></div>`;
    }
  }
  window.addEventListener('hashchange', route);

  // ================= sign-in =================
  function vLogin() {
    $('#top').hidden = true; $('#tabbar').hidden = true;
    main.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'login';
    wrap.innerHTML = `<form class="panel" id="lf" autocomplete="on">
      <img src="/img/logo-navy.png" alt="Community National Bank">
      <h1>Community Connection</h1>
      <div class="field"><label for="lu">Username</label><input class="input" id="lu" name="username" autocomplete="username" autocapitalize="none" required></div>
      <div class="field"><label for="lp">Password</label><input class="input" id="lp" name="password" type="password" autocomplete="current-password" required></div>
      <p class="err" id="le" hidden></p>
      <button class="btn red" type="submit">Sign in</button>
      <small class="muted" id="forgot">Forgot your password? Ask your Culture Committee lead or an admin to reset it.</small>
    </form>`;
    main.appendChild(wrap);
    main.style.padding = '0';
    get('/public-config').then(c => {
      if (!c.helpdeskEmail) return;
      const subj = encodeURIComponent('Community Connection password reset');
      const body = encodeURIComponent('Hi IT,\n\nPlease reset my Community Connection password.\n\nName:\nBranch:\nUsername (if you know it):\nBest phone number to reach me:\n');
      $('#forgot').innerHTML = `Forgot your password? <a href="mailto:${esc(c.helpdeskEmail)}?subject=${subj}&body=${body}">Email the IT help desk</a> and they'll reset it.`;
    }).catch(() => {});
    $('#lf').addEventListener('submit', async e => {
      e.preventDefault();
      try {
        const r = await api('POST', '/login', formData(e.target));
        main.style.padding = '';
        S.me = null; S.meta = null;
        go(r.mustChange ? '#/password' : '#/');
      } catch (err) { showErr($('#le'), err); }
    });
  }

  function vPassword() {
    const first = S.me && S.me.must_change;
    main.innerHTML = `<form class="panel" id="pf" style="max-width:460px">
      <h1>${first ? 'Set your password' : 'Change password'}</h1>
      ${first ? '<p class="muted" style="margin:0">Welcome! Replace the temporary password with one only you know.</p>' : ''}
      <div class="field"><label for="p0">${first ? 'Temporary password' : 'Current password'}</label><input class="input" id="p0" name="current" type="password" autocomplete="current-password" required></div>
      <div class="field"><label for="p1">New password</label><input class="input" id="p1" name="next" type="password" autocomplete="new-password" minlength="10" required><small>At least 10 characters, mixing letters with numbers or symbols.</small></div>
      <div class="field"><label for="p2">New password again</label><input class="input" id="p2" name="again" type="password" autocomplete="new-password" required></div>
      <p class="err" id="pe" hidden></p>
      <div class="btnrow"><button class="btn red" type="submit">Save password</button>${first ? '' : '<a class="btn ghost" href="#/profile">Cancel</a>'}</div>
    </form>`;
    $('#pf').addEventListener('submit', async e => {
      e.preventDefault();
      const f = formData(e.target);
      if (f.next !== f.again) return showErr($('#pe'), new Error("The new passwords don't match."));
      try {
        await api('POST', '/me/password', { current: f.current, next: f.next });
        S.me = null; S.meta = null; toast('Password saved.'); go('#/');
      } catch (err) { showErr($('#pe'), err); }
    });
  }

  // ================= employee =================
  async function vHome() {
    const h = await get('/home');
    main.innerHTML = `
      ${h.pendingHours ? `<a class="halert" href="#/activity"><span class="pill warn">Pending</span> ${h.pendingHours} hours entr${h.pendingHours > 1 ? 'ies' : 'y'} waiting for approval</a>` : ''}
      ${h.next ? `<a class="hnext" href="#/opp/${h.next.id}"><div class="cal"><div class="m">${fmtDate(h.next.date, { month: 'short' })}</div><div class="d">${d8(h.next.date).getDate()}</div></div><div><div class="eyebrow">Your next shift</div><b>${esc(h.next.title)}</b><br><small class="muted">${fmtDate(h.next.date)}, ${fmtT(h.next.start_time)} · ${esc(h.next.location)}</small></div></a>` : ''}
      <section class="hhero slim"><div class="hrow"><div style="flex:1;min-width:0"><div class="eyebrow" style="color:#fff">#WeAreCommunity</div><h1>Hi, ${esc(S.me.first_name)}.</h1></div>
        <div class="hstats">
          <a href="#/activity"><b>${n1(h.myHours)}</b><span>Your hours, ${h.year}</span></a>
          <a href="#/volunteer"><b>${Math.round(h.marketHours).toLocaleString('en-US')}</b><span>${esc(h.market)} hours</span></a>
          <a href="#/volunteer" title="Community hours × $${h.impactRate}/hr"><b>${h.marketImpact >= 1000 ? '$' + n1(h.marketImpact / 1000) + 'K' : money(h.marketImpact)}</b><span>${esc(h.market)} impact</span></a>
          <a href="#/log"><b>+</b><span>Log hours</span></a>
        </div></div></section>
      <div class="kgrid">
        <a class="ktile" href="#/volunteer">${I.heart}<b>Find a way to help</b><small class="muted">Volunteer opportunities in ${esc(S.me.market)}</small></a>
        <a class="ktile" href="#/activity">${I.cal}<b>My activity</b><small class="muted">Your sign-ups and hours</small></a>
        <a class="ktile" href="#/log">${I.plus}<b>Log outside volunteering</b><small class="muted">Volunteered on your own? Get credit.</small></a>
      </div>
      <p class="pilotnote">Pilot version: sample data only. Games, rewards, training and the rest arrive in later phases.</p>`;
  }

  function oppCard(o) {
    const left = o.cap - o.filled;
    return `<a class="card" href="#/opp/${o.id}">
      <div class="datebox"><div class="cal"><div class="m">${fmtDate(o.first_date, { month: 'short' })}</div><div class="d">${d8(o.first_date).getDate()}</div></div>
        <div style="min-width:0"><div class="eyebrow">${esc(o.nonprofit || 'Community National Bank')}</div><h3>${esc(o.title)}</h3>
        ${o.otype !== 'community' ? `<span class="pill ${o.otype === 'social' ? 'warn' : ''}">${OT[o.otype]}</span>` : ''}</div></div>
      <div class="body"><div class="meta">${I.cal}${fmtDate(o.first_date)}${o.last_date !== o.first_date ? ' – ' + fmtDate(o.last_date) : ''}</div>
        <div class="meta">${I.pin}<span><b style="font-weight:600">${esc(o.location)}</b>${o.address ? '<br>' + esc(o.address) : ''}</span></div></div>
      <div class="foot">${o.mine ? '<span class="pill ok">You\'re signed up</span>' : ''}${o.cra ? '<span class="pill">CRA</span>' : ''}<span class="spots">${left > 0 ? `${left} spot${left === 1 ? '' : 's'} left` : 'Full'}</span></div>
    </a>`;
  }
  async function vVolunteer() {
    const all = sessionStorage.getItem('cc_all') === '1';
    const r = await get('/opps' + (all ? '?market=all' : ''));
    main.innerHTML = `<section class="hero"><div><div class="eyebrow" style="color:#fff">#WeAreCommunity</div><h1>Show up for the place <em>we call home.</em></h1><p>Pick an opportunity, choose one or more shifts, and you're on the roster.</p></div></section>
      <div class="toolbar"><button class="chip" aria-pressed="${!all}" data-all="0">${esc(S.me.market)}</button><button class="chip" aria-pressed="${all}" data-all="1">View all markets</button></div>
      ${r.opps.length ? `<div class="grid">${r.opps.map(oppCard).join('')}</div>` : '<div class="empty panel">No upcoming opportunities right now. Check back soon.</div>'}`;
    main.querySelectorAll('[data-all]').forEach(b => b.addEventListener('click', () => { sessionStorage.setItem('cc_all', b.dataset.all); vVolunteer(); }));
  }

  async function vOpp(id) {
    const { opp: o, shifts, going } = await get('/opps/' + id);
    const open = shifts.filter(s => !s.my_signup && !s.my_wait);
    const anyOpen = open.some(s => s.filled < s.capacity);
    main.innerHTML = `<a class="back" href="#/volunteer">${I.left}All opportunities</a>
      <div class="detail"><div class="panel">
        <div class="eyebrow">${esc(o.nonprofit || 'Community National Bank')}</div><h1>${esc(o.title)}</h1>
        ${o.otype !== 'community' ? `<span class="pill">${OT[o.otype]}</span>` : ''}
        <dl class="facts"><dt>${I.pin}Where</dt><dd><b>${esc(o.location)}</b>${o.address ? '<br>' + esc(o.address) : ''}</dd><dt>${I.org}Market</dt><dd>${esc(o.market)}</dd></dl>
        <p class="desc">${esc(o.description).replace(/\n/g, '<br>')}</p>
        ${going.length ? `<div><h2>Who's going</h2><p class="muted">${going.map(g => esc(g.first_name + ' ' + g.li + '.')).join(', ')}</p></div>` : ''}
      </div>
      <form class="panel" id="sf"><h2>Pick your shifts</h2>
        ${shifts.map(s => `<label class="shift ${s.my_signup ? 'mine' : ''} ${!s.my_signup && s.filled >= s.capacity ? 'full' : ''}">
          ${s.my_signup || s.my_wait ? '' : `<input type="checkbox" name="shift" value="${s.id}">`}
          <span class="t"><b>${fmtDate(s.date)}</b>, ${fmtT(s.start)} – ${fmtT(s.end)}${s.label ? `<br><small class="sub">${esc(s.label)}</small>` : ''}</span>
          <span class="cap">${s.my_signup ? `<button type="button" class="btn sm ghost" data-cancel="${s.my_signup}">Cancel</button>`
            : s.my_wait ? `<span class="pill warn">#${s.my_place} on waitlist</span> <button type="button" class="btn sm ghost" data-leave="${s.my_wait}">Leave</button>`
            : s.filled >= s.capacity ? `Full · join waitlist${s.waiting ? ` (${s.waiting} waiting)` : ''}` : `${s.capacity - s.filled} of ${s.capacity} open`}</span></label>`).join('')}
        ${shifts.some(s => !s.my_signup && !s.my_wait && s.filled >= s.capacity) ? '<small class="muted">Full shifts have a waitlist. If a spot opens, the next person in line moves up automatically and sees it in My activity.</small>' : ''}
        ${o.collect_shirts && open.length ? `<div class="field"><label for="sz">Shirt size</label><select class="input" id="sz" name="shirt_size" required><option value="">Pick a size</option>${S.meta.sizes.map(z => `<option ${S.me.shirt_size === z ? 'selected' : ''}>${z}</option>`).join('')}</select></div>` : ''}
        <p class="err" id="se" hidden></p>
        ${open.length ? `<button class="btn red" type="submit">${anyOpen ? 'Sign me up' : 'Join the waitlist'}</button>` : '<p class="muted">You\'re on every shift here.</p>'}
      </form></div>`;
    const f = $('#sf');
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const ids = [...f.querySelectorAll('input[name=shift]:checked')].map(x => Number(x.value));
      if (!ids.length) return showErr($('#se'), new Error('Pick at least one shift.'));
      try {
        const r = await api('POST', `/opps/${id}/signup`, { shiftIds: ids, shirt_size: f.shirt_size ? f.shirt_size.value : undefined });
        const w = (r.waitlisted || []).length, a = (r.added || []).length;
        toast(a && w ? `Signed up for ${a} shift${a > 1 ? 's' : ''} and waitlisted for ${w}.` : w ? "You're on the waitlist. We'll move you up if a spot opens." : "You're signed up. Thank you!"); vOpp(id);
      } catch (err) { showErr($('#se'), err); }
    });
    f.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', async () => {
      if (!window.confirm('Cancel this shift?')) return;
      try { await api('DELETE', '/signups/' + b.dataset.cancel); toast('Shift canceled.'); vOpp(id); } catch (err) { toast(err.message); }
    }));
    f.querySelectorAll('[data-leave]').forEach(b => b.addEventListener('click', async () => {
      try { await api('DELETE', '/waitlist/' + b.dataset.leave); toast('Removed from the waitlist.'); vOpp(id); } catch (err) { toast(err.message); }
    }));
  }

  async function vActivity() {
    const { upcoming, hours, waiting = [] } = await get('/activity');
    const tot = hours.filter(h => h.status === 'approved').reduce((a, h) => a + h.minutes, 0);
    main.innerHTML = `<h1>My activity</h1>
      <div class="panel"><h2>Coming up</h2>${upcoming.length ? `<div class="list">${upcoming.map(u => `<div class="row"><div class="cal"><div class="m">${fmtDate(u.date, { month: 'short' })}</div><div class="d">${d8(u.date).getDate()}</div></div>
        <div class="grow"><div class="eyebrow">${esc(u.nonprofit || 'Community National Bank')}</div><h3><a href="#/opp/${u.opp_id}">${esc(u.title)}</a></h3><small class="muted">${fmtDate(u.date)}, ${fmtT(u.start)} – ${fmtT(u.end)} · ${esc(u.location)}${u.shirt_size ? ' · Shirt ' + esc(u.shirt_size) : ''}</small>${u.from_waitlist ? '<br><span class="pill ok">You\'re in! Moved up from the waitlist</span>' : ''}</div>
        <button class="btn sm ghost" data-cancel="${u.signup_id}">Cancel</button></div>`).join('')}</div>` : '<p class="muted">Nothing on your calendar. <a href="#/volunteer">Find a way to help</a>.</p>'}</div>
      ${waiting.length ? `<div class="panel"><h2>Waitlist</h2><p class="muted" style="margin:0">First come, first served. If a spot opens, you move up automatically.</p><div class="list">${waiting.map(w => `<div class="row"><div class="cal"><div class="m">${fmtDate(w.date, { month: 'short' })}</div><div class="d">${d8(w.date).getDate()}</div></div>
        <div class="grow"><h3><a href="#/opp/${w.opp_id}">${esc(w.title)}</a></h3><small class="muted">${fmtDate(w.date)}, ${fmtT(w.start)} – ${fmtT(w.end)} · ${esc(w.location)}</small><br><span class="pill warn">#${w.place} in line</span></div>
        <button class="btn sm ghost" data-leave="${w.wait_id}">Leave</button></div>`).join('')}</div></div>` : ''}
      <div class="panel"><div class="btnrow" style="justify-content:space-between"><h2>Your hours</h2><div class="btnrow"><a class="btn sm ghost" href="#/resume">Volunteer résumé</a><a class="btn sm red" href="#/log">Log hours</a></div></div>
        <p class="muted" style="margin:0">${hrs(tot)} approved hours all time.</p>
        ${hours.length ? `<div class="tablewrap"><table class="stbl tight"><thead><tr><th>Date</th><th>What</th><th class="num">Hours</th><th>Status</th></tr></thead><tbody>
        ${hours.map(h => `<tr><td>${fmtDate(h.date, { month: 'short', day: 'numeric', year: 'numeric' })}</td><td>${esc(h.what || '')}${h.decision_note ? `<br><small class="muted">${esc(h.decision_note)}</small>` : ''}</td><td class="num">${hrs(h.minutes)}</td><td>${STATUS[h.status]}</td></tr>`).join('')}
        </tbody></table></div>` : ''}</div>`;
    main.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', async () => {
      if (!window.confirm('Cancel this shift?')) return;
      try { await api('DELETE', '/signups/' + b.dataset.cancel); toast('Shift canceled.'); vActivity(); } catch (err) { toast(err.message); }
    }));
    main.querySelectorAll('[data-leave]').forEach(b => b.addEventListener('click', async () => {
      try { await api('DELETE', '/waitlist/' + b.dataset.leave); toast('Removed from the waitlist.'); vActivity(); } catch (err) { toast(err.message); }
    }));
  }

  function vLog() {
    main.innerHTML = `<a class="back" href="#/activity">${I.left}My activity</a>
      <form class="panel" id="hf" style="max-width:640px"><h1>Log volunteering</h1>
      <p class="muted" style="margin:0">For volunteering you did on your own. A coordinator reviews it before it counts.</p>
      <div class="formgrid">
        <div class="field"><label for="hd">Date</label><input class="input" type="date" id="hd" name="date" max="${S.meta.today}" required></div>
        <div class="field"><label for="hh">Hours</label><input class="input" type="number" id="hh" name="hours" min="0.25" max="12" step="0.25" required></div>
        <div class="field span"><label for="ho">Organization</label><input class="input" id="ho" name="org_name" maxlength="120" required></div>
        <div class="field span"><label for="ht">What you did</label><textarea class="input" id="ht" name="details" maxlength="1000" required></textarea></div>
      </div>
      <fieldset class="craq"><legend>CRA questions</legend><small class="muted">Answer what you know. Compliance confirms what counts for CRA.</small>
        <label class="toggle"><input type="checkbox" name="cra_lmi" ><span class="sw"></span><small>It mainly served low- to moderate-income people or neighborhoods</small></label>
        <label class="toggle"><input type="checkbox" name="cra_finance" ><span class="sw"></span><small>It used financial knowledge (budgeting, banking, lending, a finance or treasurer role)</small></label></fieldset>
      <p class="err" id="he" hidden></p>
      <div class="btnrow"><button class="btn red" type="submit">Submit for approval</button><a class="btn ghost" href="#/activity">Cancel</a></div></form>`;
    $('#hf').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      try { await api('POST', '/hours', { ...formData(f), cra_lmi: f.cra_lmi.checked, cra_finance: f.cra_finance.checked }); toast('Sent for approval.'); go('#/activity'); } catch (err) { showErr($('#he'), err); }
    });
  }

  async function vProfile() {
    const { user: p } = await get('/me');
    main.innerHTML = `<h1>${esc(p.first_name + ' ' + p.last_name)}</h1>
      <div class="detail even"><div class="panel"><h2>About you</h2>
        <dl class="facts"><dt>${I.org}Market</dt><dd>${esc(p.market)}</dd><dt>${I.pin}Branch</dt><dd>${esc(p.branch || '—')}</dd><dt>${I.people}Department</dt><dd>${esc(p.department || '—')}</dd>
        <dt>${I.star}Title</dt><dd>${esc(p.title || '—')}</dd><dt>${I.user}Manager</dt><dd>${esc(p.manager_name || '—')}</dd>
        <dt>${I.list}Employee #</dt><dd>${esc(p.emp_no)}</dd>
        <dt>${I.user}Username</dt><dd>${esc(p.username)}</dd>${p.roles.length ? `<dt>${I.star}Roles</dt><dd>${p.roles.map(r => ROLE[r]).join(', ')}</dd>` : ''}</dl>
        ${S.checkin && S.checkin.pending ? `<div class="note"><span class="pill warn">Waiting for review</span> You asked for a change on ${new Date(S.checkin.pending.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}. An admin will update your profile once it's approved.</div>`
          : '<button class="btn ghost sm" id="fixInfo" type="button">Something wrong? Request a change</button>'}
        <div class="btnrow"><a class="btn ghost" href="#/resume">Volunteer résumé</a><a class="btn ghost" href="#/password">Change password</a><button class="btn ghost" id="so">Sign out</button></div></div>
      <form class="panel" id="prf"><h2>Contact and preferences</h2>
        <div class="field"><label for="pp">Mobile number (optional)</label><input class="input" id="pp" name="phone" type="tel" value="${esc(p.phone || '')}" autocomplete="tel"><small>Only admins see it. Never shown to coworkers.</small></div>
        <label class="toggle" style="align-items:flex-start"><input type="checkbox" name="text_consent" ${p.text_consent_at ? 'checked' : ''}><span class="sw"></span><small>Text me reminders about my shifts. Message and data rates may apply. Reply STOP to end. (Texting turns on in a later phase.)</small></label>
        <div class="field"><label for="pe2">Personal email (optional)</label><input class="input" id="pe2" name="personal_email" type="email" value="${esc(p.personal_email || '')}" autocomplete="email"></div>
        <div class="field"><label for="ps">Shirt size</label><select class="input" id="ps" name="shirt_size"><option value="">Not set</option>${S.meta.sizes.map(z => `<option ${p.shirt_size === z ? 'selected' : ''}>${z}</option>`).join('')}</select></div>
        <label class="toggle"><input type="checkbox" name="show_name" ${p.show_name ? 'checked' : ''}><span class="sw"></span><small>Show my name on "Who's going" lists</small></label>
        <p class="err" id="pre" hidden></p>
        <button class="btn red" type="submit">Save</button></form></div>
      <div class="panel" id="seats"></div>`;
    boardSeats();
    $('#so').addEventListener('click', async () => { await api('POST', '/logout'); S.me = null; S.meta = null; S.checkinShown = false; go('#/login'); });
    if ($('#fixInfo')) $('#fixInfo').addEventListener('click', () => checkinModal(true));
    $('#prf').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('PATCH', '/me', { phone: f.phone.value, personal_email: f.personal_email.value, shirt_size: f.shirt_size.value,
          show_name: f.show_name.checked, text_consent: f.text_consent.checked });
        S.me = null; toast('Saved.'); route();
      } catch (err) { showErr($('#pre'), err); }
    });
  }

  // ================= board seats =================
  // Employees list boards and committees they serve on; a coordinator reviews each one for CRA reporting.
  async function boardSeats(edit) {
    const box = $('#seats'); if (!box) return;
    const { rows } = await get('/board-seats');
    const ST = { pending: '<span class="pill warn">Waiting for review</span>', approved: '<span class="pill ok">Approved</span>', rejected: '<span class="pill">Declined</span>' };
    const when = x => `${fmtDate(x.start_date, { month: 'short', year: 'numeric' })} – ${x.is_current ? 'present' : fmtDate(x.end_date, { month: 'short', year: 'numeric' })}`;
    const form = x => `<form class="seatform" id="bsf"><div class="formgrid">
        <div class="field"><label for="bo">Organization</label><input class="input" id="bo" name="org_name" maxlength="120" value="${esc(x.org_name || '')}" required></div>
        <div class="field"><label for="bt">Your title</label><input class="input" id="bt" name="title" maxlength="80" placeholder="Treasurer, board member…" value="${esc(x.title || '')}" required></div>
        <div class="field"><label for="bsd">Start date</label><input class="input" type="date" id="bsd" name="start_date" max="${S.meta.today}" value="${esc(x.start_date || '')}" required></div>
        <div class="field" id="bef"><label for="bed">End date</label><input class="input" type="date" id="bed" name="end_date" value="${esc(x.end_date || '')}"></div>
        <div class="field span"><label for="bde">What you do there</label><textarea class="input" id="bde" name="description" maxlength="1000" required>${esc(x.description || '')}</textarea></div></div>
      <label class="toggle"><input type="checkbox" name="is_current" ${x.is_current !== false ? 'checked' : ''}><span class="sw"></span><small>I still serve on this board</small></label>
      <fieldset class="craq"><legend>CRA questions</legend><small class="muted">Answer what you know. Compliance confirms what counts for CRA.</small>
        <label class="toggle"><input type="checkbox" name="cra_lmi" ${x.cra_lmi ? 'checked' : ''}><span class="sw"></span><small>It mainly served low- to moderate-income people or neighborhoods</small></label>
        <label class="toggle"><input type="checkbox" name="cra_finance" ${x.cra_finance ? 'checked' : ''}><span class="sw"></span><small>It used financial knowledge (budgeting, banking, lending, a finance or treasurer role)</small></label></fieldset>
      <p class="err" id="bse" hidden></p>
      <div class="btnrow"><button class="btn red" type="submit">${x.id ? 'Save and send for review' : 'Send for review'}</button><button class="btn ghost" type="button" id="bsc">Cancel</button></div></form>`;
    box.innerHTML = `<div class="btnrow" style="justify-content:space-between"><h2>Board and committee seats</h2>${edit ? '' : '<button class="btn sm ghost" id="bsa" type="button">Add a seat</button>'}</div>
      <p class="muted" style="margin:0">Nonprofit boards, committees and advisory roles you serve on. A coordinator reviews each one; approved seats show on your volunteer résumé and in CRA reports.</p>
      ${edit === 'new' ? form({}) : ''}
      ${rows.length ? `<div class="list">${rows.map(x => edit === x.id ? form(x) : `<div class="row"><div class="grow"><h3>${esc(x.title)}, ${esc(x.org_name)}</h3><small class="muted">${when(x)}</small><br>${ST[x.status]}${x.cra_lmi && x.cra_finance ? ' <span class="pill">CRA</span>' : ''}${x.decision_note ? `<br><small class="muted">${esc(x.decision_note)}</small>` : ''}</div>
        ${edit ? '' : `<button class="btn sm ghost" data-ed="${x.id}" type="button">Edit</button><button class="iconbtn" data-del="${x.id}" type="button" title="Remove">${I.x}</button>`}</div>`).join('')}</div>` : (edit ? '' : '<p class="muted">None added yet.</p>')}`;
    const f = $('#bsf');
    if (f) {
      const sync = () => { $('#bef').hidden = f.is_current.checked; f.end_date.required = !f.is_current.checked; };
      f.is_current.addEventListener('change', sync); sync();
      $('#bsc').addEventListener('click', () => boardSeats());
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const body = { org_name: f.org_name.value, title: f.title.value, start_date: f.start_date.value, end_date: f.is_current.checked ? null : f.end_date.value,
          is_current: f.is_current.checked, description: f.description.value, cra_lmi: f.cra_lmi.checked, cra_finance: f.cra_finance.checked };
        try { await api(edit === 'new' ? 'POST' : 'PUT', edit === 'new' ? '/board-seats' : '/board-seats/' + edit, body); toast('Sent for review.'); boardSeats(); } catch (err) { showErr($('#bse'), err); }
      });
      f.org_name.focus();
    }
    if ($('#bsa')) $('#bsa').addEventListener('click', () => boardSeats('new'));
    box.querySelectorAll('[data-ed]').forEach(b => b.addEventListener('click', () => boardSeats(Number(b.dataset.ed))));
    box.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      if (!window.confirm('Remove this board seat?')) return;
      try { await api('DELETE', '/board-seats/' + b.dataset.del); toast('Removed.'); boardSeats(); } catch (err) { toast(err.message); }
    }));
  }

  // ================= volunteer résumé =================
  async function vResume() {
    const r = await get('/resume');
    const m = r.me, t = r.totals;
    main.innerHTML = `<div class="noprint"><a class="back" href="#/activity">${I.left}My activity</a></div>
      <article class="panel resume"><div class="btnrow noprint" style="justify-content:flex-end"><button class="btn red" id="rpr" type="button">Print or save as PDF</button></div>
        <div class="eyebrow">Volunteer résumé · Community National Bank</div><h1>${esc(m.first_name + ' ' + m.last_name)}</h1>
        <p class="muted" style="margin:0">${[m.title, m.branch, m.market].filter(Boolean).map(esc).join(' · ')}</p>
        <div class="kpis"><div class="kpi"><b>${n1(t.hours)}</b><span>Volunteer hours</span></div><div class="kpi"><b>${t.events}</b><span>Activities</span></div>
          <div class="kpi"><b>${t.orgs}</b><span>Organizations served</span></div><div class="kpi"><b>${money(t.impact)}</b><span>Community impact</span><small>Community hours × $${t.rate}/hr</small></div></div>
        ${r.seats.length ? `<h2>Board and committee service</h2><ul class="rlist">${r.seats.map(x => `<li><b>${esc(x.title)}</b>, ${esc(x.org_name)} <span class="muted">· ${fmtDate(x.start_date, { month: 'short', year: 'numeric' })} – ${x.is_current ? 'present' : fmtDate(x.end_date, { month: 'short', year: 'numeric' })}</span></li>`).join('')}</ul>` : ''}
        ${r.years.length ? `<h2>By year</h2><div class="tablewrap"><table class="stbl tight"><thead><tr><th>Year</th><th class="num">Hours</th><th class="num">Activities</th></tr></thead><tbody>${r.years.map(y => `<tr><td>${y.year}</td><td class="num">${n1(y.hours)}</td><td class="num">${y.entries}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <h2>Volunteer history</h2>${r.activity.length ? `<div class="tablewrap"><table class="stbl tight"><thead><tr><th>Date</th><th>Activity</th><th>Organization</th><th class="num">Hours</th></tr></thead><tbody>
        ${r.activity.map(a => `<tr><td>${fmtDate(a.date, { month: 'short', day: 'numeric', year: 'numeric' })}</td><td>${esc(a.what || '')}</td><td>${esc(a.org || 'Community National Bank')}</td><td class="num">${n1(a.hours)}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="muted">No approved hours yet. <a href="#/volunteer">Find a way to help</a>.</p>'}
        <small class="muted">Approved hours as of ${fmtDate(r.today, { month: 'long', day: 'numeric', year: 'numeric' })}.</small></article>`;
    $('#rpr').addEventListener('click', () => window.print());
  }

  // ================= profile check-in =================
  // Once or twice a year: confirm work details, or send corrections for an admin to approve.
  async function checkinModal(startWithForm) {
    const { user: p } = await get('/me');
    const wrap = document.createElement('div');
    wrap.className = 'ccmodal';
    wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-labelledby', 'ciT');
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    const row = (l, v) => `<dt>${l}</dt><dd>${esc(v || '—')}</dd>`;
    const facts = () => {
      wrap.innerHTML = `<div class="ccbox"><div class="eyebrow">Quick check</div><h2 id="ciT">Is your info still right?</h2>
        <p class="muted" style="margin:0">We ask ${S.checkin && S.checkin.months === 6 ? 'twice a year' : 'once a year'} so events and reports stay accurate.</p>
        <dl class="cifacts">${row('Name', p.first_name + ' ' + p.last_name)}${row('Employee #', p.emp_no)}${row('Market', p.market)}${row('Branch', p.branch)}${row('Department', p.department)}${row('Title', p.title)}${row('Manager', p.manager_name)}</dl>
        <button class="btn red" id="ciYes">Yes, it's correct</button><button class="btn ghost" id="ciNo">Something's wrong</button></div>`;
      $('#ciYes').addEventListener('click', async () => {
        try { await api('POST', '/me/confirm'); S.checkin = { ...S.checkin, due: false }; close(); toast('Thanks! You\'re all set.'); } catch (err) { toast(err.message); }
      });
      $('#ciNo').addEventListener('click', form);
      $('#ciYes').focus();
    };
    const form = () => {
      const brs = S.meta.markets.map(m => `<optgroup label="${esc(m.name)}">${S.meta.branches.filter(b => b.market_id === m.id).map(b => `<option value="${b.id}" ${b.id === p.branch_id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</optgroup>`).join('');
      wrap.innerHTML = `<form class="ccbox" id="cif"><h2 id="ciT">What needs to change?</h2>
        <p class="muted" style="margin:0">Fix what's wrong. Nothing changes until an admin reviews it.</p>
        <div class="field"><label for="ciB">Branch</label><select class="input" id="ciB" name="branch_id"><option value="">Not set</option>${brs}</select></div>
        <div class="field"><label for="ciD">Department</label><select class="input" id="ciD" name="department_id"><option value="">Not set</option>${S.meta.departments.map(d => `<option value="${d.id}" ${d.id === p.department_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="ciTi">Title</label><input class="input" id="ciTi" name="title" maxlength="80" value="${esc(p.title || '')}"></div>
        <div class="field"><label for="ciM">Manager</label><input class="input" id="ciM" name="manager_name" maxlength="120" value="${esc(p.manager_name || '')}"></div>
        <div class="field"><label for="ciN">Anything else? (optional)</label><textarea class="input" id="ciN" name="note" maxlength="500" rows="2" placeholder="Name spelling, market, anything we missed"></textarea></div>
        <p class="err" id="ciE" hidden></p>
        <button class="btn red" type="submit">Send for review</button>${startWithForm ? '<button class="btn ghost" type="button" id="ciX">Cancel</button>' : '<button class="btn ghost" type="button" id="ciBack">Back</button>'}</form>`;
      if ($('#ciBack')) $('#ciBack').addEventListener('click', facts);
      if ($('#ciX')) $('#ciX').addEventListener('click', close);
      $('#cif').addEventListener('submit', async e => {
        e.preventDefault();
        try {
          await api('POST', '/me/change-request', formData(e.target));
          close(); toast('Sent. An admin will review your change.'); S.me = null; route();
        } catch (err) { showErr($('#ciE'), err); }
      });
      $('#ciB').focus();
    };
    if (startWithForm) form(); else facts();
  }

  // ================= admin =================
  function vAdminHome() {
    const tiles = [
      ['opps.create', '#/admin/opp/new', I.plus, 'New opportunity or event', can('opps.createVolunteer') ? 'Volunteer opportunities and CNB events' : 'CNB and off-the-clock events'],
      ['rosters.view', '#/admin/opps', I.list, 'Opportunities and sign-ups', 'See who signed up, export rosters'],
      ['kiosk.run', '#/admin/opps', I.check, 'Open the kiosk', 'Check-in on an iPad at an event'],
      ['hours.approve', '#/admin/approvals', I.check, 'Approve hours', 'Self-logged volunteering waiting for review'],
      ['people.edit', '#/admin/approvals', I.people, 'Profile changes', 'Employee corrections to branch, department or manager'],
      ['people.view', '#/admin/people', I.user, 'People', 'Profiles, sign-ins and password resets'],
      ['accounts.reset', '#/admin/people', I.user, 'Reset a password', 'Find an employee and give them a temporary password'],
      ['roster.import', '#/admin/import', I.people, 'Import employee roster', 'All employees, for true participation %'],
      ['reports.hours', '#/admin/reports', I.chart, 'Reports', 'Participation, hours, impact and CRA'],
      ['settings.edit', '#/admin/settings', I.star, 'Settings and audit log', 'Impact rate, who did what']
    ].filter(t => can(t[0]));
    const seen = new Set();
    main.innerHTML = `<h1>Admin</h1><p class="muted" style="margin:0">Signed in as ${esc(S.me.first_name)} · ${roles().map(r => ROLE[r]).join(', ')}${roles().includes('mkta') && !roles().includes('admin') ? ` · ${esc(S.me.market)} only` : ''}</p>
      <div class="kgrid">${tiles.filter(t => !seen.has(t[3]) && seen.add(t[3])).map(t => `<a class="ktile" href="${t[1]}">${t[2]}<b>${t[3]}</b><small class="muted">${t[4]}</small></a>`).join('')}</div>`;
  }

  async function vAdminOpps() {
    const past = sessionStorage.getItem('cc_past') === '1';
    const { opps } = await get('/admin/opps' + (past ? '?past=1' : ''));
    main.innerHTML = `<div class="btnrow" style="justify-content:space-between"><h1>Opportunities</h1>${can('opps.create') ? '<a class="btn red" href="#/admin/opp/new">New</a>' : ''}</div>
      <div class="toolbar"><button class="chip" aria-pressed="${!past}" data-p="0">Upcoming</button><button class="chip" aria-pressed="${past}" data-p="1">Include past</button></div>
      <div class="tablewrap"><table class="stbl tight"><thead><tr><th>Date</th><th>Title</th><th>Type</th><th>Market</th><th class="num">Signed up</th><th>Status</th><th></th></tr></thead><tbody>
      ${opps.map(o => `<tr><td>${fmtDate(o.first_date, { month: 'short', day: 'numeric' })}</td><td><b>${esc(o.title)}</b><br><small class="muted">${esc(o.nonprofit || '')}</small></td><td>${OT[o.otype]}</td><td>${esc(o.market)}</td><td class="num">${o.filled} / ${o.cap}</td><td>${esc(o.status)}</td>
        <td><div class="btnrow">${can('opps.create') ? `<a class="btn sm ghost" href="#/admin/opp/${o.id}">Edit</a>` : ''}${can('rosters.view') || can('kiosk.run') ? `<a class="btn sm ghost" href="#/admin/roster/${o.id}">Sign-ups</a>` : ''}${can('kiosk.run') && o.status === 'published' ? `<button class="btn sm red" data-kiosk="${o.id}">Kiosk</button>` : ''}</div></td></tr>`).join('') || '<tr><td colspan="7" class="muted">Nothing yet.</td></tr>'}
      </tbody></table></div>`;
    main.querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', () => { sessionStorage.setItem('cc_past', b.dataset.p); vAdminOpps(); }));
    main.querySelectorAll('[data-kiosk]').forEach(b => b.addEventListener('click', async () => {
      try {
        const r = await api('POST', '/admin/kiosk', { opp_id: Number(b.dataset.kiosk) });
        window.location.href = r.url; // the kiosk page keeps its token for this device only
      } catch (err) { toast(err.message); }
    }));
  }

  async function vAdminOppEdit(id) {
    const isNew = id === 'new';
    const d = isNew ? { opp: { otype: can('opps.createVolunteer') ? 'community' : 'bank', market_id: S.me.market_id, status: 'published' }, shifts: [{ date: S.meta.today, start: '09:00', end: '12:00', capacity: 10 }] } : await get('/admin/opps/' + id);
    const o = d.opp;
    const mktLocked = roles().includes('mkta') && !roles().includes('admin');
    const shiftRow = (s, i) => `<div class="shiftedit" data-i="${i}">${s.id ? `<input type="hidden" name="sid" value="${s.id}">` : ''}
      <div class="field"><label>Date</label><input class="input" type="date" name="sdate" value="${esc(s.date)}" required></div>
      <div class="field"><label>Start</label><input class="input" type="time" name="sstart" value="${esc(s.start)}" required></div>
      <div class="field"><label>End</label><input class="input" type="time" name="send" value="${esc(s.end)}" required></div>
      <div class="field"><label>Spots</label><input class="input" type="number" min="1" name="scap" value="${esc(s.capacity)}" required></div>
      <div class="field lbl"><label>Label (optional)</label><input class="input" name="slabel" value="${esc(s.label || '')}" maxlength="60"></div>
      <button type="button" class="iconbtn" data-rm title="Remove shift">${I.x}</button></div>`;
    main.innerHTML = `<a class="back" href="#/admin/opps">${I.left}Opportunities</a>
      <form class="panel" id="of"><h1>${isNew ? 'New opportunity' : 'Edit opportunity'}</h1>
      <div class="formgrid">
        <div class="field"><label for="ot">Type</label><select class="input" id="ot" name="otype">${Object.entries(OT).filter(([k]) => k !== 'community' || can('opps.createVolunteer')).map(([k, l]) => `<option value="${k}" ${o.otype === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label for="om">Market</label><select class="input" id="om" name="market_id" ${mktLocked ? 'disabled' : ''}>${S.meta.markets.map(m => `<option value="${m.id}" ${Number(o.market_id) === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
        <div class="field span"><label for="oti">Title</label><input class="input" id="oti" name="title" value="${esc(o.title || '')}" maxlength="120" required></div>
        <div class="field span" id="npf"><label for="onp">Nonprofit</label><input class="input" id="onp" name="nonprofit" list="nps" value="${esc(o.nonprofit || '')}" maxlength="120"><datalist id="nps">${S.meta.nonprofits.map(n => `<option value="${esc(n.name)}">`).join('')}</datalist></div>
        <div class="field"><label for="ol">Location name</label><input class="input" id="ol" name="location" value="${esc(o.location || '')}" maxlength="120" required></div>
        <div class="field"><label for="oa">Address</label><input class="input" id="oa" name="address" value="${esc(o.address || '')}" maxlength="200"></div>
        <div class="field span"><label for="od">Description</label><textarea class="input" id="od" name="description" maxlength="4000">${esc(o.description || '')}</textarea></div>
      </div>
      <label class="toggle"><input type="checkbox" name="collect_shirts" ${o.collect_shirts ? 'checked' : ''}><span class="sw"></span><small>Ask for shirt sizes</small></label>
      <fieldset class="craq" id="craf"><legend>CRA questions</legend>
        <label class="toggle"><input type="checkbox" name="cra_lmi" ${o.cra_lmi ? 'checked' : ''}><span class="sw"></span><small>Does it mainly serve low- to moderate-income people or neighborhoods?</small></label>
        <label class="toggle"><input type="checkbox" name="cra_finance" ${o.cra_finance ? 'checked' : ''}><span class="sw"></span><small>Does it use financial knowledge (financial education, budgeting, homebuying, small business, a finance role)?</small></label>
        <small class="muted" id="crah"></small>
        <div class="field"><label for="ocn">CRA note (why it qualifies)</label><input class="input" id="ocn" name="cra_note" value="${esc(o.cra_note || '')}" maxlength="300"></div></fieldset>
      <h2>Shifts</h2><div id="shifts">${d.shifts.map(shiftRow).join('')}</div>
      <div><button type="button" class="btn sm ghost" id="addS">${I.plus} Add shift</button></div>
      <div class="field"><label for="ost">Status</label><select class="input" id="ost" name="status">${['published', 'draft', 'cancelled'].map(s => `<option ${o.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <p class="err" id="oe" hidden></p>
      <div class="btnrow"><button class="btn red" type="submit">Save</button><a class="btn ghost" href="#/admin/opps">Cancel</a></div></form>`;
    const sync = () => {
      $('#npf').hidden = $('#ot').value !== 'community';
      $('#craf').hidden = $('#ot').value === 'social';
      const f = $('#of'); const both = f.cra_lmi.checked && f.cra_finance.checked;
      $('#crah').innerHTML = both ? '<span class="pill ok">CRA qualifying</span> Both answers are yes. Compliance confirms before it is reported.' : 'Counts as CRA community development service only when both answers are yes.';
    };
    $('#ot').addEventListener('change', sync); $('#of').addEventListener('change', e => { if (e.target.name && e.target.name.startsWith('cra_')) sync(); }); sync();
    $('#addS').addEventListener('click', () => {
      const rows = $('#shifts').querySelectorAll('.shiftedit');
      const last = rows[rows.length - 1];
      const base = last ? { date: last.querySelector('[name=sdate]').value, start: last.querySelector('[name=sstart]').value, end: last.querySelector('[name=send]').value, capacity: last.querySelector('[name=scap]').value } : { date: S.meta.today, start: '09:00', end: '12:00', capacity: 10 };
      $('#shifts').insertAdjacentHTML('beforeend', shiftRow(base, rows.length));
    });
    $('#shifts').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) b.closest('.shiftedit').remove(); });
    $('#of').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      const shifts = [...f.querySelectorAll('.shiftedit')].map(r => ({
        id: r.querySelector('[name=sid]') ? Number(r.querySelector('[name=sid]').value) : undefined,
        date: r.querySelector('[name=sdate]').value, start: r.querySelector('[name=sstart]').value, end: r.querySelector('[name=send]').value,
        capacity: Number(r.querySelector('[name=scap]').value), label: r.querySelector('[name=slabel]').value
      }));
      const body = { otype: f.otype.value, market_id: Number(mktLocked ? S.me.market_id : f.market_id.value), title: f.title.value, nonprofit: f.nonprofit.value,
        location: f.location.value, address: f.address.value, description: f.description.value, collect_shirts: f.collect_shirts.checked,
        cra_lmi: f.cra_lmi.checked, cra_finance: f.cra_finance.checked, cra_note: f.cra_note.value, status: f.status.value, shifts };
      try {
        await api(isNew ? 'POST' : 'PUT', isNew ? '/admin/opps' : '/admin/opps/' + id, body);
        S.meta = await get('/meta'); toast('Saved.'); go('#/admin/opps');
      } catch (err) { showErr($('#oe'), err); }
    });
  }

  async function vAdminRoster(id) {
    const { opp, rows, waiting = [] } = await get(`/admin/opps/${id}/roster`);
    const byShift = {};
    rows.forEach(r => { (byShift[r.shift_id] = byShift[r.shift_id] || { s: r, people: [] }); if (r.employee_id) byShift[r.shift_id].people.push(r); });
    main.innerHTML = `<a class="back" href="#/admin/opps">${I.left}Opportunities</a>
      <div class="btnrow" style="justify-content:space-between"><h1>${esc(opp.title)}: sign-ups</h1><button class="btn ghost" id="csv">Export CSV</button></div>
      ${Object.values(byShift).map(({ s, people }) => `<div class="panel"><h2>${fmtDate(s.date)}, ${fmtT(s.start)} – ${fmtT(s.end)} ${s.label ? '· ' + esc(s.label) : ''}</h2>
        <p class="muted" style="margin:0">${people.length} of ${s.capacity} spots filled</p>
        ${people.length ? `<div class="tablewrap"><table class="stbl tight"><thead><tr><th>Name</th><th>Branch</th><th>Shirt</th></tr></thead><tbody>${people.map(p => `<tr><td>${esc(p.first_name + ' ' + p.last_name)}</td><td>${esc(p.branch || '')}</td><td>${esc(p.shirt_size || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
        ${(w => w.length ? `<p style="margin:0"><b>Waitlist</b> <small class="muted">(moves up automatically, in this order)</small><br>${w.map((x, i) => `${i + 1}. ${esc(x.first_name + ' ' + x.last_name)}`).join('<br>')}</p>` : '')(waiting.filter(x => x.shift_id === s.shift_id))}</div>`).join('')}`;
    $('#csv').addEventListener('click', () => download(`/admin/opps/${id}/roster?format=csv`, `roster-${id}.csv`));
  }

  async function vApprovals() {
    const [{ rows }, pr, bs] = await Promise.all([can('hours.approve') ? get('/admin/approvals') : { rows: [] }, can('people.edit') ? get('/admin/profile-requests') : { rows: [] },
      can('hours.approve') ? get('/admin/board-seats?status=pending') : { rows: [] }]);
    const craPills = x => `${x.cra_lmi ? '<span class="pill">Serves LMI</span> ' : ''}${x.cra_finance ? '<span class="pill">Financial knowledge</span> ' : ''}${x.cra_lmi && x.cra_finance ? '<span class="pill ok">CRA qualifying</span>' : ''}`;
    const chg = (label, from, to) => to ? `<tr><td>${label}</td><td>${esc(from || '—')}</td><td><b>${esc(to)}</b></td></tr>` : '';
    main.innerHTML = `<h1>Approvals</h1>
      ${can('people.edit') ? `<h2>Profile changes</h2><p class="muted" style="margin:0">Corrections employees sent from their yearly check-in or profile. Approving updates their profile. Also update the HR system, or the next roster import will undo it.</p>
      ${pr.rows.length ? pr.rows.map(x => `<div class="panel" data-pr="${x.id}"><div class="btnrow" style="justify-content:space-between"><b>${esc(x.first_name + ' ' + x.last_name)}</b><small class="muted">#${esc(x.emp_no)} · ${esc(x.market)} · sent ${new Date(x.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</small></div>
        ${x.new_branch || x.new_department || x.new_title || x.new_manager ? `<div class="tablewrap"><table class="stbl tight"><thead><tr><th></th><th>Now</th><th>Change to</th></tr></thead><tbody>
          ${chg('Branch', x.branch, x.new_branch && x.new_branch + (x.new_branch_market_id !== x.market_id ? ` (moves to ${x.new_market})` : ''))}${chg('Department', x.department, x.new_department)}${chg('Title', x.title, x.new_title)}${chg('Manager', x.manager_name, x.new_manager)}</tbody></table></div>` : ''}
        ${x.note ? `<p style="margin:0"><span class="muted">Note:</span> ${esc(x.note)}</p>` : ''}
        <div class="btnrow"><button class="btn sm red" data-ok>Approve</button><input class="input" style="flex:1;min-width:160px" placeholder="Reason (needed to decline)" maxlength="300" data-note><button class="btn sm ghost" data-no>Decline</button></div></div>`).join('') : '<div class="panel empty">No profile changes waiting.</div>'}` : ''}
      ${can('hours.approve') ? `<h2>Volunteer hours</h2><p class="muted" style="margin:0">Volunteering employees logged on their own.${roles().includes('mkta') && !roles().includes('admin') ? ` Showing ${esc(S.me.market)} only.` : ''}</p>
      ${rows.length ? rows.map(h => `<div class="panel" data-h="${h.id}"><div class="btnrow" style="justify-content:space-between"><b>${esc(h.first_name + ' ' + h.last_name)}</b><small class="muted">${esc(h.branch || '')} · ${esc(h.market)}</small></div>
        <div>${fmtDate(h.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} · <b>${hrs(h.minutes)} hours</b> · ${esc(h.org_name || '')}</div>
        <p class="muted" style="margin:0">${esc(h.details || '')}</p>${craPills(h) ? `<div>${craPills(h)}</div>` : ''}
        <div class="btnrow"><button class="btn sm red" data-ok>Approve</button><input class="input" style="flex:1;min-width:160px" placeholder="Reason (needed to decline)" maxlength="300" data-note><button class="btn sm ghost" data-no>Decline</button></div></div>`).join('') : '<div class="panel empty">All caught up. Nothing waiting.</div>'}` : ''}
      ${can('hours.approve') ? `<h2>Board seats</h2><p class="muted" style="margin:0">Nonprofit boards and committees employees serve on. Approved seats go on the CRA board seat export.</p>
      ${bs.rows.length ? bs.rows.map(x => `<div class="panel" data-bs="${x.id}"><div class="btnrow" style="justify-content:space-between"><b>${esc(x.first_name + ' ' + x.last_name)}</b><small class="muted">${esc(x.branch || '')} · ${esc(x.market)}</small></div>
        <div><b>${esc(x.title)}</b>, ${esc(x.org_name)} · ${fmtDate(x.start_date, { month: 'short', year: 'numeric' })} – ${x.is_current ? 'present' : fmtDate(x.end_date, { month: 'short', year: 'numeric' })}</div>
        <p class="muted" style="margin:0">${esc(x.description || '')}</p>${craPills(x) ? `<div>${craPills(x)}</div>` : ''}
        <div class="btnrow"><button class="btn sm red" data-ok>Approve</button><input class="input" style="flex:1;min-width:160px" placeholder="Reason (needed to decline)" maxlength="300" data-note><button class="btn sm ghost" data-no>Decline</button></div></div>`).join('') : '<div class="panel empty">No board seats waiting.</div>'}` : ''}`;
    main.querySelectorAll('[data-bs]').forEach(p => {
      const id = p.dataset.bs;
      const act = async decision => {
        try { await api('POST', `/admin/board-seats/${id}/decide`, { decision, note: p.querySelector('[data-note]').value }); toast(decision === 'approved' ? 'Approved.' : 'Declined.'); vApprovals(); } catch (err) { toast(err.message); }
      };
      p.querySelector('[data-ok]').addEventListener('click', () => act('approved'));
      p.querySelector('[data-no]').addEventListener('click', () => act('rejected'));
    });
    main.querySelectorAll('[data-pr]').forEach(p => {
      const id = p.dataset.pr;
      const act = async decision => {
        try { await api('POST', `/admin/profile-requests/${id}/decide`, { decision, note: p.querySelector('[data-note]').value }); toast(decision === 'approved' ? 'Profile updated.' : 'Declined.'); vApprovals(); } catch (err) { toast(err.message); }
      };
      p.querySelector('[data-ok]').addEventListener('click', () => act('approved'));
      p.querySelector('[data-no]').addEventListener('click', () => act('rejected'));
    });
    main.querySelectorAll('[data-h]').forEach(p => {
      const id = p.dataset.h;
      const act = async decision => {
        try { await api('POST', `/admin/hours/${id}/decide`, { decision, note: p.querySelector('[data-note]').value }); toast(decision === 'approved' ? 'Approved.' : 'Declined.'); vApprovals(); } catch (err) { toast(err.message); }
      };
      p.querySelector('[data-ok]').addEventListener('click', () => act('approved'));
      p.querySelector('[data-no]').addEventListener('click', () => act('rejected'));
    });
  }

  async function vPeople() {
    const qv = sessionStorage.getItem('cc_pq') || '';
    const { rows } = await get('/admin/people?q=' + encodeURIComponent(qv));
    main.innerHTML = `<div class="btnrow" style="justify-content:space-between"><h1>${can('people.view') ? 'People' : 'Password resets'}</h1>${can('roster.import') ? '<a class="btn ghost" href="#/admin/import">Import roster</a>' : ''}</div>
      <form id="pq" class="toolbar"><input class="input search" name="q" value="${esc(qv)}" placeholder="Search name, username or employee #"><button class="btn ghost">Search</button></form>
      <div class="tablewrap"><table class="stbl tight"><thead><tr><th>Name</th><th>Market / branch</th><th>Sign-in</th><th>Roles</th><th class="num">Hours this year</th></tr></thead><tbody>
      ${rows.map(p => `<tr class="click" data-id="${p.id}"><td><a href="#/admin/person/${p.id}">${esc(p.first_name + ' ' + p.last_name)}</a>${p.active ? '' : ' <span class="pill">Inactive</span>'}<br><small class="muted">${esc(p.emp_no)}</small></td><td>${esc(p.market)}<br><small class="muted">${esc(p.branch || '')}</small></td><td>${p.username ? esc(p.username) : '<span class="muted">None yet</span>'}</td><td>${p.roles.map(r => ROLE[r]).join(', ')}</td><td class="num">${p.ytd_min == null ? '—' : hrs(p.ytd_min)}</td></tr>`).join('')}
      </tbody></table></div><small class="muted">${rows.length} people${rows.length === 500 ? ' (first 500; search to narrow)' : ''}</small>`;
    $('#pq').addEventListener('submit', e => { e.preventDefault(); sessionStorage.setItem('cc_pq', e.target.q.value); vPeople(); });
  }

  async function vPerson(id) {
    const { person: p, hours, limited } = await get('/admin/people/' + id);
    if (limited) return vPersonReset(id, p);
    const isAdmin = roles().includes('admin');
    const brs = S.meta.branches.filter(b => b.market_id === p.market_id);
    main.innerHTML = `<a class="back" href="#/admin/people">${I.left}People</a><h1>${esc(p.first_name + ' ' + p.last_name)}</h1>
      <div class="detail even"><form class="panel" id="ef"><h2>Profile</h2>
        <div class="formgrid">
          <div class="field"><label>First name</label><input class="input" name="first_name" value="${esc(p.first_name)}" required></div>
          <div class="field"><label>Last name</label><input class="input" name="last_name" value="${esc(p.last_name)}" required></div>
          <div class="field"><label>Market</label><select class="input" name="market_id" ${isAdmin ? '' : 'disabled'}>${S.meta.markets.map(m => `<option value="${m.id}" ${m.id === p.market_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Branch</label><select class="input" name="branch_id"><option value="">—</option>${brs.map(b => `<option value="${b.id}" ${b.id === p.branch_id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Department</label><select class="input" name="department_id"><option value="">—</option>${S.meta.departments.map(dd => `<option value="${dd.id}" ${dd.id === p.department_id ? 'selected' : ''}>${esc(dd.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Title</label><input class="input" name="title" value="${esc(p.title || '')}"></div>
          <div class="field"><label>Manager</label><input class="input" name="manager_name" maxlength="120" value="${esc(p.manager_name || '')}"></div>
        </div>
        <small class="muted">Info last confirmed by employee: ${p.info_confirmed_at ? new Date(p.info_confirmed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'never'}</small>
        <label class="toggle"><input type="checkbox" name="officer" ${p.officer ? 'checked' : ''}><span class="sw"></span><small>Bank officer</small></label>
        <label class="toggle"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}><span class="sw"></span><small>Active employee (turning off signs them out)</small></label>
        ${isAdmin ? `<fieldset style="border:0;padding:0;margin:0"><legend class="flabel">Roles</legend>${Object.entries(ROLE).map(([k, l]) => `<label class="toggle"><input type="checkbox" name="role" value="${k}" ${p.roles.includes(k) ? 'checked' : ''}><span class="sw"></span><small>${l}</small></label>`).join('')}<small class="muted">Market admins manage only the market on this person's profile.</small></fieldset>` : ''}
        ${isAdmin && (p.phone || p.personal_email) ? `<small class="muted">Phone: ${esc(p.phone || '—')} · Email: ${esc(p.personal_email || '—')}</small>` : ''}
        <p class="err" id="ee" hidden></p><button class="btn red" type="submit">Save</button></form>
      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="panel"><h2>Sign-in</h2>
          ${p.has_account ? `<p style="margin:0">Username <b>${esc(p.username)}</b>${p.must_change ? ' · <span class="pill warn">Temporary password</span>' : ''}${p.locked_until && new Date(p.locked_until) > new Date() ? ' · <span class="pill">Locked</span>' : ''}</p>` : '<p class="muted" style="margin:0">No sign-in yet.</p>'}
          ${can('people.edit') ? `<button class="btn ghost" id="acct">${p.has_account ? 'Reset password' : 'Create sign-in'}</button>` : ''}<div id="acctOut"></div></div>
        ${can('hours.approve') ? `<form class="panel" id="ahf"><h2>Add hours</h2><div class="formgrid">
          <div class="field"><label>Date</label><input class="input" type="date" name="date" max="${S.meta.today}" required></div>
          <div class="field"><label>Hours</label><input class="input" type="number" name="hours" min="0.25" max="16" step="0.25" required></div>
          <div class="field span"><label>Organization</label><input class="input" name="org_name" maxlength="120" required></div></div>
          <p class="err" id="ahe" hidden></p><button class="btn ghost" type="submit">Add approved hours</button></form>` : ''}
        <div class="panel"><h2>Hours</h2>${hours.length ? `<div class="tablewrap"><table class="stbl tight"><tbody>${hours.map(h => `<tr><td>${fmtDate(h.date, { month: 'short', day: 'numeric', year: 'numeric' })}</td><td>${esc(h.what || '')}</td><td class="num">${hrs(h.minutes)}</td><td>${STATUS[h.status]}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted" style="margin:0">None yet.</p>'}</div>
      </div></div>`;
    $('#ef').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      const body = { first_name: f.first_name.value, last_name: f.last_name.value, title: f.title.value, manager_name: f.manager_name.value, officer: f.officer.checked, active: f.active.checked,
        branch_id: f.branch_id.value || null, department_id: f.department_id.value || null };
      if (isAdmin) { body.market_id = Number(f.market_id.value); body.roles = [...f.querySelectorAll('[name=role]:checked')].map(x => x.value); }
      if (isAdmin && body.market_id !== p.market_id) body.branch_id = null;
      try { await api('PATCH', '/admin/people/' + id, body); toast('Saved.'); vPerson(id); } catch (err) { showErr($('#ee'), err); }
    });
    const ab = $('#acct');
    if (ab) ab.addEventListener('click', async () => {
      if (p.has_account && !window.confirm('Reset this password? They will be signed out everywhere.')) return;
      try {
        const r = await api('POST', `/admin/people/${id}/account`);
        $('#acctOut').innerHTML = `<p style="margin:8px 0 4px">Give these to ${esc(p.first_name)} in person or by phone. The password works once; they'll set their own at first sign-in.</p>
          <div>Username: <span class="pw">${esc(r.username)}</span></div><div style="margin-top:6px">Temporary password: <span class="pw">${esc(r.tempPassword)}</span></div>
          <small class="muted">This password won't be shown again.</small>`;
      } catch (err) { toast(err.message); }
    });
    const ah = $('#ahf');
    if (ah) ah.addEventListener('submit', async e => {
      e.preventDefault();
      try { await api('POST', '/admin/hours', { employee_id: Number(id), ...formData(e.target) }); toast('Hours added.'); vPerson(id); } catch (err) { showErr($('#ahe'), err); }
    });
  }

  // IT help desk view: identity check and reset only.
  function vPersonReset(id, p) {
    const roleHolder = p.roles.length > 0;
    main.innerHTML = `<a class="back" href="#/admin/people">${I.left}Password resets</a><h1>${esc(p.first_name + ' ' + p.last_name)}</h1>
      <div class="panel" style="max-width:620px"><dl class="facts"><dt>${I.user}Employee #</dt><dd>${esc(p.emp_no)}</dd><dt>${I.org}Market</dt><dd>${esc(p.market)}</dd><dt>${I.pin}Branch</dt><dd>${esc(p.branch || '—')}</dd><dt>${I.check}Sign-in</dt><dd>${p.has_account ? esc(p.username) : 'None yet'}${p.locked_until && new Date(p.locked_until) > new Date() ? ' · <span class="pill">Locked</span>' : ''}</dd></dl>
        <div class="note"><b>Before you reset:</b> confirm it's really them. Call them back at a number on file with HR, or check with their manager. Never reset based on an email or text alone.</div>
        ${!p.active ? '<p class="err">Marked inactive. An admin must reactivate them first.</p>' : roleHolder ? '<p class="err">This person has an admin role. Only an Administrator can reset their sign-in.</p>' : `<label class="toggle"><input type="checkbox" id="vf"><span class="sw"></span><small>I confirmed this person's identity</small></label><button class="btn red" id="acct" disabled>${p.has_account ? 'Reset password' : 'Create sign-in'}</button>`}
        <div id="acctOut"></div></div>`;
    const vf = $('#vf'), ab = $('#acct');
    if (!vf) return;
    vf.addEventListener('change', () => { ab.disabled = !vf.checked; });
    ab.addEventListener('click', async () => {
      try {
        const r = await api('POST', `/admin/people/${id}/account`);
        ab.disabled = true;
        $('#acctOut').innerHTML = `<p style="margin:8px 0 4px">Give these to ${esc(p.first_name)} by phone or in person, not by email. They'll set their own password at sign-in.</p>
          <div>Username: <span class="pw">${esc(r.username)}</span></div><div style="margin-top:6px">Temporary password: <span class="pw">${esc(r.tempPassword)}</span></div><small class="muted">This password won't be shown again.</small>`;
      } catch (err) { toast(err.message); }
    });
  }

  function vImport() {
    main.innerHTML = `<a class="back" href="#/admin/people">${I.left}People</a><div class="panel" style="max-width:820px"><h1>Import employee roster</h1>
      <p class="muted" style="margin:0">Load every employee at the bank, including people who never use the app, so reports show true participation. Re-import any time; people are matched by employee number.</p>
      <p style="margin:0"><b>Columns:</b> emp_no, first_name, last_name, market, branch, department, title, officer, hire_date, active. The first four are required. Market must be ${S.meta.markets.map(m => esc(m.name)).join(', ')}.</p>
      <div class="field"><label for="rf">CSV file (exported from HR)</label><input class="input" type="file" id="rf" accept=".csv,text/csv"></div>
      <label class="toggle"><input type="checkbox" id="rdm"><span class="sw"></span><small>Mark employees who aren't in this file as inactive (use for a full roster)</small></label>
      <div class="btnrow"><button class="btn ghost" id="rprev" disabled>Check file</button><button class="btn red" id="rgo" disabled>Import</button></div>
      <div id="rout"></div><small class="muted">The file is processed on the server and not stored. Only HR fields above are loaded.</small></div>`;
    let csv = '';
    const show = (r, committed) => {
      const s = r.summary;
      $('#rout').innerHTML = `<div class="note ${s.errorCount ? '' : 'ok'}"><b>${committed ? 'Imported.' : 'Check complete.'}</b> ${s.valid} of ${s.rows} rows OK · ${s.adds} new · ${s.updates} updated${s.deactivations ? ` · ${s.deactivations} will be marked inactive` : ''}${s.errorCount ? `<br>${s.errorCount} problem(s):<br>${s.errors.map(esc).join('<br>')}` : ''}</div>`;
      $('#rgo').disabled = !!s.errorCount || committed;
    };
    $('#rf').addEventListener('change', async e => {
      const file = e.target.files[0]; if (!file) return;
      if (file.size > 2.5 * 1024 * 1024) return toast('That file is over 2.5 MB.');
      csv = await file.text(); $('#rprev').disabled = false; $('#rgo').disabled = true; $('#rout').innerHTML = '';
    });
    $('#rprev').addEventListener('click', async () => {
      try { show(await api('POST', '/admin/roster/import', { csv, deactivateMissing: $('#rdm').checked }), false); } catch (err) { toast(err.message); }
    });
    $('#rgo').addEventListener('click', async () => {
      if (!window.confirm('Import this roster now?')) return;
      try { show(await api('POST', '/admin/roster/import', { csv, deactivateMissing: $('#rdm').checked, commit: true }), true); S.meta = await get('/meta'); } catch (err) { toast(err.message); }
    });
  }

  async function vReports() {
    const by = sessionStorage.getItem('cc_by') || 'market';
    const year = sessionStorage.getItem('cc_year') || S.meta.today.slice(0, 4);
    const r = await get(`/admin/reports/participation?by=${by}&year=${year}`);
    const y0 = Number(S.meta.today.slice(0, 4));
    main.innerHTML = `<h1>Reports</h1><p class="muted" style="margin:0">${esc(r.scope)} · approved hours · impact = community hours × $${r.rate}/hr</p>
      <div class="kpis"><div class="kpi"><b>${r.total.participation}%</b><span>Participation</span><small>${r.total.volunteers} of ${r.total.employees} employees volunteered</small></div>
        <div class="kpi"><b>${n1(r.total.hours)}</b><span>Volunteer hours</span></div><div class="kpi"><b>${money(r.total.impact)}</b><span>Financial impact</span></div></div>
      <div class="toolbar">${['market', 'branch', 'department', 'officer'].map(b => `<button class="chip" data-by="${b}" aria-pressed="${by === b}">By ${b}</button>`).join('')}
        <select class="input" id="yr" style="width:auto">${[y0, y0 - 1, y0 - 2].map(y => `<option ${String(y) === String(year) ? 'selected' : ''}>${y}</option>`).join('')}</select></div>
      <div class="tablewrap"><table class="stbl tight"><thead><tr><th>${by[0].toUpperCase() + by.slice(1)}</th><th class="num">Employees</th><th class="num">Volunteers</th><th class="num">Participation</th><th class="num">Hours</th><th class="num">Impact</th></tr></thead><tbody>
      ${r.rows.map(x => `<tr><td>${esc(x.group)}</td><td class="num">${x.employees}</td><td class="num">${x.volunteers}</td><td class="num">${x.participation}%</td><td class="num">${n1(x.hours)}</td><td class="num">${money(x.impact)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td>Total</td><td class="num">${r.total.employees}</td><td class="num">${r.total.volunteers}</td><td class="num">${r.total.participation}%</td><td class="num">${n1(r.total.hours)}</td><td class="num">${money(r.total.impact)}</td></tr></tfoot></table></div>
      <div class="btnrow"><button class="btn ghost" id="d1">Export this table</button><button class="btn ghost" id="d2">Export all hours</button>${can('reports.cra') ? '<button class="btn ghost" id="d3">Export CRA hours</button><button class="btn ghost" id="d4">Export board seats</button>' : ''}</div>
      <small class="muted">Participation uses the employee roster. Load the full roster under People for accurate numbers.</small>`;
    main.querySelectorAll('[data-by]').forEach(b => b.addEventListener('click', () => { sessionStorage.setItem('cc_by', b.dataset.by); vReports(); }));
    $('#yr').addEventListener('change', e => { sessionStorage.setItem('cc_year', e.target.value); vReports(); });
    $('#d1').addEventListener('click', () => download(`/admin/reports/participation?by=${by}&year=${year}&format=csv`, `participation-${by}-${year}.csv`));
    $('#d2').addEventListener('click', () => download(`/admin/reports/hours?year=${year}&format=csv`, `hours-${year}.csv`));
    if ($('#d3')) $('#d3').addEventListener('click', () => download(`/admin/reports/hours?year=${year}&cra=1&format=csv`, `cra-hours-${year}.csv`));
    if ($('#d4')) $('#d4').addEventListener('click', () => download('/admin/board-seats?format=csv', 'board-seats.csv'));
  }

  async function vSettings() {
    const [s, a] = await Promise.all([get('/admin/settings'), get('/admin/audit')]);
    main.innerHTML = `<h1>Settings</h1><form class="panel" id="stf" style="max-width:520px"><div class="field"><label for="ir">Impact rate ($ per community volunteer hour)</label><input class="input" id="ir" name="impact_rate" type="number" step="0.01" min="1" value="${s.impact_rate}"><small>Internal standard. Cite a source if the number is shared outside the bank.</small></div><div class="field"><label for="hde">IT help desk email</label><input class="input" id="hde" name="helpdesk_email" type="email" value="${esc(s.helpdesk_email || '')}"><small>Shown on the sign-in page as "Email the IT help desk" for forgotten passwords.</small></div><div class="field"><label for="pcm">Profile check-in</label><select class="input" id="pcm" name="profile_check_months">${[[12, 'Once a year'], [6, 'Twice a year'], [0, 'Off']].map(([v, l]) => `<option value="${v}" ${s.profile_check_months === v ? 'selected' : ''}>${l}</option>`).join('')}</select><small>Employees confirm their branch, department, title and manager. Corrections come to Approvals.</small></div><button class="btn red">Save</button></form>
      <div class="panel"><h2>Audit log (latest 300)</h2><div class="tablewrap"><table class="stbl tight"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Target</th></tr></thead><tbody>
      ${a.rows.map(x => `<tr><td>${new Date(x.at).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}</td><td>${esc(x.actor || 'Kiosk / system')}</td><td>${esc(x.action)}</td><td>${esc(x.target || '')}</td></tr>`).join('')}</tbody></table></div></div>`;
    $('#stf').addEventListener('submit', async e => {
      e.preventDefault();
      try { await api('PUT', '/admin/settings', { impact_rate: Number(e.target.impact_rate.value), helpdesk_email: e.target.helpdesk_email.value, profile_check_months: Number(e.target.profile_check_months.value) }); S.meta = await get('/meta'); toast('Saved.'); } catch (err) { toast(err.message); }
    });
  }

  // ---------- start ----------
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  route();
})();
