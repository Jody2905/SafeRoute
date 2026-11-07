// Trip loading, the three views of a trip (passenger / driver / share link), and route alerts.
const crypto = require('crypto');
const { pool, audit } = require('../db');
const { haversine, distanceToRoute, routeLength } = require('./geo');
const pricing = require('./pricing');

const ACTIVE = ['requested', 'accepted', 'arrived', 'in_progress'];
const LIVE = ['accepted', 'arrived', 'in_progress']; // a driver is on the way or driving

// Alert thresholds.
const OFF_ROUTE_M = 150;      // taxi more than 150 m from the planned route…
const OFF_ROUTE_S = 20;       // …for more than 20 seconds
const STOP_RADIUS_M = 30;     // taxi stays within 30 m…
const STOP_S = Number(process.env.LONG_STOP_SECONDS) || 180; // …for over 3 minutes
const ANSWER_S = Number(process.env.ALERT_ANSWER_SECONDS) || 60; // passenger has 60 s to answer

const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const firstName = n => String(n || '').split(' ')[0];

async function loadTrip(db, id) {
  const { rows } = await db.query(
    `SELECT t.*, p.name AS passenger_name, d.name AS driver_name, dr.vehicle, dr.plate, dr.rating,
            dr.vehicle_type AS driver_vehicle_type, dr.seats AS driver_seats,
            (SELECT count(*)::int FROM trips g WHERE g.group_id = t.group_id AND g.id <> t.id
               AND g.status IN ('accepted', 'arrived', 'in_progress')) AS others_in_car
       FROM trips t
       JOIN users p ON p.id = t.passenger_id
  LEFT JOIN users d ON d.id = t.driver_id
  LEFT JOIN drivers dr ON dr.user_id = t.driver_id
      WHERE t.id = $1`, [id]);
  return rows[0] || null;
}

async function openAlerts(db, tripId) {
  const { rows } = await db.query(
    `SELECT id, kind, status, created_at FROM alerts WHERE trip_id = $1 AND status = 'open' ORDER BY id`, [tripId]);
  return rows.map(a => ({ id: a.id, kind: a.kind, status: a.status, createdAt: a.created_at,
    answerBy: new Date(new Date(a.created_at).getTime() + ANSWER_S * 1000) }));
}

/** Builds what each audience may see. Share viewers never get the PIN or exact pickup coordinates. */
async function views(tripId, db = pool) {
  const t = await loadTrip(db, tripId);
  if (!t) return null;
  const alerts = await openAlerts(db, tripId);
  const live = LIVE.includes(t.status);
  const base = {
    id: t.id,
    status: t.status,
    pickupName: t.pickup_name,
    dest: { name: t.dest_name, lat: t.dest_lat, lng: t.dest_lng },
    route: t.route,
    routeKm: Math.round(t.route_m / 100) / 10,
    fareXcd: t.fare_xcd,
    fareBreakdown: t.fare_breakdown,
    partySize: t.party_size,
    vehicleType: t.vehicle_type,
    openRoute: t.open_route,
    shared: t.shared,
    othersInCar: t.others_in_car,
    earlyDropoff: t.booked_dest_name && t.booked_route_m > t.route_m ? { bookedDest: t.booked_dest_name, discountPct: t.discount_pct } : null,      // other bookings currently in or heading to the same car (no names: privacy)
    stops: (t.stops || []).map(p => ({ name: p.name, lat: p.lat, lng: p.lng })),
    driver: t.driver_id ? { name: firstName(t.driver_name) + (t.driver_name.split(' ')[1] ? ' ' + t.driver_name.split(' ')[1][0] + '.' : ''), vehicle: t.vehicle, plate: t.plate, rating: t.rating, vehicleType: t.driver_vehicle_type, seats: t.driver_seats } : null,
    position: live && t.last_lat != null ? { lat: t.last_lat, lng: t.last_lng, speedKmh: t.last_speed_kmh, at: t.last_at } : null,
    times: { requested: t.requested_at, accepted: t.accepted_at, arrived: t.arrived_at, started: t.started_at, completed: t.completed_at, cancelled: t.cancelled_at },
  };
  return {
    passengerId: t.passenger_id,
    driverId: t.driver_id,
    passenger: { ...base, role: 'passenger', pickup: { lat: t.pickup_lat, lng: t.pickup_lng, name: t.pickup_name },
      pin: ['requested', 'accepted', 'arrived'].includes(t.status) ? t.pin : null,
      pinVerified: !!t.started_at, pinBlocked: t.pin_attempts >= 3, sharing: !!t.share_token_hash, alerts },
    driver: { ...base, role: 'driver', pickup: { lat: t.pickup_lat, lng: t.pickup_lng, name: t.pickup_name },
      passengerName: firstName(t.passenger_name), pinAttemptsLeft: Math.max(0, 3 - t.pin_attempts), alerts },
    share: ACTIVE.includes(t.status) || t.status === 'completed'
      ? { ...base, role: 'share', passengerName: firstName(t.passenger_name), route: t.status === 'completed' ? [] : t.route, fareXcd: undefined, fareBreakdown: undefined, stops: base.stops.map(p => ({ name: p.name })) }
      : null,
  };
}

async function activeTripId(user, db = pool) {
  const col = user.role === 'driver' ? 'driver_id' : 'passenger_id';
  const { rows } = await db.query(
    `SELECT id FROM trips WHERE ${col} = $1 AND status = ANY($2::trip_status[]) ORDER BY requested_at DESC LIMIT 1`,
    [user.id, ACTIVE]);
  return rows[0] ? rows[0].id : null;
}

/** A share link works only while the trip is active (and shows "arrived" for a short while after). */
async function tripIdForShareToken(token, db = pool) {
  if (!token || String(token).length < 20) return null;
  const { rows } = await db.query(
    `SELECT id FROM trips WHERE share_token_hash = $1
        AND (status = ANY($2::trip_status[]) OR (status = 'completed' AND completed_at > now() - interval '30 minutes'))`,
    [hashToken(token), ACTIVE]);
  return rows[0] ? rows[0].id : null;
}

/**
 * Checks a new driver position against the route. Returns the alert created, if any.
 * Runs only during the ride itself (after the PIN check).
 */
async function checkAlerts(db, trip, p, now = new Date()) {
  if (trip.status !== 'in_progress') return null;
  const created = [];
  // In a shared ride the driver may leave this route to collect another passenger (up to 1 km away)
  // or wait for them at their pickup. Neither is suspicious, so those checks pause meanwhile.
  let collecting = false, waiting = false;
  if (trip.group_id) {
    const { rows } = await db.query(`SELECT status FROM trips WHERE group_id = $1 AND id <> $2 AND status IN ('accepted', 'arrived')`, [trip.group_id, trip.id]);
    collecting = rows.some(r => r.status === 'accepted');
    waiting = rows.some(r => r.status === 'arrived');
  }

  // Off route?
  const off = !collecting && !waiting && distanceToRoute(p, trip.route) > OFF_ROUTE_M;
  if (off) {
    const since = trip.off_route_since ? new Date(trip.off_route_since) : now;
    if (!trip.off_route_since) await db.query('UPDATE trips SET off_route_since = $2 WHERE id = $1', [trip.id, now]);
    if ((now - since) / 1000 >= OFF_ROUTE_S) created.push(await raise(db, trip.id, 'off_route', { distanceM: Math.round(distanceToRoute(p, trip.route)) }));
  } else if (trip.off_route_since) {
    await db.query('UPDATE trips SET off_route_since = NULL WHERE id = $1', [trip.id]);
  }

  // Stopped too long? (close to the destination doesn't count)
  const nearDest = haversine(p, [trip.dest_lat, trip.dest_lng]) < 150;
  const stillHere = trip.stopped_lat != null && haversine(p, [trip.stopped_lat, trip.stopped_lng]) < STOP_RADIUS_M;
  if (!nearDest && stillHere && !waiting) {
    if ((now - new Date(trip.stopped_since)) / 1000 >= STOP_S) created.push(await raise(db, trip.id, 'long_stop', { stoppedSince: trip.stopped_since }));
  } else {
    await db.query('UPDATE trips SET stopped_since = $2, stopped_lat = $3, stopped_lng = $4 WHERE id = $1', [trip.id, now, p[0], p[1]]);
  }
  return created.find(Boolean) || null;
}

/** Opens an alert unless the same kind is already open or was answered in the last 5 minutes. */
async function raise(db, tripId, kind, details) {
  const { rows } = await db.query(
    `INSERT INTO alerts (trip_id, kind, details)
     SELECT $1, $2::alert_kind, $3
      WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE trip_id = $1 AND kind = $2::alert_kind
                         AND (status = 'open' OR resolved_at > now() - interval '5 minutes'))
     RETURNING id, kind`, [tripId, kind, details]);
  if (rows[0]) await audit(db, null, 'alert.raised', tripId, { kind, alertId: rows[0].id });
  return rows[0] || null;
}

/** Escalates alerts the passenger didn't answer in time. Returns the trip ids that changed. */
async function escalateUnanswered(db = pool) {
  const { rows } = await db.query(
    `UPDATE alerts SET status = 'escalated', resolved_at = now()
      WHERE status = 'open' AND created_at < now() - make_interval(secs => $1)
      RETURNING id, trip_id`, [ANSWER_S]);
  for (const r of rows) await audit(db, null, 'alert.escalated', r.trip_id, { alertId: r.id, reason: 'no answer' });
  return [...new Set(rows.map(r => r.trip_id))];
}

/** Deletes GPS trails a while after trips end. Returns how many trips were cleaned. */
async function purgeOldLocations(db = pool) {
  const hours = Number(process.env.LOCATION_RETENTION_HOURS || 24);
  const { rows } = await db.query(
    `UPDATE trips SET last_lat = NULL, last_lng = NULL, last_speed_kmh = NULL, stopped_lat = NULL, stopped_lng = NULL,
                      pickup_lat = NULL, pickup_lng = NULL, share_token_hash = NULL, pin = NULL, location_purged = true
      WHERE location_purged = false AND status IN ('completed', 'cancelled')
        AND COALESCE(completed_at, cancelled_at) < now() - make_interval(hours => $1)
      RETURNING id`, [hours]);
  if (rows.length) {
    await db.query('DELETE FROM trip_points WHERE trip_id = ANY($1::uuid[])', [rows.map(r => r.id)]);
    await audit(db, null, 'privacy.purge', null, { trips: rows.length, hours });
  }
  return rows.length;
}

/** Works the fare out again from the booking's planned route and options, and saves it. */
/** Work out a booking's fare from its current state. `over` lets a preview try a new route without saving. */
async function quote(db, t, over = {}) {
  const routeM = over.routeM ?? t.route_m, openRoute = over.openRoute ?? t.open_route;
  const bookedM = over.bookedM !== undefined ? over.bookedM : t.booked_route_m;
  const stops = over.stops ?? (t.stops || []).length;
  const opts = { partySize: t.party_size, openRoute, shared: t.shared, stops };
  // Getting off early: price the trip as booked, then any discount.
  if (bookedM && routeM < bookedM) {
    let others = [];
    if (t.group_id) {
      const { rows } = await db.query('SELECT status, party_size, accepted_at FROM trips WHERE group_id = $1 AND id <> $2', [t.group_id, t.id]);
      others = rows.map(r => ({ status: r.status, partySize: r.party_size, acceptedAt: r.accepted_at }));
    }
    const d = pricing.earlyDiscount({ startedAt: t.started_at, others });
    return { ...pricing.withDiscount(pricing.price({ routeM: bookedM, ...opts }), d, over.bookedDest || t.booked_dest_name), discountPct: d.pct, early: true };
  }
  return { ...pricing.price({ routeM, ...opts }), discountPct: 0, early: false };
}

async function reprice(db, tripId) {
  const { rows: [t] } = await db.query('SELECT * FROM trips WHERE id = $1', [tripId]);
  if (!t || ['completed', 'cancelled'].includes(t.status)) return null;   // a finished fare never changes
  const q = await quote(db, t);
  await db.query('UPDATE trips SET fare_xcd = $2, base_xcd = $3, fare_breakdown = $4, discount_pct = $5 WHERE id = $1',
    [tripId, q.total, q.base, JSON.stringify(q.lines), q.discountPct]);
  return q;
}

/** Reprice every active booking in a car (an early drop-off discount depends on who else is in it). Returns the ids. */
async function repriceGroup(db, groupId) {
  if (!groupId) return [];
  const { rows } = await db.query(`SELECT id FROM trips WHERE group_id = $1 AND status IN ('accepted','arrived','in_progress')`, [groupId]);
  for (const r of rows) await reprice(db, r.id);
  return rows.map(r => r.id);
}

module.exports = { quote, reprice, repriceGroup, ACTIVE, LIVE, hashToken, loadTrip, views, activeTripId, tripIdForShareToken, checkAlerts, raise, escalateUnanswered, purgeOldLocations };
