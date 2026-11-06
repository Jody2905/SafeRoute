/* SafeRoute share page, live mode: follows a real trip with a private link (?s=token).
   Shows the taxi's live position, driver, car and plate. No PIN and no exact pickup point. */
(function () {
  "use strict";
  var token = new URLSearchParams(location.search).get("s");
  var $ = function (id) { return document.getElementById(id); };
  var setText = function (id, t) { var el = $(id); if (el) el.textContent = t; };
  var toRad = Math.PI / 180;
  function haversine(a, b) {
    var dLat = (b[0] - a[0]) * toRad, dLng = (b[1] - a[1]) * toRad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }
  function remaining(route, p) {
    if (!route || route.length < 2) return haversine(p, p);
    var best = 0, bd = Infinity;
    route.forEach(function (q, i) { var d = haversine(p, q); if (d < bd) { bd = d; best = i; } });
    var m = bd;
    for (var i = best + 1; i < route.length; i++) m += haversine(route[i - 1], route[i]);
    return m;
  }

  setText("demoNote", "Private link. It stops working when the trip ends. Only the taxi's position is shared, never the exact pickup address.");
  var map = L.map("map", { zoomControl: false }).setView([13.17, -61.21], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, subdomains: "abc",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  var icon = function (html, cls, size) { size = size || [34, 34]; return L.divIcon({ html: html, className: "sr-pin " + (cls || ""), iconSize: size, iconAnchor: [size[0] / 2, size[1] / 2] }); };
  var car = null, destM = null, line = null, fitted = false;

  function render(t) {
    var name = t.passengerName;
    document.title = "SafeRoute – Follow " + name + "'s trip";
    setText("shareTitle", name + " is on a SafeRoute trip");
    setText("worryText", "Call " + name + " first. If you can't reach them and think they're in danger, call emergency services and give them the taxi's plate and its last place on the map.");
    setText("fromName", t.pickupName);
    setText("toName", t.dest.name);
    if (t.driver) {
      setText("dName", t.driver.name + " · ★ " + Number(t.driver.rating).toFixed(1));
      setText("dCar", t.driver.vehicle);
      setText("dPlate", t.driver.plate);
    } else { setText("dName", "Waiting for a driver"); setText("dCar", "—"); setText("dPlate", "—"); }

    var dest = [t.dest.lat, t.dest.lng];
    if (!destM) destM = L.marker(dest, { icon: icon("📍", ""), title: "Destination" }).addTo(map).bindTooltip(t.dest.name, { permanent: true, direction: "right", offset: [14, 0] });
    if (!line && t.route && t.route.length) line = L.polyline(t.route, { color: "#0080ff", weight: 5, opacity: 0.6 }).addTo(map);
    var pos = t.position ? [t.position.lat, t.position.lng] : null;
    if (pos) { if (!car) car = L.marker(pos, { icon: icon("🚕", "sr-car", [38, 38]), zIndexOffset: 1000 }).addTo(map); else car.setLatLng(pos); }
    if (!fitted) { var b = L.latLngBounds(t.route && t.route.length ? t.route : [dest]); if (pos) b.extend(pos); map.fitBounds(b, { padding: [50, 50], animate: false }); fitted = true; }

    var riding = t.status === "in_progress";
    var leftM = pos ? (riding ? remaining(t.route, pos) : null) : null;
    var mins = leftM != null ? Math.max(1, Math.round(leftM / 1000 / 30 * 60)) : null;
    setText("etaKey", "ETA");
    $("etaMin").textContent = mins != null ? mins + " min" : "–";
    setText("distVal", leftM != null ? (leftM / 1000).toFixed(1) : "–");
    setText("speedVal", t.position && t.position.speedKmh != null ? String(Math.round(t.position.speedKmh)) : "–");
    setText("shareStatus", {
      requested: "Waiting for a driver to accept the ride",
      accepted: "A driver is on the way to pick " + name + " up",
      arrived: "The driver is at the pickup, checking the ride PIN",
      in_progress: "On the way to " + t.dest.name + (mins ? " · about " + mins + " min left" : ""),
      completed: "Arrived safely at " + t.dest.name + " ✓",
      cancelled: "This ride was cancelled",
    }[t.status] || "");
  }
  function expired(msg) {
    setText("shareStatus", msg || "This trip link has expired. Links stop working after the trip ends.");
    if (car) { map.removeLayer(car); car = null; }
  }

  SR.api("/api/share/" + encodeURIComponent(token), { auth: false }).then(render).catch(function (e) { expired(e.status === 404 ? null : e.message); });
  var conn = SR.connect({ type: "share", token: token }, function (m) {
    if (m.type === "trip") render(m.trip);
    if (m.type === "error") { expired(m.error); conn.close(); }
  });
  setInterval(function () { SR.api("/api/share/" + encodeURIComponent(token), { auth: false }).then(render).catch(function (e) { if (e.status === 404) expired(); }); }, 20000);
})();
