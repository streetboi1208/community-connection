# Galaxy volunteer history (real CNB data)

Loaded into the pilot on start by `db/import-galaxy.js`. Approved by Eddie Montoya on Nov 16, 2026.

- `roster.csv`: 381 employees (318 active Galaxy users with an @cnbtx.com email, plus 63 people who volunteered in 2025 or 2026 but are no longer active). Friends and family (no @cnbtx.com email; Eddie, Nov 16) are left out. Names, market, branch, department, officer level, Culture Committee flag. `emp_no` values starting with `G-` are Galaxy-based placeholders until the HR roster (with real employee numbers) is imported. `market_assumed = yes` means Galaxy had no branch or market, so the person was placed in Permian Basin.
- `hours.csv`: 1,503 approved employee hour records, 2025 and 2026, using the volunteer rule: only volunteer events (community) and CNB volunteer events (bank) count. Off the Clock, tickets and sponsorships are not hours. Two entries over 24 hours (AirSho, 50 h and 100 h) are split into 24-hour parts; they are still unconfirmed.
- 2025 totals 2,327.75 hours. Eddie's year-end summary says 2,316.25; the 11.5-hour difference is per-branch adjustments that aren't tied to a person.

No emails, phone numbers, birthdays, addresses or emergency contacts are included.
- `guests.csv`: 80 friends-and-family sign-ups (no guest names; a code per guest), each credited to the employee(s) on the same team for that shift. Used by the Report builder's Friends and family report.
