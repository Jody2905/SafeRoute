/* SafeRoute live tracking map.
   - Real map of St. Vincent (Leaflet + OpenStreetMap).
   - Real road route from the OSRM routing service, with a built-in fallback route if it can't be reached.
   - Demo trip: the taxi moves along the real route at a realistic speed (sped up so you can watch it).
   - "Use my location" reads your phone's real GPS: position, accuracy and speed. */
(function () {
  "use strict";
  if (!window.L || !document.getElementById("map")) return;

  var PICKUP = { name: "Arnos Vale", lat: 13.1431, lng: -61.2117 };
  var DEST = { name: "Kingstown", lat: 13.1562, lng: -61.2276 };
  // Used only if the routing service can't be reached: roughly follows the road into Kingstown.
  var FALLBACK = [
    [13.1431, -61.2117], [13.1446, -61.2139], [13.1462, -61.2163], [13.1478, -61.2188],
    [13.1497, -61.2212], [13.1518, -61.2236], [13.1538, -61.2256], [13.1562, -61.2276],
  ];
  var SPEED_UP = 6; // demo runs 6× faster than real time
  var CRUISE_KMH = 38; // typical town speed

  var $ = function (id) { return document.getElementById(id); };
  var setHTML = function (id, html) { var el = $(id); if (el) el.innerHTML = html; };
  var setText = function (id, t) { var el = $(id); if (el) el.textContent = t; };

  // ---------- map ----------
  var map = L.map("map", { zoomControl: false, attributionControl: true }).setView([PICKUP.lat, PICKUP.lng], 15);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    subdomains: "abc",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  var icon = function (html, cls, size) {
    return L.divIcon({ html: html, className: "sr-pin " + (cls || ""), iconSize: size || [34, 34], iconAnchor: [(size || [34, 34])[0] / 2, (size || [34, 34])[1] / 2] });
  };
  L.marker([PICKUP.lat, PICKUP.lng], { icon: icon("", "sr-pickup", [14, 14]), title: "Pickup" }).addTo(map).bindTooltip("Pickup · " + PICKUP.name);
  L.marker([DEST.lat, DEST.lng], { icon: icon("📍", "sr-dest"), title: "Destination" }).addTo(map)
    .bindTooltip(DEST.name, { permanent: true, direction: "right", offset: [14, 0], className: "sr-label" });
  var car = L.marker([PICKUP.lat, PICKUP.lng], { icon: icon("🚕", "sr-car", [38, 38]), zIndexOffset: 1000, title: "Your driver" }).addTo(map);

  var routeLine = null, doneLine = null;

  // ---------- geometry ----------
  function haversine(a, b) {
    var R = 6371000, toRad = Math.PI / 180;
    var dLat = (b[0] - a[0]) * toRad, dLng = (b[1] - a[1]) * toRad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  var pts = [], cum = [], total = 0;
  function setRoute(coords) {
    pts = coords; cum = [0];
    for (var i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
    total = cum[cum.length - 1];
    if (routeLine) map.removeLayer(routeLine);
    if (doneLine) map.removeLayer(doneLine);
    routeLine = L.polyline(pts, { color: "#0080ff", weight: 5, opacity: 0.55 }).addTo(map);
    doneLine = L.polyline([pts[0]], { color: "#00e5a0", weight: 6, opacity: 0.95 }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [60, 60] });
  }
  // Point at distance d (metres) along the route.
  function pointAt(d) {
    if (d <= 0) return { p: pts[0], i: 0 };
    if (d >= total) return { p: pts[pts.length - 1], i: pts.length - 1 };
    var i = 1;
    while (cum[i] < d) i++;
    var t = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return { p: [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t], i: i };
  }

  function fetchRoute(from, to) {
    var url = "https://router.project-osrm.org/route/v1/driving/" + from[1] + "," + from[0] + ";" + to[1] + "," + to[0] + "?overview=full&geometries=geojson";
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 7000);
    return fetch(url, ctrl ? { signal: ctrl.signal } : {})
      .then(function (r) { return r.json(); })
      .then(function (j) {
        clearTimeout(timer);
        if (!j.routes || !j.routes.length) throw new Error("no route");
        return j.routes[0].geometry.coordinates.map(function (c) { return [c[1], c[0]]; });
      });
  }

  // ---------- simulated trip ----------
  var travelled = 0, active = true, speedKmh = 0, last = performance.now(), sinceLog = 0;
  function tick(now) {
    var dt = Math.min(0.25, (now - last) / 1000); last = now;
    if (active && total > 0) {
      // Speed varies gently, slowing near the start and end like real traffic.
      var frac = travelled / total;
      var target = CRUISE_KMH * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, Math.max(0, frac)))) + 6 * Math.sin(now / 2300);
      speedKmh += (target - speedKmh) * Math.min(1, dt * 1.5);
      travelled = Math.min(total, travelled + (speedKmh / 3.6) * dt * SPEED_UP);
      var at = pointAt(travelled);
      car.setLatLng(at.p);
      doneLine.setLatLngs(pts.slice(0, at.i).concat([at.p]));
      var leftKm = (total - travelled) / 1000;
      var etaMin = Math.max(0, Math.round((leftKm / CRUISE_KMH) * 60));
      setText("speedVal", String(Math.round(speedKmh)));
      setText("distVal", leftKm.toFixed(1));
      setHTML("etaDist", leftKm.toFixed(1) + '<span class="unit"> km</span>');
      setHTML("etaMin", etaMin + '<span class="unit"> min</span>');
      setText("destEta", DEST.name + " — ETA " + etaMin + " min");
      sinceLog += dt;
      if (sinceLog > 3) { sinceLog = 0; logFix(at.p, Math.round(speedKmh), "taxi"); }
      if (travelled >= total) {
        active = false;
        setText("speedVal", "0");
        if (typeof window.showArrivalModal === "function") setTimeout(window.showArrivalModal, 800);
      }
    }
    requestAnimationFrame(tick);
  }

  // ---------- GPS log ----------
  function logFix(p, kmh, who) {
    var box = $("gpsLog"); if (!box) return;
    var time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    var row = document.createElement("div");
    row.className = "log-entry";
    row.innerHTML = '<span class="log-time"></span><span class="log-coords"></span><span class="log-speed"></span>';
    row.children[0].textContent = time;
    row.children[1].textContent = (who === "you" ? "📍 " : "") + p[0].toFixed(5) + ", " + p[1].toFixed(5);
    row.children[2].textContent = kmh == null ? "—" : kmh + "km/h";
    box.insertBefore(row, box.firstChild);
    while (box.children.length > 8) box.removeChild(box.lastChild);
  }

  // ---------- your real location ----------
  var me = null, meRing = null, watchId = null;
  function locate() {
    if (!navigator.geolocation) { toast("⚠️", "This browser can't read your location."); return; }
    if (watchId !== null) { map.setView(me.getLatLng(), 16); return; }
    toast("📡", "Asking for your location…");
    watchId = navigator.geolocation.watchPosition(function (pos) {
      var c = pos.coords, ll = [c.latitude, c.longitude];
      if (!me) {
        me = L.marker(ll, { icon: icon("", "sr-me", [18, 18]), title: "You", zIndexOffset: 900 }).addTo(map).bindTooltip("You");
        meRing = L.circle(ll, { radius: c.accuracy, color: "#0080ff", weight: 1, fillOpacity: 0.12 }).addTo(map);
        var far = haversine(ll, [PICKUP.lat, PICKUP.lng]) > 40000;
        toast("📍", far ? "Found you. You're outside St. Vincent, so the demo trip stays in Kingstown." : "Found you. Your real GPS position is on the map.");
        map.setView(ll, far ? 13 : 16);
      } else {
        me.setLatLng(ll); meRing.setLatLng(ll).setRadius(c.accuracy);
      }
      setText("accVal", "±" + Math.round(c.accuracy) + "m");
      var kmh = c.speed != null && !isNaN(c.speed) ? Math.round(c.speed * 3.6) : null;
      logFix(ll, kmh, "you");
      var btn = $("locBtn"); if (btn) btn.classList.add("on");
    }, function (err) {
      watchId = null;
      toast("⚠️", err.code === 1 ? "Location permission was denied. Allow it in your browser settings." : "Couldn't get your location. Try again near a window.");
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  }

  function toast(i, t) { if (typeof window.showToast === "function") window.showToast(i, t); }

  // ---------- public hooks used by the page ----------
  window.SRTrack = {
    zoom: function (dir) { dir > 0 ? map.zoomIn() : map.zoomOut(); },
    locate: locate,
    finish: function () { travelled = total; },
    position: function () { return car.getLatLng(); },
  };

  // ---------- start ----------
  setRoute(FALLBACK);
  setText("accVal", "—");
  fetchRoute([PICKUP.lat, PICKUP.lng], [DEST.lat, DEST.lng])
    .then(function (coords) { if (travelled < 30) setRoute(coords); })
    .catch(function () { /* keep the fallback route */ });
  requestAnimationFrame(tick);
  window.addEventListener("resize", function () { map.invalidateSize(); });
})();
