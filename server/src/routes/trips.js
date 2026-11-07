const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const { pool, tx, audit } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { planRouteVia, routeLength, inSVG, haversine, sameDirection } = require('../services/geo');
const pricing = require('../services/pricing');
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

const Options = z.object({
  partySize: z.number().int().min(1).max(14).default(1),
  openRoute: z.boolean().default(true),
  vehicleType: z.enum(['car', 'suv', 'van']).default('car'),
});
const MAX_STOPS = 3;
const randomPin = () => String(crypto.randomInt(1000, 10000));
const pt = p => [p.lat, p.lng];
/** Planned road route: pickup → any stops → drop-off. */
const routeFor = (pickup, stops, dest) => planRouteVia([pt(pickup), ...stops.map(pt), pt(dest)]);
function checkPlaces(res, places) {
  if (places.some(p => !inSVG(p.lat, p.lng))) { err(res, 400, 'SafeRoute only works in St. Vincent and the Grenadines for now'); return false; }
  return true;
}
function checkSeats(res, o) {
  const seats = pricing.seatsFor(o.vehicleType);
  if (o.partySize > seats) { err(res, 400, `A ${pricing.VEHICLES[o.vehicleType].label.toLowerCase()} seats up to ${seats}. Choose a bigger vehicle.`); return false; }
  return true;
}
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

// What a ride will cost, before booking: on its own, and if someone shares it.
router.post('/fare/quote', async (req, res) => {
  const { pickup, dest, ...rest } = z.object({ pickup: Place, dest: Place }).merge(Options).parse(req.body);
  if (!checkPlaces(res, [pickup, dest]) || !checkSeats(res, rest)) return;
  const route = await routeFor(pickup, [], dest);
  const routeM = Math.round(routeLength(route));
  res.json({
    routeKm: Math.round(routeM / 100) / 10,
    alone: pricing.price({ routeM, partySize: rest.partySize, openRoute: rest.openRoute }),
    shared: rest.openRoute ? pricing.price({ routeM, partySize: rest.partySize, shared: true }) : null,
    seats: pricing.seatsFor(rest.vehicleType),
  });
});

router.post('/trips', requireRole('passenger'), async (req, res) => {
  const { pickup, dest, ...opts } = z.object({ pickup: Place, dest: Place }).merge(Options).parse(req.body);
  if (!checkPlaces(res, [pickup, dest]) || !checkSeats(res, opts)) return;
  if (haversine(pt(pickup), pt(dest)) < 200) return err(res, 400, 'Your destination is too close to your pickup');
  const route = await routeFor(pickup, [], dest);
  const metres = Math.round(routeLength(route));
  const q = pricing.price({ routeM: metres, partySize: opts.partySize, openRoute: opts.openRoute });
  try {
    const { rows: [t] } = await pool.query(
      `INSERT INTO trips (passenger_id, pickup_lat, pickup_lng, pickup_name, dest_lat, dest_lng, dest_name, route, route_m,
                          fare_xcd, base_xcd, fare_breakdown, pin, party_size, open_route, vehicle_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [req.user.id, pickup.lat, pickup.lng, pickup.name, dest.lat, dest.lng, dest.name, JSON.stringify(route), metres,
       q.total, q.base, JSON.stringify(q.lines), randomPin(), opts.partySize, opts.openRoute, opts.vehicleType]);
    await audit(pool, req.user.id, 'trip.request', t.id, { dest: dest.name, partySize: opts.partySize, openRoute: opts.openRoute, vehicleType: opts.vehicleType });
    live.requestsChanged();
    res.status(201).json(await viewFor(req, t.id));
  } catch (e) {
    if (e.code === '23505') return err(res, 409, 'You already have a trip in progress');
    throw e;
  }
});

// Passenger adds a stop on the way (before the drop-off).
router.post('/trips/:id/stops', requireRole('passenger'), async (req, res) => {
  const stop = Place.parse(req.body);
  const t = await mine(req, res);
  if (!t) return;
  if (!T.ACTIVE.includes(t.status)) return err(res, 409, 'This trip has ended');
  if ((t.stops || []).length >= MAX_STOPS) return err(res, 400, `You can add up to ${MAX_STOPS} stops`);
  if (!checkPlaces(res, [stop])) return;
  const stops = [...(t.stops || []), stop];
  await replan(t, stops, { lat: t.dest_lat, lng: t.dest_lng, name: t.dest_name });
  await audit(pool, req.user.id, 'trip.stop_add', t.id, { stop: stop.name });
  await live.tripChanged(t.id);
  res.json(await viewFor(req, t.id));
});

// Passenger changes where they get off: earlier ("drop me here") or further.
router.post('/trips/:id/destination', requireRole('passenger'), async (req, res) => {
  const dest = Place.parse(req.body);
  const t = await mine(req, res);
  if (!t) return;
  if (!T.ACTIVE.includes(t.status)) return err(res, 409, 'This trip has ended');
  if (!checkPlaces(res, [dest])) return;
  if (haversine([t.pickup_lat, t.pickup_lng], pt(dest)) < 200) return err(res, 400, 'That is too close to your pickup');
  await replan(t, t.stops || [], dest, true);
  await audit(pool, req.user.id, 'trip.dest_change', t.id, { from: t.dest_name, to: dest.name });
  await live.tripChanged(t.id);
  res.json(await viewFor(req, t.id));
});

/** New planned route and fare after a stop or drop-off change. Driver detours never reach this. */
async function replan(t, stops, dest, destChanged = false) {
  const route = await routeFor({ lat: t.pickup_lat, lng: t.pickup_lng }, stops, dest);
  await pool.query(
    `UPDATE trips SET stops = $2, dest_lat = $3, dest_lng = $4, dest_name = $5, route = $6, route_m = $7,
                      dest_changes = dest_changes + $8, off_route_since = NULL WHERE id = $1`,
    [t.id, JSON.stringify(stops), dest.lat, dest.lng, dest.name, JSON.stringify(route), Math.round(routeLength(route)), destChanged ? 1 : 0]);
  await T.reprice(pool, t.id);
}

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

/** The driver's vehicle and the bookings currently in (or heading to) their car. */
async function driverState(db, driverId) {
  const { rows: [d] } = await db.query('SELECT vehicle_type, seats, verified FROM drivers WHERE user_id = $1', [driverId]);
  const { rows: active } = await db.query(
    `SELECT id, group_id, party_size, open_route, route, status FROM trips
      WHERE driver_id = $1 AND status IN ('accepted', 'arrived', 'in_progress') ORDER BY accepted_at`, [driverId]);
  const used = active.reduce((n, t) => n + t.party_size, 0);
  return { vehicleType: d.vehicle_type, seats: d.seats, active, free: d.seats - used,
    canShare: active.length > 0 && active.every(t => t.open_route) };
}

/** Can this request join the car? Same direction as a booking already in it, seats free, both open route. */
function fits(state, r) {
  if (!pricing.canServe(state.vehicleType, r.vehicle_type) || r.party_size > state.free) return false;
  if (!state.active.length) return true;
  if (!state.canShare || !r.open_route) return false;
  return state.active.some(t => sameDirection(t.route, [r.pickup_lat, r.pickup_lng], [r.dest_lat, r.dest_lng]));
}

router.get('/trips/open', requireRole('driver'), async (req, res) => {
  if (!(await requireVerifiedDriver(req, res))) return;
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  const state = await driverState(pool, req.user.id);
  const { rows } = await pool.query(
    `SELECT t.id, t.pickup_name, t.pickup_lat, t.pickup_lng, t.dest_name, t.dest_lat, t.dest_lng, t.fare_xcd, t.route_m,
            t.requested_at, t.party_size, t.open_route, t.vehicle_type, u.name
       FROM trips t JOIN users u ON u.id = t.passenger_id
      WHERE t.status = 'requested' AND t.requested_at > now() - interval '30 minutes'
      ORDER BY t.requested_at LIMIT 50`);
  res.json({
    seatsFree: state.free,
    seats: state.seats,
    sharing: state.active.length > 0,
    requests: rows.filter(r => fits(state, r)).slice(0, 20).map(r => ({
      id: r.id, passengerName: r.name.split(' ')[0], pickupName: r.pickup_name, destName: r.dest_name,
      fareXcd: r.fare_xcd, km: Math.round(r.route_m / 100) / 10, requestedAt: r.requested_at,
      partySize: r.party_size, openRoute: r.open_route, vehicleType: r.vehicle_type,
      onYourRoute: state.active.length > 0,
      // Distance only: drivers don't see a passenger's exact location until they accept.
      awayKm: Number.isFinite(lat) && Number.isFinite(lng) ? Math.round(haversine([lat, lng], [r.pickup_lat, r.pickup_lng]) / 100) / 10 : null,
    })),
  });
});

// All the bookings in the driver's car right now (several in a shared ride).
router.get('/driver/trips', requireRole('driver'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id FROM trips WHERE driver_id = $1 AND status IN ('accepted', 'arrived', 'in_progress') ORDER BY accepted_at`, [req.user.id]);
  const out = [];
  for (const r of rows) out.push(await viewFor(req, r.id));
  res.json(out);
});

router.post('/trips/:id/accept', requireRole('driver'), async (req, res) => {
  if (!(await requireVerifiedDriver(req, res))) return;
  let result;
  try {
    result = await tx(async db => {
      // Lock the driver's current bookings so two accepts can't overfill the car.
      await db.query(`SELECT id FROM trips WHERE driver_id = $1 AND status IN ('accepted','arrived','in_progress') FOR UPDATE`, [req.user.id]);
      const state = await driverState(db, req.user.id);
      const { rows: [r] } = await db.query(`SELECT * FROM trips WHERE id = $1 AND status = 'requested' FOR UPDATE`, [req.params.id]);
      if (!r) return { code: 409, error: 'Another driver already took this ride, or it was cancelled' };
      if (!fits(state, r)) return { code: 409, error: state.active.length ? "This ride doesn't fit your car right now (direction, seats or a private ride)" : "Your vehicle can't take this booking" };
      const groupId = state.active.length ? (state.active[0].group_id || state.active[0].id) : r.id;
      if (state.active.length) await db.query('UPDATE trips SET group_id = $2 WHERE id = ANY($1::uuid[]) AND group_id IS NULL', [state.active.map(t => t.id), groupId]);
      await db.query(`UPDATE trips SET driver_id = $2, status = 'accepted', accepted_at = now(), group_id = $3 WHERE id = $1`, [r.id, req.user.id, groupId]);
      return { code: 200, others: state.active.map(t => t.id), joined: state.active.length > 0 };
    });
  } catch (e) {
    if (e.code === '22P02') return err(res, 404, 'Trip not found');
    throw e;
  }
  if (result.code !== 200) return err(res, result.code, result.error);
  await audit(pool, req.user.id, 'trip.accept', req.params.id, { joinedSharedRide: result.joined });
  live.requestsChanged();
  await live.tripChanged(req.params.id);
  for (const id of result.others) await live.tripChanged(id);
  res.json(await viewFor(req, req.params.id));
});

/** Stores a driver position for every booking in their car and checks route alerts. */
async function recordFix(driverId, fix, onlyTripId) {
  const { rows } = await pool.query(
    `SELECT * FROM trips WHERE driver_id = $1 AND status IN ('accepted','arrived','in_progress')`, [driverId]);
  const trips = onlyTripId ? rows.filter(t => t.id === onlyTripId) : rows;
  if (!trips.length) return { stored: false, active: false };
  // At most one stored point every 2 seconds.
  const recent = trips.some(t => t.last_at && Date.now() - new Date(t.last_at).getTime() < 2000);
  if (recent) return { stored: false, active: true };
  const p = [fix.lat, fix.lng];
  let alert = null;
  for (const t of trips) {
    await pool.query(`UPDATE trips SET last_lat = $2, last_lng = $3, last_speed_kmh = $4, last_at = now() WHERE id = $1`, [t.id, fix.lat, fix.lng, fix.speedKmh ?? null]);
    await pool.query(`INSERT INTO trip_points (trip_id, lat, lng, speed_kmh, accuracy_m) VALUES ($1,$2,$3,$4,$5)`, [t.id, fix.lat, fix.lng, fix.speedKmh ?? null, fix.accuracyM ?? null]);
    alert = (await T.checkAlerts(pool, t, p)) || alert;
  }
  for (const t of trips) await live.tripChanged(t.id);
  return { stored: true, active: true, alert: alert ? alert.kind : null };
}

router.post('/driver/location', requireRole('driver'), async (req, res) => {
  const r = await recordFix(req.user.id, Fix.parse(req.body));
  if (!r.active) return err(res, 409, 'You have no active trip');
  res.status(r.stored ? 200 : 202).json(r);
});

router.post('/trips/:id/location', requireRole('driver'), async (req, res) => {
  const fix = Fix.parse(req.body);
  const t = await mine(req, res);
  if (!t) return;
  if (!T.LIVE.includes(t.status)) return err(res, 409, 'This trip is not active');
  const r = await recordFix(req.user.id, fix);
  res.status(r.stored ? 200 : 202).json(r);
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
    // Two different bookings riding together at the same time = a shared ride: everyone in it pays the shared fare.
    let sharedWith = [];
    if (t.group_id) {
      const { rows } = await db.query(`SELECT id FROM trips WHERE group_id = $1 AND id <> $2 AND status = 'in_progress'`, [t.group_id, t.id]);
      sharedWith = rows.map(r => r.id);
      if (sharedWith.length) {
        await db.query('UPDATE trips SET shared = true WHERE id = ANY($1::uuid[])', [[t.id, ...sharedWith]]);
        for (const id of [t.id, ...sharedWith]) await T.reprice(db, id);
      }
    }
    await audit(db, req.user.id, 'trip.start', t.id, { shared: sharedWith.length > 0 });
    return { code: 200, sharedWith };
  });
  await live.tripChanged(req.params.id);
  for (const id of result.sharedWith || []) await live.tripChanged(id);
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
