'use strict';
// Full-app preview: the final clickable mockup, shown to signed-in people only.
// It runs entirely in the browser on fictional sample data and saves nothing to the server.
const fs = require('fs');
const path = require('path');
const { loadUser } = require('./auth');

const FILE = path.join(__dirname, '..', 'preview', 'full.html');
const BANNER = '<div style="background:#ffd54a;color:#13294b;font:600 13px/1.4 system-ui,sans-serif;padding:8px 12px;text-align:center">'
  + 'Full preview: sample data only, nothing here is saved. '
  + '<a href="/" style="color:#13294b;text-decoration:underline">Back to the live app</a></div>';
let html = null;
function page() {
  if (!html) html = fs.readFileSync(FILE, 'utf8').replace(/<body([^>]*)>/, m => m + BANNER);
  return html;
}

module.exports = function preview(app) {
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
