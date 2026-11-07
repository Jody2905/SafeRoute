/* SafeRoute fare rules for the browser (same rules as server/src/services/pricing.js).
   The server always has the final say; this is for instant estimates and the offline demo. */
(function () {
  var R = { baseFlag: 8, perKm: 2.5, minimum: 10, extraSolo: 1 / 3, privateRide: 0.10, sharedShare: 2 / 3, extraShared: 0.15, stopFee: 3 };
  var VEHICLES = { car: { label: "Car", seats: 4, icon: "🚕", desc: "Everyday taxi" }, suv: { label: "SUV", seats: 6, icon: "🚙", desc: "Room for 6 and luggage" }, van: { label: "Van", seats: 14, icon: "🚐", desc: "Groups, events, the airport" } };
  var m2 = function (n) { return Math.round(n * 100) / 100; };
  function baseFare(metres) { return Math.max(R.minimum, Math.round(R.baseFlag + R.perKm * (metres / 1000))); }
  function price(o) {
    var base = baseFare(o.routeM), extras = Math.max(0, (o.partySize || 1) - 1), lines = [];
    var pl = function (n, w) { return n + " " + w + (n === 1 ? "" : "s"); };
    if (o.shared) {
      lines.push({ label: "Your share of the fare (2/3 of EC$" + base + ")", xcd: m2(base * R.sharedShare) });
      if (extras) lines.push({ label: pl(extras, "extra passenger") + " × 15% of EC$" + base, xcd: m2(extras * base * R.extraShared) });
    } else {
      lines.push({ label: "Ride fare", xcd: base });
      if (extras) lines.push({ label: pl(extras, "extra passenger") + " × 1/3 of EC$" + base, xcd: m2(extras * base * R.extraSolo) });
      if (o.openRoute === false) { var sub = lines.reduce(function (s, l) { return s + l.xcd; }, 0); lines.push({ label: "Private ride (+10%)", xcd: m2(sub * R.privateRide) }); }
    }
    if (o.stops) lines.push({ label: pl(o.stops, "extra stop") + " × EC$" + R.stopFee, xcd: o.stops * R.stopFee });
    return { base: base, total: Math.round(lines.reduce(function (s, l) { return s + l.xcd; }, 0)), lines: lines };
  }
  /** Rough road distance between two points when no route is available (straight line × 1.35). */
  function estimateMetres(a, b) {
    var r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * 6371000 * Math.asin(Math.sqrt(h)) * 1.35;
  }
  var fmtLine = function (l) { return "EC$" + (Math.round(l.xcd * 100) % 100 ? l.xcd.toFixed(2) : l.xcd); };
  window.SR_FARES = { RULES: R, VEHICLES: VEHICLES, baseFare: baseFare, price: price, estimateMetres: estimateMetres, fmtLine: fmtLine };
})();
