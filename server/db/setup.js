// First-run setup for a hosted deploy (Render). Safe to run on every start:
// creates the tables and sample accounts only if the database is empty, and never drops anything.
require('../src/env');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pool, makePool, directUrl } = require('../src/db');

(async () => {
  const direct = makePool(directUrl());
  let created = false;
  try {
    const { rows: [r] } = await direct.query("SELECT to_regclass('public.trips') AS t");
    if (r.t) console.log('Database already set up.');
    else {
      await direct.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
      console.log('Database schema created.');
      created = true;
    }
  } finally {
    await direct.end();
    await pool.end();
  }
  if (created && process.env.SEED_DEMO_DATA !== 'false') execFileSync(process.execPath, [path.join(__dirname, 'seed.js')], { stdio: 'inherit' });
})().catch(err => { console.error(err.message); process.exit(1); });
