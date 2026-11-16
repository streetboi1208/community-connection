'use strict';
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

async function migrate() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  await pool.query(`INSERT INTO markets (name) VALUES ('Permian Basin'),('Lubbock'),('Dallas') ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO settings (key, value) VALUES ('impact_rate', '30') ON CONFLICT DO NOTHING`);
}

if (require.main === module) {
  migrate().then(() => { console.log('Database is ready.'); return pool.end(); })
    .catch(e => { console.error(e); process.exit(1); });
}
module.exports = { migrate };
