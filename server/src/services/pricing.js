// SafeRoute fares (EC$). Every rule is here so it's easy to read and change.
//
// Base fare (A to B): EC$8 + EC$2.50 per km of the planned road route, at least EC$10.
// Not shared:
//   • extra passengers on your booking: 1/3 of the base fare each
//   • private ride (open route off): +10% on top
// Shared (another SafeRoute booking rides in the same car):
//   • each booking pays 2/3 of its own base fare
//   • extra passengers on a booking: 15% of the base fare each
// Extra stops: EC$3 each (their extra distance is already in the planned route).
// Driver detours never cost the passenger: fares use the planned route, not the distance driven.

const RULES = {
  baseFlag: 8,
  perKm: 2.5,
  minimum: 10,
  extraPassengerSolo: 1 / 3,
  privateRide: 0.10,
  sharedShare: 2 / 3,
  extraPassengerShared: 0.15,
  stopFee: 3,
};

const VEHICLES = {
  car: { label: 'Car', seats: 4 },
  suv: { label: 'SUV', seats: 6 },
  van: { label: 'Van', seats: 14 },
};
const RANK = { car: 1, suv: 2, van: 3 };

const money = n => Math.round(n * 100) / 100;

function baseFare(routeMetres) {
  return Math.max(RULES.minimum, Math.round(RULES.baseFlag + RULES.perKm * (routeMetres / 1000)));
}

/**
 * Prices one booking.
 * @param {{ routeM:number, partySize?:number, openRoute?:boolean, shared?:boolean, stops?:number }} b
 * @returns {{ base:number, total:number, lines:{label:string,xcd:number}[] }}
 */
function price({ routeM, partySize = 1, openRoute = true, shared = false, stops = 0 }) {
  const base = baseFare(routeM);
  const extras = Math.max(0, partySize - 1);
  const lines = [];
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (shared) {
    lines.push({ label: `Your share of the fare (2/3 of EC$${base})`, xcd: money(base * RULES.sharedShare) });
    if (extras) lines.push({ label: `${plural(extras, 'extra passenger')} × 15% of EC$${base}`, xcd: money(extras * base * RULES.extraPassengerShared) });
  } else {
    lines.push({ label: 'Ride fare', xcd: base });
    if (extras) lines.push({ label: `${plural(extras, 'extra passenger')} × 1/3 of EC$${base}`, xcd: money(extras * base * RULES.extraPassengerSolo) });
    if (!openRoute) {
      const sub = lines.reduce((s, l) => s + l.xcd, 0);
      lines.push({ label: 'Private ride (+10%)', xcd: money(sub * RULES.privateRide) });
    }
  }
  if (stops) lines.push({ label: `${plural(stops, 'extra stop')} × EC$${RULES.stopFee}`, xcd: stops * RULES.stopFee });
  // Taxis deal in whole dollars, so the total is rounded to the nearest EC$1.
  const total = Math.round(lines.reduce((s, l) => s + l.xcd, 0));
  return { base, total, lines };
}

const seatsFor = type => (VEHICLES[type] || VEHICLES.car).seats;
/** Can a driver's vehicle take a booking for this vehicle type? (A van can do a car booking, not the other way round.) */
const canServe = (driverType, wantedType) => (RANK[driverType] || 1) >= (RANK[wantedType] || 1);

/**
 * Getting off before the booked drop-off. The passenger pays the fare for the trip they booked, less:
 *  15% if 2+ other bookings are still in the car, or the driver accepted a new rider during their ride;
 *  10% if 1 other booking is still in the car with 2+ people on it.
 * `others` are the other bookings in the same car: { status, partySize, acceptedAt }.
 */
function earlyDiscount({ startedAt, others }) {
  const inCar = others.filter(o => o.status === 'in_progress');
  const newRider = startedAt && others.some(o => o.status !== 'cancelled' && o.acceptedAt && new Date(o.acceptedAt) > new Date(startedAt));
  if (inCar.length >= 2) return { pct: 15, reason: inCar.length + ' other bookings are still in the car' };
  if (newRider) return { pct: 15, reason: 'the driver picked up a new rider on your route' };
  if (inCar.length === 1 && inCar[0].partySize >= 2) return { pct: 10, reason: 'another group of ' + inCar[0].partySize + ' is still in the car' };
  return { pct: 0, reason: null };
}

/** Apply an early drop-off discount to a priced trip (the whole fare). */
function withDiscount(q, d, bookedDest) {
  const lines = q.lines.map((l, i) => i === 0 ? { ...l, label: l.label + ' (trip booked to ' + bookedDest + ')' } : l);
  if (!d.pct) return { ...q, lines };
  const off = Math.round(q.total * d.pct) / 100;
  lines.push({ label: 'Early drop-off: ' + d.pct + '% off because ' + d.reason, xcd: -off });
  return { ...q, lines, total: Math.round(q.total - off) };
}

module.exports = { earlyDiscount, withDiscount, RULES, VEHICLES, baseFare, price, seatsFor, canServe };
