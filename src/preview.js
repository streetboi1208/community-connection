'use strict';
// Full-app preview: the final clickable mockup, shown to signed-in people only.
// It runs entirely in the browser on fictional sample data and saves nothing to the server.
const fs = require('fs');
const path = require('path');
const { loadUser } = require('./auth');

// 2026 photo albums (the "Final" folders from CNB's event photos), resized for the web.
// Served only to signed-in people; see gallery/README.md.
const GDIR = path.join(__dirname, '..', 'gallery', '2026');
function galleryEntries() {
  const f = path.join(GDIR, 'albums.json');
  if (!fs.existsSync(f)) return null;
  let id = 1000;
  return JSON.parse(fs.readFileSync(f, 'utf8')).flatMap(a => Array.from({ length: a.count }, (_, i) => {
    const n = String(i + 1).padStart(3, '0');
    return { id: id++, src: `/preview/photos/${a.key}/${n}.jpg`, th: `/preview/photos/${a.key}/${n}t.jpg`, cap: `Photo ${i + 1} of ${a.count}`, ev: a.ev,
      date: a.date, market: a.market, by: 'CNB Marketing', status: 'published' };
  }));
}

const FILE = path.join(__dirname, '..', 'preview', 'full.html');
const BANNER = '<div style="background:#ffd54a;color:#13294b;font:600 13px/1.4 system-ui,sans-serif;padding:8px 12px;text-align:center">'
  + 'Full preview: sample data only, nothing here is saved. '
  + '<a href="/" style="color:#13294b;text-decoration:underline">Back to the live app</a></div>';
// App usage for the full preview: every screen change is recorded under a friendly page name.
const NAMES = { home: 'Home', list: 'Volunteer', detail: 'Event details', mine: 'My activity', profile: 'Profile', more: 'More',
  games: 'Games', glive: 'Live game', trivia: 'Live game', training: 'Training', trlesson: 'Training lesson', rewards: 'Points store',
  cc: 'Culture Committee', leaders: 'Leaderboard', gallery: 'Photo gallery', btb: 'Beyond the Bank', raffle: 'Raffles', tickets: 'Tickets',
  events: 'Events', swag: 'Swag orders', inbox: 'Notifications', nset: 'Notification settings', nonprofits: 'Nonprofits', np: 'Nonprofits',
  ownlog: 'Log hours', donpublic: 'Donation request', kiosk: 'Kiosk', tradmin: 'Admin: Training', storeadmin: 'Admin: Store',
  gadmin: 'Admin: Games', swagadmin: 'Admin: Swag', galadmin: 'Admin: Gallery', ahome: 'Admin: Home', dash: 'Admin: Dashboard',
  manage: 'Admin: Opportunities', new: 'Admin: Opportunities', rosters: 'Admin: Roster', roster: 'Admin: Roster', approvals: 'Admin: Approvals',
  people: 'Admin: People', person: 'Admin: People', roles: 'Admin: Roles', creports: 'Admin: Reports', donations: 'Admin: Donations',
  notify: 'Admin: Notifications', attendance: 'Admin: Attendance', venues: 'Admin: Tickets', tnew: 'Admin: Tickets', rnew: 'Admin: Raffles' };
const TRACK = '<script src="/track.js"></script><script>(function(){var N=' + JSON.stringify(NAMES)
  + ';if(typeof render!=="function"||!window.ccTrack)return;var r0=render,last="";function t(){try{var n=N[S.view]||"Other";if(n!==last){last=n;ccTrack(n)}}catch(e){}}'
  + 'render=function(){var o=r0.apply(this,arguments);t();return o};t()})();</script>';
let html = null;
function page() {
  if (!html) {
    html = fs.readFileSync(FILE, 'utf8').replace(/<body([^>]*)>/, m => m + BANNER) + TRACK;
    // Swap the mockup's few sample photos for the real 2026 albums; keep its pending-approval examples.
    const real = galleryEntries();
    const at = html.indexOf('const REALGAL=');
    if (real && at >= 0) {
      const start = at + 'const REALGAL='.length;
      let depth = 0, end = start;
      for (; end < html.length; end++) { const ch = html[end]; if (ch === '[') depth++; else if (ch === ']' && --depth === 0) break; }
      const pending = JSON.parse(html.slice(start, end + 1)).filter(g => g.status !== 'published');
      html = html.slice(0, start) + JSON.stringify(real.concat(pending)).replace(/</g, '\\u003c') + html.slice(end + 1);
    }
  }
  return html;
}

module.exports = function preview(app) {
  app.get('/preview/photos/:album/:file', loadUser, (req, res) => {
    if (!req.user || req.user.must_change) return res.status(401).end();
    const { album, file } = req.params;
    if (!/^[0-9]{2}-[a-z0-9-]+$/.test(album) || !/^[0-9]{3}t?\.jpg$/.test(file)) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=604800');
    res.sendFile(path.join(GDIR, album, file), err => { if (err && !res.headersSent) res.status(404).end(); });
  });

  app.get('/preview', loadUser, (req, res) => {
    if (!req.user || req.user.must_change) return res.redirect('/');
    res.set({
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      // The mockup is one self-contained file with inline scripts, so it gets its own policy.
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "connect-src 'self' data: blob:",
        "frame-ancestors 'none'", "form-action 'self'", "base-uri 'self'", "object-src 'none'"
      ].join('; ')
    });
    res.type('html').send(page());
  });
};
