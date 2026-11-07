// Adds sample accounts so the live site can be tried straight away. All people are fictional.
require('../src/env');
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');

const PASSWORD = process.env.DEMO_PASSWORD || 'saferoute-demo';

(async () => {
  const hash = await bcrypt.hash(PASSWORD, 12);
  const add = async (email, name, phone, role) => (await pool.query(
    `INSERT INTO users (email, password_hash, name, phone, role) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [email, hash, name, phone, role])).rows[0].id;

  const rhea = await add('passenger@example.com', 'Rhea Samuel', '+1 784 555 0142', 'passenger');
  await add('passenger2@example.com', 'Kemar Daniel', '+1 784 555 0177', 'passenger');
  const marcus = await add('driver@example.com', 'Marcus Thomas', '+1 784 555 0190', 'driver');
  const sandra = await add('driver2@example.com', 'Sandra Mills', '+1 784 555 0133', 'driver');
  const devon = await add('driver3@example.com', 'Devon Hackshaw', '+1 784 555 0166', 'driver');
  for (const [id, vehicle, plate, rating, type, seats] of [
    [marcus, 'Silver Toyota Corolla', 'H 4421', 4.9, 'car', 4],
    [sandra, 'White Nissan Note', 'H 3312', 4.8, 'car', 4],
    [devon, 'Blue Toyota Hiace', 'H 2210', 4.7, 'van', 14],
  ]) {
    await pool.query(`INSERT INTO drivers (user_id, vehicle, plate, verified, rating, vehicle_type, seats) VALUES ($1,$2,$3,true,$4,$5,$6)
                      ON CONFLICT (user_id) DO NOTHING`, [id, vehicle, plate, rating, type, seats]);
  }
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM trusted_contacts WHERE user_id = $1', [rhea]);
  if (!n) {
    await pool.query(`INSERT INTO trusted_contacts (user_id, name, phone, relation) VALUES
      ($1, 'Mom', '+1 784 555 0101', 'Family'), ($1, 'Tasha', '+1 784 555 0188', 'Friend')`, [rhea]);
  }
  console.log(`Seeded. Passengers: passenger@example.com, passenger2@example.com. Drivers: driver@example.com, driver2@example.com, driver3@example.com (van). Password: "${PASSWORD}"`);
  await pool.end();
})().catch(err => { console.error(err.message); process.exit(1); });
