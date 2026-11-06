const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const { pool, tx, audit } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { planRoute, routeLength, fareFor, inSVG, haversine } = require('../services/geo');
const T = require('../services/trips');
const live = require('../services/realtime');

const router = express.Router();
router.use(requireAuth);

const Place = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  name: z.string().trim().min(1).max(80),
});
const Fix = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  speedKmh: z.number().min(0).max(250).nullable().optional(),
  accuracyM: z.number().min(0).max(10000).nullable().optional(),
});

const randomPin = () => String(crypto.randomInt(1000, 10000));
const err = (res, code, error) => res.status(code).json({ error });

/** Loads a trip and checks the signed-in user is its passenger or driver. */
async function mine(req, res, db = pool) {
  const t = await T.loadTrip(db, req.params.id);
  if (!t || (t.passenger_id !== req.user.id && t.driver_id !== req.user.id)) { err(res, 404, 'Trip not found'); return null; }
  return t;
}
async function viewFor(req, id) {
  const v = await T.views(id);
  return req.user.id === v.driverId ? v.driver : v.passenger;
}
async function requireVerifiedDriver(req, res) {
  const { rows } = await pool.query('SELECT verified FROM drivers WHERE user_id = $1', [req.user.id]);
  if (!rows[0] || !rows[0].verified) { err(res, 403, 'Your driver account is waiting for verification'); return false; }
  return true;
}

// ---------- passenger ----------

router.post('/trips', requireRole('passenger'), async (req, res) => {
  const { pickup, dest } = z.object({ pickup: Place, dest: Place }).parse(req.body);
  if (!inSVG(pickup.lat, pickup.lng) || !inSVG(dest.lat, dest.lng))
    return err(res, 400, 'SafeRoute only works in St. Vincent and the Grenadines for now');
  if (haversine([pickup.lat, pickup.lng], [dest.lat, dest.lng]) < 200) return err(res, 400, 'Your destination is too close to your pickup');
  const route = await planRoute([pickup.lat, pickup.lng], [dest.lat, dest.lng]);
  const metres = Math.round(routeLength(route));
  try {
    const { rows: [t] } = await pool.query(
      `INSERT INTO trips (passenger_id, pickup_lat, pickup_lng, pickup_name, dest_lat, dest_lng, dest_name, route, route_m, fare_xcd, pin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [req.user.id, pickup.lat, pickup.lng, pickup.name, dest.lat, dest.lng, dest.name, JSON.stringify(route), metres, fareFor(metres), randomPin()]);
    await audit(pool, req.user.id, 'trip.request', t.id, { dest: dest.name });
    live.requestsChanged();
    res.status(201).json(await viewFor(req, t.id));
  } catch (e) {
    if (e.code === '23505') return err(res, 409, 'You already have a trip in progress');
    throw e;
  }
});

router.get('/trips/current', async (req, res) => {
  const id = await T.activeTripId(req.user);
  res.json(id ? await viewFor(req, id) : null);
});

router.get('/trips/history', async (req, res) => {
  const col = req.user.role === 'driver' ? 'driver_id' : 'passenger_id';
  const { rows } = await pool.query(
    `SELECT id, status, pickup_name, dest_name, fare_xcd, route_m, requested_at, completed_at
       FROM trips WHERE ${col} = $1 ORDER BY requested_at DESC LIMIT 30`, [req.user.id]);
  res.json(rows.map(r => ({ id: r.id, status: r.status, pickupName: r.pickup_name, destName: r.dest_name,
    fareXcd: r.fare_xcd, km: Math.round(r.route_m / 100) / 10, requestedAt: r.requested_at, completedAt: r.completed_at })));
});

// ---------- driver ----------

router.get('/trips/open', requireRole('driver'), async (req, res) => {
  if (!(await requireVerifiedDriver(req, res))) return;
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  const { rows } = await pool.query(
    `SELECT t.id, t.pickup_name, t.pickup_lat, t.pickup_lng, t.dest_name, t.fare_xcd, t.route_m, t.requested_at, u.name
       FROM trips t JOIN users u ON u.id = t.passenger_id
      WHERE t.status = 'requested' AND t.requested_at > now() - interval '30 minutes'
      ORDER BY t.requested_at LIMIT 20`);
  res.json(rows.map(r => ({
    id: r.id, passengerName: r.name.split(' ')[0], pickupName: r.pickup_name, destName: r.dest_name,
    fareXcd: r.fare_xcd, km: Math.round(r.route_m / 100) / 10, requestedAt: r.requested_at,
    // Distance only: drivers don't see a passenger's exact location until they accept.
    awayKm: Number.isFinite(lat) && Number.isFinite(lng) ? Math.round(haversine([lat, lng], [r.pickup_lat, r.pickup_lng]) / 100) / 10 : null,
  })));
});

router.post('/trips/:id/accept', requireRole('driver'), async (req, res) => {
  if (!(await requireVerifiedDriver(req, res))) return;
  try {
    const { rows } = await pool.query(
      `UPDATE trips SET driver_id = $2, status = 'accepted', accepted_at = now()
        WHERE id = $1 AND status = 'requested' RETURNING id`, [req.params.id, req.user.id]);
    if (!rows[0]) return err(res, 409, 'Another driver already took this ride, or it was cancelled');
  } catch (e) {
    if (e.code === '23505') return err(res, 409, 'Finish your current trip first');
    if (e.code === '22P02') return err(res, 404, 'Trip not found');
    throw e;
  }
  await audit(pool, req.user.id, 'trip.accept', req.params.id);
  live.requestsChanged();
  await live.tripChanged(req.params.id);
  res.json(await viewFor(req, req.params.id));
});

router.post('/trips/:id/location', requireRole('driver'), async (req, res) => {
  const fix = Fix.parse(req.body);
  const t = await mine(req, res);
  if (!t) return;
  if (!T.LIVE.includes(t.status)) return err(res, 409, 'This trip is not active');
  // At most one stored point every 2 seconds.
  if (t.last_at && Date.now() - new Date(t.last_at).getTime() < 2000) return res.status(202).json({ stored: false });
  const p = [fix.lat, fix.lng];
  await pool.query(
    `UPDATE trips SET last_lat = $2, last_lng = $3, last_speed_kmh = $4, last_at = now() WHERE id = $1`,
    [t.id, fix.lat, fix.lng, fix.speedKmh ?? null]);
  await pool.query(`INSERT INTO trip_points (trip_id, lat, lng, speed_kmh, accuracy_m) VALUES ($1,$2,$3,$4,$5)`,
    [t.id, fix.lat, fix.lng, fix.speedKmh ?? null, fix.accuracyM ?? null]);
  const alert = await T.checkAlerts(pool, t, p);
  await live.tripChanged(t.id);
  res.json({ stored: true, alert: alert ? alert.kind : null });
});

router.post('/trips/:id/arrived', requireRole('driver'), async (req, res) => {
  const t = await mine(req, res);
  if (!t) return;
  if (t.status !== 'accepted') return err(res, 409, 'You can only arrive after accepting the ride');
  await pool.query(`UPDATE trips SET status = 'arrived', arrived_at = now() WHERE id = $1`, [t.id]);
  await audit(pool, req.user.id, 'trip.arrived', t.id);
  await live.tripChanged(t.id);
  res.json(await viewFor(req, t.id));
});

router.post('/trips/:id/start', requireRole('driver'), async (req, res) => {
  const { pin } = z.object({ pin: z.string().regex(/^\d{4}$/, 'The PIN is 4 digits') }).parse(req.body);
  const result = await tx(async db => {
    const { rows: [t] } = await db.query('SELECT * FROM trips WHERE id = $1 AND driver_id = $2 FOR UPDATE', [req.params.id, req.user.id]);
    if (!t) return { code: 404, body: { error: 'Trip not found' } };
    if (t.status !== 'arrived') return { code: 409, body: { error: 'Tap "I\'ve arrived" first' } };
    if (t.pin_attempts >= 3) return { code: 423, body: { error: 'Too many wrong PINs. This trip can\'t start. The passenger has been warned.' } };
    const ok = t.pin && crypto.timingSafeEqual(Buffer.from(t.pin), Buffer.from(pin));
    if (!ok) {
      const tries = t.pin_attempts + 1;
      await db.query('UPDATE trips SET pin_attempts = $2 WHERE id = $1', [t.id, tries]);
      await audit(db, req.user.id, 'trip.pin_wrong', t.id, { tries });
      return { code: 400, body: { error: tries >= 3 ? 'Wrong PIN 3 times. This trip is blocked and the passenger has been warned.' : `That PIN doesn't match. ${3 - tries} ${3 - tries === 1 ? 'try' : 'tries'} left.`, attemptsLeft: 3 - tries } };
    }
    // The PIN is never needed again, so it is cleared.
    await db.query(`UPDATE trips SET status = 'in_progress', started_at = now(), pin = NULL WHERE id = $1`, [t.id]);
    await audit(db, req.user.id, 'trip.start', t.id);
    return { code: 200 };
  });
  await live.tripChanged(req.params.id);
  if (result.code !== 200) return res.status(result.code).json(result.body);
  res.json(await viewFor(req, req.params.id));
});

router.post('/trips/:id/complete', requireRole('driver'), async (req, res) => {
  const t = await mine(req, res);
  if (!t) return;
  if (t.status !== 'in_progress') return err(res, 409, 'This trip has not started');
  await pool.query(`UPDATE trips SET status = 'completed', completed_at = now() WHERE id = $1`, [t.id]);
  await pool.query(`UPDATE alerts SET status = 'ok', resolved_at = now() WHERE trip_id = $1 AND status = 'open'`, [t.id]);
  await audit(pool, req.user.id, 'trip.complete', t.id);
  await live.tripChanged(t.id);
  res.json(await viewFor(req, t.id));
});

// ---------- either side ----------

router.post('/trips/:id/cancel', async (req, res) => {
  const t = await mine(req, res);
  if (!t) return;
  const allowed = req.user.id === t.passenger_id ? ['requested', 'accepted', 'arrived'] : ['accepted', 'arrived'];
  if (!allowed.includes(t.status)) return err(res, 409, t.status === 'in_progress' ? 'A trip in progress can only be ended by the driver, or use SOS' : 'This trip can\'t be cancelled now');
  await pool.query(`UPDATE trips SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [t.id]);
  await audit(pool, req.user.id, 'trip.cancel', t.id, { by: req.user.role, from: t.status });
  live.requestsChanged();
  await live.tripChanged(t.id);
  res.json(await viewFor(req, t.id));
});

router.get('/trips/:id', async (req, res) => {
  if (!(await mine(req, res))) return;
  res.json(await viewFor(req, req.params.id));
});

// ---------- safety ----------

router.post('/trips/:id/share', requireRole('passenger'), async (req, res) => {
  const t = await mine(req, res);
  if (!t) return;
  if (!T.ACTIVE.includes(t.status)) return err(res, 409, 'You can only share a trip that is happening');
  const token = crypto.randomBytes(24).toString('base64url');
  await pool.query('UPDATE trips SET share_token_hash = $2 WHERE id = $1', [t.id, T.hashToken(token)]);
  await audit(pool, req.user.id, 'trip.share', t.id);
  res.json({ token }); // shown once; only its hash is stored
});

router.delete('/trips/:id/share', requireRole('passenger'), async (req, res) => {
  const t = await mine(req, res);
  if (!t) return;
  await pool.query('UPDATE trips SET share_token_hash = NULL WHERE id = $1', [t.id]);
  await audit(pool, req.user.id, 'trip.share_stop', t.id);
  res.json({ ok: true });
});

router.post('/trips/:id/sos', requireRole('passenger'), async (req, res) => {
  const t = await mine(req, res);
  if (!t) return;
  const { rows: [a] } = await pool.query(
    `INSERT INTO alerts (trip_id, kind, status, resolved_at, details) VALUES ($1, 'sos', 'escalated', now(), $2) RETURNING id`,
    [t.id, { position: t.last_lat != null ? [t.last_lat, t.last_lng] : null }]);
  await audit(pool, req.user.id, 'alert.sos', t.id, { alertId: a.id });
  await live.tripChanged(t.id);
  res.status(201).json({ id: a.id, status: 'escalated' });
});

router.post('/alerts/:id/respond', requireRole('passenger'), async (req, res) => {
  const { ok } = z.object({ ok: z.boolean() }).parse(req.body);
  const { rows: [a] } = await pool.query(
    `UPDATE alerts a SET status = $2::alert_status, resolved_at = now()
       FROM trips t
      WHERE a.id = $1 AND a.trip_id = t.id AND t.passenger_id = $3 AND a.status = 'open'
      RETURNING a.id, a.trip_id, a.status`, [Number(req.params.id) || 0, ok ? 'ok' : 'escalated', req.user.id]);
  if (!a) return err(res, 404, 'Alert not found or already answered');
  await audit(pool, req.user.id, ok ? 'alert.ok' : 'alert.help', a.trip_id, { alertId: a.id });
  await live.tripChanged(a.trip_id);
  res.json({ id: a.id, status: a.status });
});

module.exports = router;
