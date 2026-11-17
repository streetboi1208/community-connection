// App usage: records which page is open and how long it stays on screen.
// Each visit is sent when it starts and again when it ends, so a closed tab still counts the visit.
(function () {
  'use strict';
  let cur = null;
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
  const secs = () => Math.round((cur.acc + (cur.since ? Date.now() - cur.since : 0)) / 1000);
  function send(v, leaving) {
    try {
      // When the page is closing, a beacon is the one request the browser reliably finishes.
      if (leaving && navigator.sendBeacon && navigator.sendBeacon('/api/track', new Blob([JSON.stringify({ views: [v] })], { type: 'application/json' }))) return;
      fetch('/api/track', { method: 'POST', keepalive: true, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'cc' }, body: JSON.stringify({ views: [v] }) }).catch(() => {});
    } catch (e) { /* tracking never interrupts the app */ }
  }
  function end(leaving) { if (cur) { send({ id: cur.id, page: cur.page, seconds: secs() }, leaving); cur = null; } }
  window.ccTrack = function (page) {
    if (!page || (cur && cur.page === page)) return;
    end();
    cur = { id: newId(), page: String(page).slice(0, 60), acc: 0, since: document.hidden ? 0 : Date.now() };
    send({ id: cur.id, page: cur.page, seconds: 0 });
  };
  window.ccTrackStop = () => end(false);
  // Only time on screen counts: pause when the app is in the background.
  document.addEventListener('visibilitychange', () => {
    if (!cur) return;
    if (document.hidden) { cur.acc += cur.since ? Date.now() - cur.since : 0; cur.since = 0; send({ id: cur.id, page: cur.page, seconds: secs() }, true); }
    else cur.since = Date.now();
  });
  window.addEventListener('pagehide', () => end(true));
  // Save the running time every 30 seconds, so a phone that drops the page loses at most that much.
  setInterval(() => { if (cur && !document.hidden) send({ id: cur.id, page: cur.page, seconds: secs() }); }, 30000);
})();
