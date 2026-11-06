const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { pool, tx, audit } = require('../db');
const { signToken, requireAuth } = require('../auth');

const router = express.Router();
// Compared against when an email is unknown, so response time doesn't reveal which emails have accounts.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

const Register = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(10, 'Use at least 10 characters for your password').max(200),
  name: z.string().trim().min(2).max(80),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number').optional(),
  role: z.enum(['passenger', 'driver']).default('passenger'),
  vehicle: z.string().trim().min(3).max(60).optional(),
  plate: z.string().trim().toUpperCase().regex(/^[A-Z]{1,3} ?[0-9]{1,5}$/, 'Enter a plate like H 4421').optional(),
});

async function me(id, db = pool) {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.name, u.phone, u.role, d.vehicle, d.plate, d.verified, d.rating
       FROM users u LEFT JOIN drivers d ON d.user_id = u.id WHERE u.id = $1`, [id]);
  const u = rows[0];
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role,
    driver: u.role === 'driver' ? { vehicle: u.vehicle, plate: u.plate, verified: u.verified, rating: u.rating } : undefined };
}

router.post('/register', async (req, res) => {
  const b = Register.parse(req.body);
  if (b.role === 'driver' && (!b.vehicle || !b.plate)) return res.status(400).json({ error: 'Drivers need a vehicle and plate number' });
  const hash = await bcrypt.hash(b.password, 12);
  try {
    const user = await tx(async db => {
      const { rows: [u] } = await db.query(
        `INSERT INTO users (email, password_hash, name, phone, role) VALUES ($1,$2,$3,$4,$5) RETURNING id, role`,
        [b.email, hash, b.name, b.phone || null, b.role]);
      if (b.role === 'driver') {
        // Real drivers are checked by an admin first. DEMO_MODE verifies them straight away.
        await db.query('INSERT INTO drivers (user_id, vehicle, plate, verified) VALUES ($1,$2,$3,$4)',
          [u.id, b.vehicle, b.plate.replace(/^([A-Z]+) ?/, '$1 '), process.env.DEMO_MODE === 'true']);
      }
      await audit(db, u.id, 'auth.register', u.id, { role: b.role });
      return u;
    });
    res.status(201).json({ token: signToken(user), user: await me(user.id) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An account with that email already exists' });
    throw err;
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = z.object({ email: z.string().trim().toLowerCase(), password: z.string() }).parse(req.body);
  const { rows } = await pool.query('SELECT id, role, password_hash FROM users WHERE email = $1', [email]);
  const ok = await bcrypt.compare(password, rows[0]?.password_hash || DUMMY_HASH);
  if (!rows[0] || !ok) {
    await audit(pool, null, 'auth.login_failed', null, { email });
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  await audit(pool, rows[0].id, 'auth.login', rows[0].id);
  res.json({ token: signToken(rows[0]), user: await me(rows[0].id) });
});

router.get('/me', requireAuth, async (req, res) => res.json(await me(req.user.id)));

module.exports = router;
module.exports.me = me;
