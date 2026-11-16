-- Community Connection, phase 1 schema (PostgreSQL 14+)
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS markets (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS branches (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  market_id int NOT NULL REFERENCES markets(id)
);

CREATE TABLE IF NOT EXISTS departments (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

-- Every employee at the bank (the roster), whether or not they use the app.
-- An employee becomes a user when an admin issues them a username.
CREATE TABLE IF NOT EXISTS employees (
  id serial PRIMARY KEY,
  emp_no text NOT NULL UNIQUE,
  first_name text NOT NULL,
  last_name text NOT NULL,
  market_id int NOT NULL REFERENCES markets(id),
  branch_id int REFERENCES branches(id),
  department_id int REFERENCES departments(id),
  title text,
  officer boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  hire_date date,
  -- account
  username text UNIQUE,
  pass_hash text,
  must_change boolean NOT NULL DEFAULT true,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  roles text[] NOT NULL DEFAULT '{}',
  -- profile (employee-controlled)
  phone text,
  personal_email text,
  text_consent_at timestamptz,
  shirt_size text,
  show_name boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_valid CHECK (roles <@ ARRAY['admin','mkt','comp','ccm','mkta','it']::text[])
);
CREATE INDEX IF NOT EXISTS employees_market_idx ON employees(market_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  employee_id int NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip text,
  user_agent text
);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_id int REFERENCES employees(id),
  action text NOT NULL,
  target text,
  detail jsonb
);
CREATE INDEX IF NOT EXISTS audit_at_idx ON audit_log(at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS nonprofits (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  market_id int REFERENCES markets(id)
);

-- otype: community (nonprofit, counts toward impact $), bank (CNB event, hours count, no impact $),
--        social (off the clock: attendance only, no hours)
CREATE TABLE IF NOT EXISTS opportunities (
  id serial PRIMARY KEY,
  otype text NOT NULL DEFAULT 'community' CHECK (otype IN ('community','bank','social')),
  title text NOT NULL,
  nonprofit_id int REFERENCES nonprofits(id),
  market_id int NOT NULL REFERENCES markets(id),
  location text NOT NULL,
  address text,
  description text NOT NULL DEFAULT '',
  collect_shirts boolean NOT NULL DEFAULT false,
  cra boolean NOT NULL DEFAULT false,
  cra_note text,
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','cancelled')),
  created_by int REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shifts (
  id serial PRIMARY KEY,
  opp_id int NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  label text,
  date date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  capacity int NOT NULL CHECK (capacity > 0),
  CONSTRAINT shift_times CHECK (end_time > start_time)
);
CREATE INDEX IF NOT EXISTS shifts_opp_idx ON shifts(opp_id);

CREATE TABLE IF NOT EXISTS signups (
  id serial PRIMARY KEY,
  shift_id int NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  employee_id int NOT NULL REFERENCES employees(id),
  shirt_size text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shift_id, employee_id)
);

-- Volunteer hours. source: kiosk (checked in/out at the event), self (employee logged it), admin (added for someone)
CREATE TABLE IF NOT EXISTS hours (
  id serial PRIMARY KEY,
  employee_id int NOT NULL REFERENCES employees(id),
  opp_id int REFERENCES opportunities(id),
  shift_id int REFERENCES shifts(id),
  source text NOT NULL CHECK (source IN ('kiosk','self','admin')),
  date date NOT NULL,
  minutes int NOT NULL CHECK (minutes > 0 AND minutes <= 24*60),
  otype text NOT NULL DEFAULT 'community' CHECK (otype IN ('community','bank')),
  org_name text,
  details text,
  guests int NOT NULL DEFAULT 0,
  check_in timestamptz,
  check_out timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by int REFERENCES employees(id),
  decided_at timestamptz,
  decision_note text,
  created_by int REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hours_emp_idx ON hours(employee_id);
CREATE INDEX IF NOT EXISTS hours_date_idx ON hours(date);

-- A kiosk session: a Culture Committee member or admin opens check-in for one opportunity on an iPad.
CREATE TABLE IF NOT EXISTS kiosks (
  token_hash text PRIMARY KEY,
  opp_id int NOT NULL REFERENCES opportunities(id),
  opened_by int NOT NULL REFERENCES employees(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz
);

-- Open kiosk check-ins (checked in, not yet out)
CREATE TABLE IF NOT EXISTS checkins (
  id serial PRIMARY KEY,
  opp_id int NOT NULL REFERENCES opportunities(id),
  employee_id int NOT NULL REFERENCES employees(id),
  guests int NOT NULL DEFAULT 0,
  check_in timestamptz NOT NULL DEFAULT now(),
  UNIQUE (opp_id, employee_id)
);
