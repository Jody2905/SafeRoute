// End-to-end API tests against a real PostgreSQL database.
// They ERASE the database in TEST_DATABASE_URL, so never point it at your real one.
require('../src/env');
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) { console.error('Set TEST_DATABASE_URL to a throwaway database. The tests erase all data.'); process.exit(1); }
if (testUrl === process.env.DATABASE_URL) { console.error('TEST_DATABASE_URL must not be your main database.'); process.exit(1); }
process.env.DATABASE_URL = testUrl;
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.LONG_STOP_SECONDS = '1';
process.env.ALERT_ANSWER_SECONDS = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret-123';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const request = require('supertest');
const WebSocket = require('ws');
const { pool } = require('../src/db');
const { createApp } = require('../src/app');
const live = require('../src/services/realtime');
const T = require('../src/services/trips');

const app = createApp();
const server = http.createServer(app);
live.attach(server, { loadViews: id => T.views(id) });
const api = () => request(server);
const auth = t => ({ Authorization: 'Bearer ' + t });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Arnos Vale -> Kingstown
const PICKUP = { lat: 13.1431, lng: -61.2117, name: 'Arnos Vale' };
const DEST = { lat: 13.1562, lng: -61.2276, name: 'Kingstown' };

async function register(email, role = 'passenger', extra = {}) {
  const r = await api().post('/api/auth/register').send({ email, password: 'correct-horse-battery', name: role === 'driver' ? 'Marcus Thomas' : 'Rhea Samuel', role, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.token;
}

let rhea, kemar, marcus, sandra, port;

before(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  rhea = await register('rhea@test.dev');
  kemar = await register('kemar@test.dev');
  marcus = await register('marcus@test.dev', 'driver', { vehicle: 'Silver Toyota Corolla', plate: 'h4421' });
  sandra = await register('sandra@test.dev', 'driver', { vehicle: 'White Nissan Note', plate: 'H 3312' });
  await new Promise(r => server.listen(0, r));
  port = server.address().port;
});
after(async () => { await new Promise(r => server.close(r)); await pool.end(); });

test('accounts: sign up, sign in, wrong password, duplicate email', async () => {
  const me = await api().get('/api/auth/me').set(auth(marcus)).expect(200);
  assert.equal(me.body.role, 'driver');
  assert.equal(me.body.driver.plate, 'H 4421');
  assert.equal(me.body.driver.verified, true);
  await api().post('/api/auth/login').send({ email: 'rhea@test.dev', password: 'correct-horse-battery' }).expect(200);
  await api().post('/api/auth/login').send({ email: 'rhea@test.dev', password: 'nope-nope-nope' }).expect(401);
  await api().post('/api/auth/login').send({ email: 'nobody@test.dev', password: 'nope-nope-nope' }).expect(401);
  await api().post('/api/auth/register').send({ email: 'rhea@test.dev', password: 'correct-horse-battery', name: 'Rhea' }).expect(409);
  await api().post('/api/auth/register').send({ email: 'x@test.dev', password: 'short', name: 'X' }).expect(400);
  await api().get('/api/trips/current').expect(401);
});

test('a full trip: request, accept, live location, PIN, ride, complete', async () => {
  // Outside St. Vincent is refused
  await api().post('/api/trips').set(auth(rhea)).send({ pickup: { lat: 17.99, lng: -76.79, name: 'Kingston JA' }, dest: DEST }).expect(400);
  // Drivers can't request rides
  await api().post('/api/trips').set(auth(marcus)).send({ pickup: PICKUP, dest: DEST }).expect(403);

  const req1 = await api().post('/api/trips').set(auth(rhea)).send({ pickup: PICKUP, dest: DEST }).expect(201);
  const trip = req1.body;
  assert.equal(trip.status, 'requested');
  assert.match(trip.pin, /^\d{4}$/);
  assert.ok(trip.fareXcd >= 10);
  // One active trip per passenger
  await api().post('/api/trips').set(auth(rhea)).send({ pickup: PICKUP, dest: DEST }).expect(409);

  // Drivers see the request with a distance, but not the exact pickup point or PIN
  const open = await api().get('/api/trips/open?lat=13.155&lng=-61.226').set(auth(marcus)).expect(200);
  const listed = open.body.find(t => t.id === trip.id);
  assert.ok(listed && listed.awayKm > 0);
  assert.equal(listed.pin, undefined);
  assert.equal(listed.pickupLat, undefined);
  await api().get('/api/trips/open').set(auth(rhea)).expect(403);

  // Only one driver can accept
  await api().post(`/api/trips/${trip.id}/accept`).set(auth(marcus)).expect(200);
  await api().post(`/api/trips/${trip.id}/accept`).set(auth(sandra)).expect(409);
  // Another driver can't see or touch it
  await api().get(`/api/trips/${trip.id}`).set(auth(sandra)).expect(404);
  await api().post(`/api/trips/${trip.id}/location`).set(auth(sandra)).send({ lat: 13.15, lng: -61.22 }).expect(404);

  // Driver drives to the pickup; passenger sees the position, driver never sees the PIN
  await api().post(`/api/trips/${trip.id}/location`).set(auth(marcus)).send({ lat: 13.150, lng: -61.220, speedKmh: 30, accuracyM: 8 }).expect(200);
  const pv = (await api().get(`/api/trips/${trip.id}`).set(auth(rhea)).expect(200)).body;
  assert.equal(pv.status, 'accepted');
  assert.equal(pv.position.lat, 13.150);
  assert.equal(pv.driver.plate, 'H 4421');
  assert.equal(pv.driver.name, 'Marcus T.');
  const dv = (await api().get(`/api/trips/${trip.id}`).set(auth(marcus)).expect(200)).body;
  assert.equal(dv.pin, undefined);
  assert.equal(dv.passengerName, 'Rhea');

  // Can't start before arriving; wrong PIN is refused and counted
  await api().post(`/api/trips/${trip.id}/start`).set(auth(marcus)).send({ pin: trip.pin }).expect(409);
  await api().post(`/api/trips/${trip.id}/arrived`).set(auth(marcus)).expect(200);
  const wrong = trip.pin === '0000' ? '1111' : '0000';
  const bad = await api().post(`/api/trips/${trip.id}/start`).set(auth(marcus)).send({ pin: wrong }).expect(400);
  assert.equal(bad.body.attemptsLeft, 2);
  // Right PIN starts the ride and the PIN is gone
  await api().post(`/api/trips/${trip.id}/start`).set(auth(marcus)).send({ pin: trip.pin }).expect(200);
  const started = (await api().get(`/api/trips/${trip.id}`).set(auth(rhea))).body;
  assert.equal(started.status, 'in_progress');
  assert.equal(started.pin, null);
  assert.equal(started.pinVerified, true);
  const { rows: [{ pin }] } = await pool.query('SELECT pin FROM trips WHERE id = $1', [trip.id]);
  assert.equal(pin, null);

  // Passenger can't cancel mid-ride (they use SOS); driver completes
  await api().post(`/api/trips/${trip.id}/cancel`).set(auth(rhea)).expect(409);
  await api().post(`/api/trips/${trip.id}/complete`).set(auth(marcus)).expect(200);
  const done = (await api().get(`/api/trips/${trip.id}`).set(auth(rhea))).body;
  assert.equal(done.status, 'completed');
  assert.equal(done.position, null); // live position stops at the end
  const hist = (await api().get('/api/trips/history').set(auth(rhea))).body;
  assert.equal(hist[0].id, trip.id);
});

test('three wrong PINs block the trip', async () => {
  const t = (await api().post('/api/trips').set(auth(kemar)).send({ pickup: PICKUP, dest: DEST }).expect(201)).body;
  await api().post(`/api/trips/${t.id}/accept`).set(auth(sandra)).expect(200);
  await api().post(`/api/trips/${t.id}/arrived`).set(auth(sandra)).expect(200);
  const wrong = t.pin === '0000' ? '1111' : '0000';
  for (let i = 0; i < 3; i++) await api().post(`/api/trips/${t.id}/start`).set(auth(sandra)).send({ pin: wrong }).expect(400);
  await api().post(`/api/trips/${t.id}/start`).set(auth(sandra)).send({ pin: t.pin }).expect(423);
  assert.equal((await api().get(`/api/trips/${t.id}`).set(auth(kemar))).body.pinBlocked, true);
  await api().post(`/api/trips/${t.id}/cancel`).set(auth(kemar)).expect(200);
});

test('share link: works during the trip, shows no PIN, stops when sharing ends', async () => {
  const t = (await api().post('/api/trips').set(auth(rhea)).send({ pickup: PICKUP, dest: DEST }).expect(201)).body;
  await api().post(`/api/trips/${t.id}/share`).set(auth(marcus)).expect(403);
  const { token } = (await api().post(`/api/trips/${t.id}/share`).set(auth(rhea)).expect(200)).body;
  assert.ok(token.length >= 30);
  const { rows: [{ share_token_hash: h }] } = await pool.query('SELECT share_token_hash FROM trips WHERE id = $1', [t.id]);
  assert.notEqual(h, token); // only a hash is stored

  await api().post(`/api/trips/${t.id}/accept`).set(auth(marcus)).expect(200);
  await api().post(`/api/trips/${t.id}/location`).set(auth(marcus)).send({ lat: 13.148, lng: -61.218 }).expect(200);
  const s = (await api().get('/api/share/' + token).expect(200)).body;
  assert.equal(s.passengerName, 'Rhea');
  assert.equal(s.position.lat, 13.148);
  assert.equal(s.pin, undefined);
  assert.equal(s.pickup, undefined); // contacts see the pickup name, not exact coordinates
  assert.equal(s.alerts, undefined);
  await api().get('/api/share/not-a-real-token-at-all-123456').expect(404);

  await api().delete(`/api/trips/${t.id}/share`).set(auth(rhea)).expect(200);
  await api().get('/api/share/' + token).expect(404);
  await api().post(`/api/trips/${t.id}/cancel`).set(auth(rhea)).expect(200);
});

test('route alerts: off route and long stop, answered or escalated; SOS', async () => {
  const t = (await api().post('/api/trips').set(auth(rhea)).send({ pickup: PICKUP, dest: DEST }).expect(201)).body;
  await api().post(`/api/trips/${t.id}/accept`).set(auth(marcus)).expect(200);
  await api().post(`/api/trips/${t.id}/arrived`).set(auth(marcus)).expect(200);
  await api().post(`/api/trips/${t.id}/start`).set(auth(marcus)).send({ pin: t.pin }).expect(200);

  // Drive about 600 m off the route; the alert opens after 20 s off route (clock moved back for the test).
  const offPoint = { lat: 13.1440, lng: -61.2260 };
  await api().post(`/api/trips/${t.id}/location`).set(auth(marcus)).send(offPoint).expect(200);
  await pool.query(`UPDATE trips SET off_route_since = now() - interval '30 seconds', last_at = now() - interval '5 seconds' WHERE id = $1`, [t.id]);
  const r = await api().post(`/api/trips/${t.id}/location`).set(auth(marcus)).send(offPoint).expect(200);
  assert.equal(r.body.alert, 'off_route');
  let v = (await api().get(`/api/trips/${t.id}`).set(auth(rhea))).body;
  assert.equal(v.alerts.length, 1);
  assert.equal(v.alerts[0].kind, 'off_route');
  // Other people can't answer it; the passenger says they're OK
  await api().post(`/api/alerts/${v.alerts[0].id}/respond`).set(auth(kemar)).send({ ok: true }).expect(404);
  await api().post(`/api/alerts/${v.alerts[0].id}/respond`).set(auth(rhea)).send({ ok: true }).expect(200);
  v = (await api().get(`/api/trips/${t.id}`).set(auth(rhea))).body;
  assert.equal(v.alerts.length, 0);

  // Long stop back on the route (stop timer is 1 s in tests); nobody answers, so it escalates
  const onRoute = { lat: 13.1497, lng: -61.2197 };
  await pool.query(`UPDATE trips SET last_at = now() - interval '5 seconds' WHERE id = $1`, [t.id]);
  await api().post(`/api/trips/${t.id}/location`).set(auth(marcus)).send(onRoute).expect(200);
  await pool.query(`UPDATE trips SET stopped_since = now() - interval '5 seconds', last_at = now() - interval '5 seconds' WHERE id = $1`, [t.id]);
  const r2 = await api().post(`/api/trips/${t.id}/location`).set(auth(marcus)).send(onRoute).expect(200);
  assert.equal(r2.body.alert, 'long_stop');
  await sleep(1200);
  const escalated = await T.escalateUnanswered();
  assert.ok(escalated.includes(t.id));
  const { rows } = await pool.query(`SELECT kind, status FROM alerts WHERE trip_id = $1 ORDER BY id`, [t.id]);
  assert.deepEqual(rows.map(a => a.kind + ':' + a.status), ['off_route:ok', 'long_stop:escalated']);

  // SOS is escalated straight away and logged
  await api().post(`/api/trips/${t.id}/sos`).set(auth(rhea)).expect(201);
  const { rows: log } = await pool.query(`SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id`, [t.id]);
  for (const a of ['trip.request', 'trip.accept', 'trip.start', 'alert.raised', 'alert.ok', 'alert.escalated', 'alert.sos']) assert.ok(log.some(l => l.action === a), a);
  await api().post(`/api/trips/${t.id}/complete`).set(auth(marcus)).expect(200);
});

test('privacy: GPS trails are deleted after the retention period', async () => {
  const { rows: [{ n: before }] } = await pool.query('SELECT count(*)::int AS n FROM trip_points');
  assert.ok(before > 0);
  await pool.query(`UPDATE trips SET completed_at = now() - interval '2 days' WHERE status = 'completed'`);
  await pool.query(`UPDATE trips SET cancelled_at = now() - interval '2 days' WHERE status = 'cancelled'`);
  const cleaned = await T.purgeOldLocations();
  assert.ok(cleaned >= 3);
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM trip_points');
  assert.equal(n, 0);
  const { rows: [t] } = await pool.query(`SELECT pickup_lat, last_lat, share_token_hash FROM trips WHERE status = 'completed' LIMIT 1`);
  assert.deepEqual([t.pickup_lat, t.last_lat, t.share_token_hash], [null, null, null]);
});

test('trusted contacts', async () => {
  const c = (await api().post('/api/contacts').set(auth(rhea)).send({ name: 'Mom', phone: '+1 784 555 0101', relation: 'Family' }).expect(201)).body;
  assert.equal((await api().get('/api/contacts').set(auth(rhea))).body.length, 1);
  assert.equal((await api().get('/api/contacts').set(auth(kemar))).body.length, 0);
  await api().delete('/api/contacts/' + c.id).set(auth(kemar)).expect(404);
  await api().delete('/api/contacts/' + c.id).set(auth(rhea)).expect(200);
  await api().post('/api/contacts').set(auth(rhea)).send({ name: 'X', phone: 'abc' }).expect(400);
});

test('live updates: passenger and share viewer get the driver position over WebSockets', async () => {
  const t = (await api().post('/api/trips').set(auth(rhea)).send({ pickup: PICKUP, dest: DEST }).expect(201)).body;
  const { token } = (await api().post(`/api/trips/${t.id}/share`).set(auth(rhea))).body;
  const open = () => new Promise((res, rej) => { const ws = new WebSocket(`ws://localhost:${port}/ws`); ws.once('open', () => res(ws)); ws.once('error', rej); });
  const next = (ws, pred) => new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('no message')), 3000);
    ws.on('message', function h(raw) { const m = JSON.parse(raw); if (pred(m)) { clearTimeout(timer); ws.off('message', h); res(m); } });
  });
  const pass = await open(), watcher = await open(), drv = await open();
  pass.send(JSON.stringify({ type: 'auth', token: rhea }));
  await next(pass, m => m.type === 'trip' && m.trip.status === 'requested');
  watcher.send(JSON.stringify({ type: 'share', token }));
  await next(watcher, m => m.type === 'trip');
  drv.send(JSON.stringify({ type: 'auth', token: sandra }));
  await next(drv, m => m.type === 'ready');

  const gotAccepted = next(pass, m => m.type === 'trip' && m.trip.status === 'accepted');
  const gotRequests = next(drv, m => m.type === 'requests');
  await api().post(`/api/trips/${t.id}/accept`).set(auth(marcus)).expect(200);
  await gotAccepted;
  await gotRequests; // other drivers are told the request is gone

  const passPos = next(pass, m => m.type === 'trip' && m.trip.position && m.trip.position.lat === 13.151);
  const sharePos = next(watcher, m => m.type === 'trip' && m.trip.position && m.trip.position.lat === 13.151);
  await api().post(`/api/trips/${t.id}/location`).set(auth(marcus)).send({ lat: 13.151, lng: -61.221 }).expect(200);
  const [p, s] = await Promise.all([passPos, sharePos]);
  assert.match(p.trip.pin, /^\d{4}$/);
  assert.equal(s.trip.pin, undefined);

  // Bad share tokens are refused
  const bad = await open();
  bad.send(JSON.stringify({ type: 'share', token: 'nope-nope-nope-nope-nope-nope' }));
  assert.equal((await next(bad, m => m.type === 'error')).type, 'error');
  for (const ws of [pass, watcher, drv, bad]) ws.close();
  await api().post(`/api/trips/${t.id}/cancel`).set(auth(rhea)).expect(200);
});

test('website: pages are served, server files are not', async () => {
  const home = await api().get('/').expect(200);
  assert.match(home.text, /SafeRoute/);
  await api().get('/saferoute-tracking.html').expect(200);
  await api().get('/assets/tracking.js').expect(200);
  for (const p of ['/server/.env', '/server/package.json', '/server/src/app.js', '/.git/config', '/README.md', '/assets/../server/db/schema.sql']) {
    await api().get(p).expect(404);
  }
});
