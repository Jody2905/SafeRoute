const { Pool, types } = require('pg');

// Return DATE columns as 'YYYY-MM-DD' strings instead of JS Dates (avoids timezone shifts).
types.setTypeParser(1082, v => v);
// Return NUMERIC (fares, ratings) as numbers.
types.setTypeParser(1700, v => Number(v));

// Neon gives two connection strings:
//   DATABASE_URL           pooled (host contains "-pooler") -> used by the running app
//   DATABASE_URL_UNPOOLED  direct                            -> used for schema changes (db:reset)
// If only the pooled one is set, the direct one is derived by dropping "-pooler" from the host.
function directUrl() {
  if (process.env.DATABASE_URL_UNPOOLED) return process.env.DATABASE_URL_UNPOOLED;
  return (process.env.DATABASE_URL || '').replace('-pooler.', '.');
}

function makePool(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is not set. Add your Neon connection string to server/.env');
  const p = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,        // let Neon scale to zero when idle
    connectionTimeoutMillis: 15_000,  // a suspended Neon compute takes a moment to wake
  });
  // Neon closes idle connections when it suspends; without this handler that would crash Node.
  p.on('error', err => console.error('Idle database connection closed:', err.message));
  return p;
}

const pool = makePool(process.env.DATABASE_URL);

// Run several queries in one transaction.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function audit(db, actorId, action, targetId, meta = {}) {
  await db.query(
    'INSERT INTO audit_log (actor_id, action, target_id, meta) VALUES ($1, $2, $3, $4)',
    [actorId, action, targetId == null ? null : String(targetId), meta]
  );
}

module.exports = { pool, tx, audit, makePool, directUrl };
