'use strict';
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

async function migrate() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  // Keep the allowed-roles list current on databases created before a role was added.
  await pool.query(`ALTER TABLE employees DROP CONSTRAINT IF EXISTS roles_valid`);
  await pool.query(`ALTER TABLE employees ADD CONSTRAINT roles_valid CHECK (roles <@ ARRAY['admin','mkt','comp','ccm','mkta','it']::text[])`);
  // Profile check-in: manager name, last confirmation, and employee change requests reviewed by an admin.
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS manager_name text`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS info_confirmed_at timestamptz`);
  await pool.query(`CREATE TABLE IF NOT EXISTS profile_requests (
    id serial PRIMARY KEY,
    employee_id int NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    branch_id int REFERENCES branches(id),
    department_id int REFERENCES departments(id),
    title text,
    manager_name text,
    note text,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    decided_by int REFERENCES employees(id),
    decided_at timestamptz,
    decision_note text,
    created_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS profile_requests_one_pending ON profile_requests(employee_id) WHERE status='pending'`);
  // CRA service questions, board seats, and shift waitlists.
  await pool.query(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS cra_lmi boolean NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS cra_finance boolean NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE hours ADD COLUMN IF NOT EXISTS cra_lmi boolean NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE hours ADD COLUMN IF NOT EXISTS cra_finance boolean NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE signups ADD COLUMN IF NOT EXISTS from_waitlist boolean NOT NULL DEFAULT false`);
  await pool.query(`CREATE TABLE IF NOT EXISTS waitlist (
    id serial PRIMARY KEY,
    shift_id int NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    employee_id int NOT NULL REFERENCES employees(id),
    shirt_size text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (shift_id, employee_id))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS board_seats (
    id serial PRIMARY KEY,
    employee_id int NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    org_name text NOT NULL,
    title text NOT NULL,
    is_current boolean NOT NULL DEFAULT true,
    start_date date NOT NULL,
    end_date date,
    description text NOT NULL DEFAULT '',
    cra_lmi boolean NOT NULL DEFAULT false,
    cra_finance boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    decided_by int REFERENCES employees(id),
    decided_at timestamptz,
    decision_note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`INSERT INTO settings (key, value) VALUES ('profile_check_months', '12') ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO markets (name) VALUES ('Permian Basin'),('Lubbock'),('Dallas') ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO settings (key, value) VALUES ('impact_rate', '30') ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO settings (key, value) VALUES ('helpdesk_email', '"ticket@cnbtx.com"') ON CONFLICT DO NOTHING`);
}

if (require.main === module) {
  migrate().then(() => { console.log('Database is ready.'); return pool.end(); })
    .catch(e => { console.error(e); process.exit(1); });
}
module.exports = { migrate };
