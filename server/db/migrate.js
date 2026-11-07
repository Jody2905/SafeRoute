// Applies db/migrations/*.sql in order, once each. Safe to run on every start.
const fs = require('fs');
const path = require('path');

async function migrate(db) {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const { rows } = await db.query('SELECT name FROM schema_migrations');
  const done = new Set(rows.map(r => r.name));
  const applied = [];
  for (const f of files) {
    if (done.has(f)) continue;
    await db.query('BEGIN');
    try {
      await db.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await db.query('COMMIT');
      applied.push(f);
    } catch (e) {
      await db.query('ROLLBACK');
      throw new Error(`Migration ${f} failed: ${e.message}`);
    }
  }
  return applied;
}

module.exports = { migrate };
