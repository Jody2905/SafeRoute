// Distance and route helpers. Coordinates are [lat, lng] pairs.
const toRad = Math.PI / 180;

function haversine(a, b) {
  const dLat = (b[0] - a[0]) * toRad, dLng = (b[1] - a[1]) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function routeLength(pts) {
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += haversine(pts[i - 1], pts[i]);
  return m;
}

/** Shortest distance in metres from point p to the route line. */
function distanceToRoute(p, pts) {
  if (!pts || pts.length < 2) return 0;
  const kx = 111320 * Math.cos(p[0] * toRad), ky = 110540;
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const ax = (pts[i - 1][1] - p[1]) * kx, ay = (pts[i - 1][0] - p[0]) * ky;
    const bx = (pts[i][1] - p[1]) * kx, by = (pts[i][0] - p[0]) * ky;
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

function straightLine(a, b, steps = 20) {
  const out = [];
  for (let i = 0; i <= steps; i++) out.push([a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps]);
  return out;
}

/** Road route through the given points (pickup, any stops, drop-off) from the public OSRM server.
 *  Falls back to straight lines between the points if OSRM can't be reached. */
async function planRouteVia(points) {
  const fallback = () => points.slice(1).reduce((acc, p, i) => acc.concat(straightLine(points[i], p).slice(i ? 1 : 0)), []);
  if (process.env.NODE_ENV === 'test' || process.env.OFFLINE_ROUTES === 'true') return fallback();
  const coords = points.map(p => `${p[1]},${p[0]}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'SafeRoute/0.1 (portfolio project)' } });
    const j = await r.json();
    const c = j.routes && j.routes[0] && j.routes[0].geometry.coordinates;
    if (!c || c.length < 2) throw new Error('no route');
    // Keep at most ~400 points so the route stays small in the database.
    const step = Math.max(1, Math.ceil(c.length / 400));
    return c.filter((_, i) => i % step === 0 || i === c.length - 1).map(x => [x[1], x[0]]);
  } catch {
    return fallback();
  }
}
const planRoute = (from, to) => planRouteVia([from, to]);

/**
 * Does a new booking go the same way as a route the car is already driving?
 * Its pickup must be within `maxM` of the route, and its drop-off within `maxM` of the route
 * or near the route's end, and further along the route than the pickup.
 */
function sameDirection(route, pickup, dest, maxM = 1000) {
  const nearest = p => {
    let best = -1, bd = Infinity;
    route.forEach((q, i) => { const d = haversine(p, q); if (d < bd) { bd = d; best = i; } });
    return { i: best, d: bd };
  };
  const a = nearest(pickup), b = nearest(dest);
  const endNear = haversine(dest, route[route.length - 1]) <= maxM * 1.5;
  return a.d <= maxM && (b.d <= maxM || endNear) && b.i >= a.i;
}

/** Taxi fare in EC$: EC$8 base plus EC$2.50 a km, rounded to the nearest dollar. */
const fareFor = metres => Math.max(10, Math.round(8 + 2.5 * (metres / 1000)));

// St. Vincent and the Grenadines, roughly (main island plus the Grenadines down to Union Island).
const inSVG = (lat, lng) => lat > 12.4 && lat < 13.45 && lng > -61.5 && lng < -61.0;

module.exports = { haversine, routeLength, distanceToRoute, straightLine, planRoute, planRouteVia, sameDirection, fareFor, inSVG };
