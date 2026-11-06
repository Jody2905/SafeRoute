// Live updates over WebSockets (path /ws).
// A client connects, then sends ONE of:
//   { "type": "auth", "token": "<sign-in token>" }   passenger or driver
//   { "type": "share", "token": "<share-link token>" } someone following a shared trip
// After that it receives { type: "trip", trip } whenever the trip changes, and drivers also get
// { type: "requests" } when the list of open ride requests changes.
const { WebSocketServer } = require('ws');
const { userFromToken } = require('../auth');

const clients = new Set(); // { ws, user, tripIds:Set, shareTripId, isDriver }
let loader = null; // (tripId) => { passenger, driver, share } views; set by trips service

function attach(server, { loadViews }) {
  loader = loadViews;
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 });
  wss.on('connection', ws => {
    const c = { ws, user: null, tripIds: new Set(), shareTripId: null };
    clients.add(c);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => clients.delete(c));
    ws.on('message', async raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      try {
        if (msg.type === 'auth') {
          c.user = await userFromToken(msg.token);
          if (!c.user) return send(ws, { type: 'error', error: 'Sign in again' });
          send(ws, { type: 'ready', role: c.user.role });
          const { activeTripId } = require('./trips');
          const id = await activeTripId(c.user);
          if (id) { c.tripIds.add(id); push(c, id); }
        } else if (msg.type === 'share') {
          const { tripIdForShareToken } = require('./trips');
          const id = await tripIdForShareToken(msg.token);
          if (!id) return send(ws, { type: 'error', error: 'This trip link has expired.' });
          c.shareTripId = id;
          push(c, id);
        } else if (msg.type === 'watch' && c.user && msg.tripId) {
          // Watch a specific trip the user is part of (e.g. right after accepting it).
          const views = await loader(msg.tripId);
          if (views && (views.passengerId === c.user.id || views.driverId === c.user.id)) { c.tripIds.add(msg.tripId); push(c, msg.tripId, views); }
        }
      } catch (err) {
        send(ws, { type: 'error', error: 'Something went wrong' });
      }
    });
  });
  // Drop dead connections every 30 s (phones lose signal without closing cleanly).
  const timer = setInterval(() => {
    for (const c of clients) {
      if (!c.ws.isAlive) { c.ws.terminate(); clients.delete(c); continue; }
      c.ws.isAlive = false;
      c.ws.ping();
    }
  }, 30000);
  timer.unref();
  wss.on('close', () => clearInterval(timer));
  return wss;
}

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

async function push(c, tripId, views) {
  views = views || await loader(tripId);
  if (!views) return;
  let view = null;
  if (c.shareTripId === tripId) view = views.share;
  else if (c.user && c.user.id === views.passengerId) view = views.passenger;
  else if (c.user && c.user.id === views.driverId) view = views.driver;
  if (view) send(c.ws, { type: 'trip', trip: view });
}

/** Sends the latest state of a trip to its passenger, its driver and anyone following its share link. */
async function tripChanged(tripId) {
  if (!loader || !clients.size) return;
  const views = await loader(tripId);
  if (!views) return;
  for (const c of clients) {
    const mine = c.user && (c.user.id === views.passengerId || c.user.id === views.driverId);
    if (mine) c.tripIds.add(tripId);
    if (mine || c.shareTripId === tripId) push(c, tripId, views);
  }
}

/** Tells signed-in drivers the open-requests list changed. */
function requestsChanged() {
  for (const c of clients) if (c.user && c.user.role === 'driver') send(c.ws, { type: 'requests' });
}

module.exports = { attach, tripChanged, requestsChanged };
