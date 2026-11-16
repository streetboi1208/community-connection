# CNB Community Connection (pilot)

The employee volunteer and engagement app for Community National Bank. This is **phase 1** of a working pilot, built from the clickable prototype.

> **Pilot rules:** sample data only until Information Security approves hosting and security. Never load customer data.

## What phase 1 does

| Area | Employees | Admin roles |
| --- | --- | --- |
| Sign-in | Username and password; temporary password must be changed at first sign-in; lockout after 5 misses | Create sign-ins and reset passwords (temporary password shown once) |
| Volunteer | Browse their market (or all markets), see who's going, sign up for one or more shifts, shirt sizes, cancel | Create and edit opportunities and events with multiple shifts, view and export sign-ups |
| Hours | Log outside volunteering for approval, see history and status | Approve or decline (with a reason), add hours for someone; nobody approves their own |
| Kiosk | Check in and out on a shared iPad; walk-ins, guests, undo | Culture Committee or Administrator opens a kiosk for one event; it expires in 18 hours |
| Roster | | Import every employee from an HR CSV so participation % is real |
| Reports | | Participation, hours and impact by market, branch, department or officer; hours and CRA exports |
| Settings | | Impact rate ($30 per community hour by default), audit log |

Roles: **Administrator** (everything), **Marketing** (CNB and off-the-clock events, rosters), **Compliance** (reports only), **Culture Committee** (rosters and kiosk), **Market admin** (opportunities, people, approvals and hours reports for the market on their own profile), **IT help desk** (find people and reset sign-ins only; can't reset anyone with an admin role). The server checks permissions on every request.

Later phases: notifications, points and store, raffles, ticketed events, training, games, gallery, committee hub, swag, donations.

## Run it on a computer

Needs Node.js 20+ and PostgreSQL 14+.

```bash
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/community_connection
npm run db:seed        # creates tables, sample employees and one demo sign-in per role (printed once)
npm start              # http://localhost:3000
```

On a phone, open the site and choose **Add to Home Screen** to install it like an app.

## Tests

```bash
export TEST_DATABASE_URL=postgres://user:pass@localhost:5432/cc_test   # a throwaway database; it is wiped
LOGIN_RATE_LIMIT=1000 npm test
```

## Deploy

Any host that runs Node and PostgreSQL works (Azure App Service + Azure Database for PostgreSQL, Render, AWS). A `Dockerfile` is included.

Environment variables:

| Name | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `PGSSL=require` | Use TLS to the database (set in production) |
| `NODE_ENV=production` | Secure cookies, HSTS |
| `TRUST_PROXY=1` | When behind the host's load balancer, so rate limits see real client IPs |
| `PORT` | Defaults to 3000 |
| `APP_TZ` | Defaults to America/Chicago |
| `DEMO_PASSWORD` | Optional, seed only: give every demo account this password with no forced change (pilot demos only) |

First deploy: run `npm run db:setup` (tables only) or `npm run db:seed` (tables plus sample data) once against the database.

## Security notes

- Passwords hashed with scrypt; sessions are random tokens stored hashed, in HttpOnly SameSite cookies, 12-hour lifetime.
- Login rate limiting and account lockout; generic error messages.
- CSRF: every state-changing request needs an `X-Requested-With: cc` header plus SameSite cookies.
- Strict Content-Security-Policy (no inline scripts), HSTS in production, no API caching.
- Parameterized SQL everywhere; CSV exports neutralize spreadsheet formulas.
- Audit log of sign-ins, approvals, role changes, account resets, imports, kiosk activity and settings.
- Phone numbers and personal email are visible only to Administrators.

Before real data: independent penetration test, ISO review of hosting, two-step verification for admin roles (planned), backups and monitoring, and Privacy Guide sign-off.
