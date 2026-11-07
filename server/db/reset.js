// Deletes ALL data and recreates the tables. Asks for confirmation unless --yes is passed.
require('../src/env');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');
const { makePool, directUrl } = require('../src/db');
const { migrate } = require('./migrate');

(async () => {
  if (!process.argv.includes('--yes')) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = await new Promise(r => rl.question('This deletes every SafeRoute account and trip. Type "reset" to continue: ', r));
    rl.close();
    if (a.trim() !== 'reset') { console.log('Cancelled.'); return; }
  }
  const db = makePool(directUrl());
  await db.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  await db.query('DROP TABLE IF EXISTS schema_migrations');
  await migrate(db);
  await db.end();
  console.log('Tables recreated.');
  execFileSync(process.execPath, [path.join(__dirname, 'seed.js')], { stdio: 'inherit' });
})().catch(err => { console.error(err.message); process.exit(1); });
