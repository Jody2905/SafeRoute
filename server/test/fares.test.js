// Fares, stops, drop-off changes, seats and shared rides. Erases TEST_DATABASE_URL, like api.test.js.
require('../src/env');
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || testUrl === process.env.DATABASE_URL) { console.error('Set TEST_DATABASE_URL to a throwaway database.'); process.exit(1); }
process.env.DATABASE_URL = testUrl;
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret-123';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { pool } = require('../src/db');
const { createApp } = require('../src/app');
const { price } = require('../src/services/pricing');

const app = createApp();
const api = () => request(app);
const auth = t => ({ Authorization: 'Bearer ' + t });

// Richland Park → Kingstown, and a second passenger going the same way from Mesopotamia.
const RICHLAND = { lat: 13.1878, lng: -61.1826, name: 'Richland Park' };
const MESO = { lat: 13.1715, lng: -61.1755, name: 'Mesopotamia' };
const KINGSTOWN = { lat: 13.1562, lng: -61.2276, name: 'Kingstown' };
const GEORGETOWN = { lat: 13.2780, lng: -61.1200, name: 'Georgetown' };
const ARNOS = { lat: 13.1431, lng: -61.2117, name: 'Arnos Vale' };
// In tests routes are straight lines (no map service), so this point sits on the Richland Park → Kingstown line.
const ON_THE_WAY = { lat: 13.1783, lng: -61.1961, name: 'On the way' };

async function register(email, role = 'passenger', extra = {}) {
  const r = await api().post('/api/auth/register').send({ email, password: 'correct-horse-battery', name: 'Test ' + email.split('@')[0], role, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.token;
}
let p1, p2, p3, car, van;
before(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  await require('../db/migrate').migrate(pool);
  p1 = await register('p1@test.dev'); p2 = await register('p2@test.dev'); p3 = await register('p3@test.dev');
  car = await register('car@test.dev', 'driver', { vehicle: 'Toyota Corolla', plate: 'H 1111', vehicleType: 'car' });
  van = await register('van@test.dev', 'driver', { vehicle: 'Toyota Hiace', plate: 'H 2222', vehicleType: 'van' });
});
after(() => pool.end());

const book = (tok, pickup, dest, opts = {}) => api().post('/api/trips').set(auth(tok)).send({ pickup, dest, ...opts });
const start = async (drv, t) => {
  await api().post(`/api/trips/${t.id}/arrived`).set(auth(drv)).expect(200);
  return (await api().post(`/api/trips/${t.id}/start`).set(auth(drv)).send({ pin: t.pin }).expect(200)).body;
};
const get = async (tok, id) => (await api().get('/api/trips/' + id).set(auth(tok)).expect(200)).body;

test("Jo's worked examples (fare EC$60)", () => {
  const routeM = 20800; // EC$8 + 20.8 km × EC$2.50 = EC$60
  assert.equal(price({ routeM }).total, 60);
  assert.equal(price({ routeM, openRoute: false }).total, 66);                // private +10%
  assert.equal(price({ routeM, partySize: 3 }).total, 100);                   // 2 extras × 1/3
  assert.equal(price({ routeM, partySize: 3, openRoute: false }).total, 110); // …and private
  assert.equal(price({ routeM, shared: true }).total, 40);                    // 2/3 each when shared
  assert.equal(price({ routeM, partySize: 2, shared: true }).total, 49);      // + 15% per extra
  assert.equal(price({ routeM, stops: 2 }).total, 66);                        // EC$3 a stop
  assert.equal(price({ routeM: 1000 }).total, 11);
  assert.equal(price({ routeM: 100 }).total, 10);                             // minimum
});

test('quotes, seat limits and private rides', async () => {
  const q = (await api().post('/api/fare/quote').set(auth(p1)).send({ pickup: RICHLAND, dest: KINGSTOWN, partySize: 2 }).expect(200)).body;
  assert.ok(q.alone.total > q.shared.total);
  assert.equal(q.seats, 4);
  await api().post('/api/fare/quote').set(auth(p1)).send({ pickup: RICHLAND, dest: KINGSTOWN, partySize: 6 }).expect(400); // car seats 4
  const big = (await api().post('/api/fare/quote').set(auth(p1)).send({ pickup: RICHLAND, dest: KINGSTOWN, partySize: 6, vehicleType: 'van' }).expect(200)).body;
  assert.equal(big.seats, 14);
  const priv = (await api().post('/api/fare/quote').set(auth(p1)).send({ pickup: RICHLAND, dest: KINGSTOWN, openRoute: false }).expect(200)).body;
  assert.equal(priv.shared, null);
  assert.ok(priv.alone.lines.some(l => l.label.startsWith('Private ride')));
});

test('van bookings only go to vans; vans can take car bookings', async () => {
  const t = (await book(p3, ARNOS, KINGSTOWN, { partySize: 6, vehicleType: 'van' }).expect(201)).body;
  const carSees = (await api().get('/api/trips/open').set(auth(car))).body.requests.map(r => r.id);
  const vanSees = (await api().get('/api/trips/open').set(auth(van))).body.requests.map(r => r.id);
  assert.ok(!carSees.includes(t.id));
  assert.ok(vanSees.includes(t.id));
  await api().post(`/api/trips/${t.id}/accept`).set(auth(car)).expect(409);
  await api().post(`/api/trips/${t.id}/cancel`).set(auth(p3)).expect(200);
});

test('extra stops and drop-off changes reprice from the planned route; detours do not', async () => {
  const t = (await book(p1, RICHLAND, KINGSTOWN).expect(201)).body;
  const before = t.fareXcd;
  // Add a stop at Mesopotamia (on the way): +EC$3 and the route goes through it
  const withStop = (await api().post(`/api/trips/${t.id}/stops`).set(auth(p1)).send(MESO).expect(200)).body;
  assert.equal(withStop.stops.length, 1);
  assert.ok(withStop.fareXcd >= before + 3);
  assert.ok(withStop.fareBreakdown.some(l => /extra stop/.test(l.label)));
  // Get off earlier, at Arnos Vale instead of Kingstown
  const earlier = (await api().post(`/api/trips/${t.id}/destination`).set(auth(p1)).send(ARNOS).expect(200)).body;
  assert.equal(earlier.dest.name, 'Arnos Vale');
  assert.notEqual(earlier.fareXcd, withStop.fareXcd);
  // A driver detour doesn't change the fare
  await api().post(`/api/trips/${t.id}/accept`).set(auth(car)).expect(200);
  const s = await start(car, earlier);
  await pool.query(`UPDATE trips SET last_at = now() - interval '5 seconds' WHERE id = $1`, [t.id]);
  await api().post('/api/driver/location').set(auth(car)).send({ lat: 13.25, lng: -61.20 }).expect(200);
  assert.equal((await get(p1, t.id)).fareXcd, s.fareXcd);
  // Only the passenger can add stops
  await api().post(`/api/trips/${t.id}/stops`).set(auth(car)).send(MESO).expect(403);
  await api().post(`/api/trips/${t.id}/complete`).set(auth(car)).expect(200);
  await api().post(`/api/trips/${t.id}/stops`).set(auth(p1)).send(MESO).expect(409);
});

test('shared ride: same-direction passenger joins, both pay 2/3, extras 15%', async () => {
  // Passenger 1 with a friend: Richland Park → Kingstown (open route). Alone, the friend costs 1/3.
  const a = (await book(p1, RICHLAND, KINGSTOWN, { partySize: 2 }).expect(201)).body;
  const aBase = (await pool.query('SELECT base_xcd FROM trips WHERE id = $1', [a.id])).rows[0].base_xcd;
  assert.equal(a.fareXcd, Math.round(aBase + aBase / 3));
  await api().post(`/api/trips/${a.id}/accept`).set(auth(car)).expect(200);
  await start(car, a);

  // Requests: same direction (Mesopotamia → Kingstown) is offered; Georgetown and the wrong way are not.
  const b = (await book(p2, ON_THE_WAY, KINGSTOWN).expect(201)).body;
  const wrong = (await book(p3, KINGSTOWN, GEORGETOWN).expect(201)).body;
  const offered = (await api().get('/api/trips/open').set(auth(car)).expect(200)).body;
  assert.equal(offered.seatsFree, 2); // car seats 4, two already in
  assert.ok(offered.requests.some(r => r.id === b.id && r.onYourRoute));
  assert.ok(!offered.requests.some(r => r.id === wrong.id));
  await api().post(`/api/trips/${wrong.id}/accept`).set(auth(car)).expect(409);

  // While collecting passenger 2, passenger 1 gets no false off-route alert.
  await api().post(`/api/trips/${b.id}/accept`).set(auth(car)).expect(200);
  assert.equal((await get(p1, a.id)).othersInCar, 1);
  await pool.query(`UPDATE trips SET off_route_since = now() - interval '1 minute', last_at = now() - interval '5 seconds' WHERE id = $1`, [a.id]);
  await pool.query(`UPDATE trips SET last_at = now() - interval '5 seconds' WHERE id = $1`, [b.id]);
  const fix = await api().post('/api/driver/location').set(auth(car)).send({ lat: 13.1783, lng: -61.1900 }).expect(200);
  assert.equal(fix.body.alert, null);

  // Once passenger 2 is picked up, both bookings are shared and repriced.
  const bs = await start(car, b);
  const aNow = await get(p1, a.id);
  assert.equal(aNow.shared, true);
  assert.equal(bs.shared, true);
  const bBase = (await pool.query('SELECT base_xcd FROM trips WHERE id = $1', [b.id])).rows[0].base_xcd;
  assert.equal(aNow.fareXcd, Math.round(aBase * 2 / 3 + aBase * 0.15));
  assert.equal(bs.fareXcd, Math.round(bBase * 2 / 3));
  // Car now full for a 3-person party
  const c = (await book(p3, ON_THE_WAY, KINGSTOWN, { partySize: 3 }).expect(409)); // p3 still has the Georgetown request
  await api().post(`/api/trips/${wrong.id}/cancel`).set(auth(p3)).expect(200);
  const big = (await book(p3, ON_THE_WAY, KINGSTOWN, { partySize: 2 }).expect(201)).body;
  const full = (await api().get('/api/trips/open').set(auth(car))).body;
  assert.equal(full.seatsFree, 1);
  assert.ok(!full.requests.some(r => r.id === big.id));
  await api().post(`/api/trips/${big.id}/cancel`).set(auth(p3)).expect(200);

  // Driver sees both passengers; each is completed separately
  const mine = (await api().get('/api/driver/trips').set(auth(car)).expect(200)).body;
  assert.equal(mine.length, 2);
  await api().post(`/api/trips/${b.id}/complete`).set(auth(car)).expect(200);
  await api().post(`/api/trips/${a.id}/complete`).set(auth(car)).expect(200);
  assert.equal(c.status, 409);
});

test('private rides are never shared', async () => {
  const a = (await book(p1, RICHLAND, KINGSTOWN, { openRoute: false }).expect(201)).body;
  assert.ok(a.fareBreakdown.some(l => l.label.startsWith('Private ride')));
  await api().post(`/api/trips/${a.id}/accept`).set(auth(car)).expect(200);
  const b = (await book(p2, ON_THE_WAY, KINGSTOWN).expect(201)).body;
  const offered = (await api().get('/api/trips/open').set(auth(car))).body;
  assert.ok(!offered.requests.some(r => r.id === b.id));
  await api().post(`/api/trips/${b.id}/accept`).set(auth(car)).expect(409);
  // …and a private request can't join someone else's car either
  await api().post(`/api/trips/${a.id}/cancel`).set(auth(p1)).expect(200);
  await api().post(`/api/trips/${b.id}/cancel`).set(auth(p2)).expect(200);
});

// ---------- getting off early ----------
// Between On the way and Kingstown, on the Richland Park → Kingstown line.
const FURTHER_ON = { lat: 13.1672, lng: -61.2118, name: 'Further on' };
const preview = async (tok, id, place) => (await api().post(`/api/trips/${id}/destination/preview`).set(auth(tok)).send(place).expect(200)).body;
const changeDest = async (tok, id, body) => (await api().post(`/api/trips/${id}/destination`).set(auth(tok)).send(body).expect(200)).body;
const finish = async (drv, id) => (await api().post(`/api/trips/${id}/complete`).set(auth(drv)).expect(200)).body;

test('getting off early on your own: you still pay the booked fare', async () => {
  const a = (await book(p1, RICHLAND, KINGSTOWN).expect(201)).body;
  await api().post(`/api/trips/${a.id}/accept`).set(auth(car)).expect(200);
  const s = await start(car, a);
  const pv = await preview(p1, a.id, ON_THE_WAY);
  assert.equal(pv.early, true);
  assert.equal(pv.fareXcd, s.fareXcd);
  assert.equal(pv.discountPct, 0);
  const after = await changeDest(p1, a.id, ON_THE_WAY);
  assert.equal(after.fareXcd, s.fareXcd);
  assert.equal(after.earlyDropoff.bookedDest, 'Kingstown');
  assert.ok(after.fareBreakdown[0].label.includes('trip booked to Kingstown'));
  // Moving it further again prices the new, longer trip normally
  const further = await changeDest(p1, a.id, GEORGETOWN);
  assert.ok(further.fareXcd > s.fareXcd);
  assert.equal(further.earlyDropoff, null);
  // Shortening again after extending: the longer trip is now the one booked
  const back = await changeDest(p1, a.id, ON_THE_WAY);
  assert.equal(back.fareXcd, further.fareXcd);
  assert.equal(back.earlyDropoff.bookedDest, 'Georgetown');
  assert.equal((await finish(car, a.id)).fareXcd, further.fareXcd);
});

test('private ride getting off early can open up; a new rider on the route gives 15% off', async () => {
  const a = (await book(p1, RICHLAND, KINGSTOWN, { openRoute: false }).expect(201)).body;
  await api().post(`/api/trips/${a.id}/accept`).set(auth(car)).expect(200);
  const s = await start(car, a);
  const pv = await preview(p1, a.id, ON_THE_WAY);
  assert.equal(pv.private, true);
  assert.equal(pv.fareXcd, s.fareXcd);              // stay private: same fare
  assert.ok(pv.ifOpen.fareXcd < s.fareXcd);          // open up: the +10% private charge goes
  const opened = await changeDest(p1, a.id, { ...ON_THE_WAY, openRoute: true });
  assert.equal(opened.openRoute, true);
  assert.equal(opened.fareXcd, pv.ifOpen.fareXcd);
  // Someone further along the original route can now be picked up
  const b = (await book(p2, FURTHER_ON, KINGSTOWN).expect(201)).body;
  const offered = (await api().get('/api/trips/open').set(auth(car))).body;
  assert.ok(offered.requests.some(r => r.id === b.id));
  await api().post(`/api/trips/${b.id}/accept`).set(auth(car)).expect(200);
  const now = await get(p1, a.id);
  assert.equal(now.earlyDropoff.discountPct, 15);
  assert.equal(now.fareXcd, Math.round(opened.fareXcd * 0.85));
  assert.ok(now.fareBreakdown.some(l => l.xcd < 0 && /15% off/.test(l.label)));
  assert.equal((await finish(car, a.id)).fareXcd, Math.round(opened.fareXcd * 0.85));
  await api().post(`/api/trips/${b.id}/cancel`).set(auth(car)).expect(200);
});

test('shared ride getting off early: 10% off while a group of 2+ is still in the car, gone once they leave', async () => {
  const a = (await book(p1, RICHLAND, KINGSTOWN).expect(201)).body;
  const b = (await book(p2, ON_THE_WAY, KINGSTOWN, { partySize: 2 }).expect(201)).body;
  await api().post(`/api/trips/${a.id}/accept`).set(auth(car)).expect(200);
  await api().post(`/api/trips/${b.id}/accept`).set(auth(car)).expect(200);   // accepted before a's ride began: not a "new rider"
  await start(car, a);
  await start(car, b);
  const shared = await get(p1, a.id);
  assert.equal(shared.shared, true);
  const early = await changeDest(p1, a.id, FURTHER_ON);
  assert.equal(early.earlyDropoff.discountPct, 10);
  assert.equal(early.fareXcd, Math.round(shared.fareXcd * 0.9));
  // The group gets out first: no one is left, so no discount
  await finish(car, b.id);
  const alone = await get(p1, a.id);
  assert.equal(alone.earlyDropoff.discountPct, 0);
  assert.equal((await finish(car, a.id)).fareXcd, shared.fareXcd);
  // A finished fare never changes afterwards
  assert.equal((await get(p1, a.id)).fareXcd, shared.fareXcd);
});

test('getting off early with two other bookings still in the car: 15% off', async () => {
  const a = (await book(p1, RICHLAND, KINGSTOWN).expect(201)).body;
  const b = (await book(p2, ON_THE_WAY, KINGSTOWN).expect(201)).body;
  const c = (await book(p3, ON_THE_WAY, KINGSTOWN).expect(201)).body;
  for (const t of [a, b, c]) await api().post(`/api/trips/${t.id}/accept`).set(auth(car)).expect(200);
  await start(car, a); await start(car, b); await start(car, c);
  const shared = await get(p1, a.id);
  const early = await changeDest(p1, a.id, FURTHER_ON);
  assert.equal(early.earlyDropoff.discountPct, 15);
  assert.equal(early.fareXcd, Math.round(shared.fareXcd * 0.85));
  // Only one booking of one person left: no discount for the next early leaver
  assert.equal((await finish(car, a.id)).fareXcd, Math.round(shared.fareXcd * 0.85));
  const bEarly = await changeDest(p2, b.id, FURTHER_ON);
  assert.equal(bEarly.earlyDropoff.discountPct, 0);
  await finish(car, b.id); await finish(car, c.id);
});
