/* SafeRoute live tracking map, used by the passenger page and the shared "follow my trip" page.
   - Real map of St. Vincent (Leaflet + OpenStreetMap) and a real road route (OSRM, with a fallback).
   - The taxi's position is worked out from the trip's start time, so anyone with the share link
     sees the same position at the same moment.
   - Route alerts: the passenger is asked "Are you OK?" if the taxi leaves the route or stops too long.
   - "Use my location" reads the phone's real GPS. */
(function () {
  "use strict";
  if (!window.L || !document.getElementById("map")) return;

  var MODE = document.body.getAttribute("data-track") || "passenger"; // "passenger" | "share"
  var PICKUP = { name: "Arnos Vale", lat: 13.1431, lng: -61.2117 };
  var DEST = { name: "Kingstown", lat: 13.1562, lng: -61.2276 };
  var FALLBACK = [
    [13.1431, -61.2117], [13.1446, -61.2139], [13.1462, -61.2163], [13.1478, -61.2188],
    [13.1497, -61.2212], [13.1518, -61.2236], [13.1538, -61.2256], [13.1562, -61.2276],
  ];
  var SPEED_UP = 3; // the demo trip runs 3× faster than real time
  var AVG_KMH = 32; // average town speed
  // Alert thresholds (real-world values; checked against demo time).
  var OFF_ROUTE_M = 150, OFF_ROUTE_S = 20, STOP_S = 180, ANSWER_S = 30;
  // Alert timers run a further 6× faster in the demo so the 3-minute stop alert shows up in about 10 seconds.
  var ALERT_SPEED_UP = 6;

  var $ = function (id) { return document.getElementById(id); };
  var setHTML = function (id, html) { var el = $(id); if (el) el.innerHTML = html; };
  var setText = function (id, t) { var el = $(id); if (el) el.textContent = t; };
  var toast = function (i, t) { if (typeof window.showToast === "function") window.showToast(i, t); };

  // ---------- trip clock ----------
  var params = new URLSearchParams(location.search);
  var trip;
  if (MODE === "share") {
    trip = { start: Number(params.get("t")) || Date.now(), pausedMs: 0 };
  } else {
    trip = window.SRSafety ? SRSafety.current(30 * 60 * 1000) : { start: Date.now(), pausedMs: 0 };
  }

  // ---------- map ----------
  var map = L.map("map", { zoomControl: false }).setView([PICKUP.lat, PICKUP.lng], 15);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, subdomains: "abc",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  var icon = function (html, cls, size) {
    size = size || [34, 34];
    return L.divIcon({ html: html, className: "sr-pin " + (cls || ""), iconSize: size, iconAnchor: [size[0] / 2, size[1] / 2] });
  };
  L.marker([PICKUP.lat, PICKUP.lng], { icon: icon("", "sr-pickup", [14, 14]), title: "Pickup" }).addTo(map).bindTooltip("Pickup · " + PICKUP.name);
  L.marker([DEST.lat, DEST.lng], { icon: icon("📍", "sr-dest"), title: "Destination" }).addTo(map)
    .bindTooltip(DEST.name, { permanent: true, direction: "right", offset: [14, 0], className: "sr-label" });
  var car = L.marker([PICKUP.lat, PICKUP.lng], { icon: icon("🚕", "sr-car", [38, 38]), zIndexOffset: 1000, title: "Taxi" }).addTo(map);
  var routeLine = null, doneLine = null;

  // ---------- geometry ----------
  var toRad = Math.PI / 180;
  function haversine(a, b) {
    var dLat = (b[0] - a[0]) * toRad, dLng = (b[1] - a[1]) * toRad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }
  /** Shortest distance in metres from point p to the route line. */
  function distToRoute(p) {
    var best = Infinity, kx = 111320 * Math.cos(p[0] * toRad), ky = 110540;
    for (var i = 1; i < pts.length; i++) {
      var ax = (pts[i - 1][1] - p[1]) * kx, ay = (pts[i - 1][0] - p[0]) * ky;
      var bx = (pts[i][1] - p[1]) * kx, by = (pts[i][0] - p[0]) * ky;
      var dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      var t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
      var cx = ax + t * dx, cy = ay + t * dy;
      best = Math.min(best, Math.sqrt(cx * cx + cy * cy));
    }
    return best;
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
    map.fitBounds(routeLine.getBounds(), MODE === "passenger" ? { paddingTopLeft: [190, 70], paddingBottomRight: [70, 110] } : { padding: [60, 60] });
  }
  function pointAt(d) {
    if (d <= 0) return { p: pts[0], i: 0, dir: [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]] };
    if (d >= total) return { p: pts[pts.length - 1], i: pts.length - 1, dir: [0, 0] };
    var i = 1;
    while (cum[i] < d) i++;
    var t = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    var a = pts[i - 1], b = pts[i];
    return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], i: i, dir: [b[0] - a[0], b[1] - a[1]] };
  }
  function fetchRoute(from, to) {
    var url = "https://router.project-osrm.org/route/v1/driving/" + from[1] + "," + from[0] + ";" + to[1] + "," + to[0] + "?overview=full&geometries=geojson";
    var ctrl = window.AbortController ? new AbortController() : null;
    setTimeout(function () { if (ctrl) ctrl.abort(); }, 7000);
    return fetch(url, ctrl ? { signal: ctrl.signal } : {})
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.routes || !j.routes.length) throw new Error("no route");
        return j.routes[0].geometry.coordinates.map(function (c) { return [c[1], c[0]]; });
      });
  }

  // ---------- where the taxi is, from the clock ----------
  // Real-world seconds since pickup (demo time runs SPEED_UP× faster), minus any stopped time.
  function tripSeconds(now) { return Math.max(0, ((now - trip.start - (trip.pausedMs || 0)) / 1000) * SPEED_UP); }
  function tripDuration() { return total / (AVG_KMH / 3.6); }
  // Slower at the start and end, faster in the middle; averages AVG_KMH.
  function progress(sec) {
    var u = Math.min(1, sec / tripDuration());
    return { d: total * (0.7 * u + 0.3 * (u - Math.sin(2 * Math.PI * u) / (2 * Math.PI))), kmh: u >= 1 ? 0 : AVG_KMH * (0.7 + 0.3 * (1 - Math.cos(2 * Math.PI * u))), done: u >= 1 };
  }

  // ---------- demo incidents (passenger page only) ----------
  var detour = null; // { start, length } in ms of page time
  var stopStart = null; // page time when an unplanned stop began
  function detourOffsetM(now) {
    if (!detour) return 0;
    var k = (now - detour.start) / detour.length;
    if (k >= 1) { detour = null; return 0; }
    return 420 * Math.sin(Math.PI * k); // drifts up to ~420 m off the road, then comes back
  }

  // ---------- alerts ----------
  var offSince = null, alertOpen = false, lastPos = null, stillSince = null, quietUntil = 0;
  function openAlert(kind) {
    if (MODE !== "passenger" || alertOpen || Date.now() < quietUntil) return;
    alertOpen = true;
    var title = kind === "route" ? "Your taxi has left the planned route" : "Your taxi has been stopped for over 3 minutes";
    var box = document.createElement("div");
    box.className = "sr-alert";
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    box.innerHTML =
      '<div><h2>⚠️ ' + title + "</h2><p>Are you OK? If you don't answer, your trusted contacts get your live trip link.</p>" +
      '<div class="sr-count" aria-live="polite"></div>' +
      '<button type="button" class="ok">✅ I\'m OK</button><button type="button" class="help">🆘 I need help</button></div>';
    var count = box.querySelector(".sr-count"), left = ANSWER_S;
    var tick = setInterval(function () {
      left--;
      count.textContent = "Alerting your contacts in " + left + " s";
      if (left <= 0) { finish(); toast("📣", "No answer, so your trusted contacts were sent your live link (demo)."); log("alert", "Contacts alerted"); }
    }, 1000);
    count.textContent = "Alerting your contacts in " + left + " s";
    function finish() { clearInterval(tick); box.remove(); alertOpen = false; quietUntil = Date.now() + 15000; }
    box.querySelector(".ok").addEventListener("click", function () { finish(); toast("✅", "Thanks. We'll keep watching the route."); log("alert", "Passenger OK"); });
    box.querySelector(".help").addEventListener("click", function () { finish(); if (window.triggerSOS) window.triggerSOS(); });
    document.body.appendChild(box);
    box.querySelector(".ok").focus();
    log("alert", kind === "route" ? "Off route" : "Long stop");
  }

  // ---------- GPS log ----------
  function log(kind, a, b) {
    var box = $("gpsLog"); if (!box) return;
    var row = document.createElement("div");
    row.className = "log-entry" + (kind === "alert" ? " log-alert" : "");
    row.innerHTML = '<span class="log-time"></span><span class="log-coords"></span><span class="log-speed"></span>';
    row.children[0].textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
    if (kind === "alert") { row.children[1].textContent = "⚠️ " + a; row.children[2].textContent = ""; }
    else { row.children[1].textContent = (kind === "you" ? "📍 " : "") + a[0].toFixed(5) + ", " + a[1].toFixed(5); row.children[2].textContent = b == null ? "—" : b + "km/h"; }
    box.insertBefore(row, box.firstChild);
    while (box.children.length > 8) box.removeChild(box.lastChild);
  }

  // ---------- animation loop ----------
  var arrived = false, sinceLog = 0, lastFrame = performance.now();
  function frame(now) {
    var dt = (now - lastFrame) / 1000; lastFrame = now;
    var wall = Date.now();
    if (stopStart !== null) trip.pausedMs = (trip.pausedBase || 0) + (wall - stopStart);
    if (total > 0) {
      var pr = progress(tripSeconds(wall));
      var at = pointAt(pr.d);
      var pos = at.p, kmh = stopStart !== null ? 0 : pr.kmh;
      var off = detourOffsetM(now);
      if (off && at.dir) {
        // push the taxi sideways off the road
        var kx = 111320 * Math.cos(pos[0] * toRad), ky = 110540;
        var vx = at.dir[1] * kx, vy = at.dir[0] * ky, len = Math.sqrt(vx * vx + vy * vy) || 1;
        pos = [pos[0] + (vx / len) * off / ky, pos[1] - (vy / len) * off / kx];
      }
      car.setLatLng(pos);
      doneLine.setLatLngs(pts.slice(0, at.i).concat([at.p]));
      var leftKm = (total - pr.d) / 1000, etaMin = Math.max(0, Math.round((leftKm / AVG_KMH) * 60));
      setText("speedVal", String(Math.round(kmh)));
      setText("distVal", leftKm.toFixed(1));
      setHTML("etaDist", leftKm.toFixed(1) + '<span class="unit"> km</span>');
      setHTML("etaMin", etaMin + '<span class="unit"> min</span>');
      setText("destEta", pr.done ? DEST.name + " — arrived" : DEST.name + " — ETA " + etaMin + " min");
      setText("shareStatus", pr.done ? "Arrived safely at " + DEST.name : "On the way to " + DEST.name + " · about " + etaMin + " min left");

      // Off-route check: real distance from the taxi to the route line.
      var demoDt = dt * SPEED_UP * ALERT_SPEED_UP;
      if (!pr.done && distToRoute(pos) > OFF_ROUTE_M) { offSince = (offSince || 0) + demoDt; if (offSince > OFF_ROUTE_S) openAlert("route"); }
      else offSince = 0;
      // Long-stop check: the taxi hasn't moved, mid-trip.
      if (!pr.done && lastPos && haversine(lastPos, pos) < 0.5 && pr.d > 20) { stillSince = (stillSince || 0) + demoDt; if (stillSince > STOP_S) openAlert("stop"); }
      else stillSince = 0;
      lastPos = pos;

      sinceLog += dt;
      if (sinceLog > 3 && !pr.done) { sinceLog = 0; log("taxi", pos, Math.round(kmh)); }
      if (pr.done && !arrived) {
        arrived = true;
        if (MODE === "passenger") {
          if (window.SRSafety) SRSafety.update({ ended: true });
          if (typeof window.showArrivalModal === "function") setTimeout(window.showArrivalModal, 800);
        }
      }
    }
    requestAnimationFrame(frame);
  }

  // ---------- your real location ----------
  var me = null, meRing = null, watchId = null;
  function locate() {
    if (!navigator.geolocation) { toast("⚠️", "This browser can't read your location."); return; }
    if (watchId !== null && me) { map.setView(me.getLatLng(), 16); return; }
    toast("📡", "Asking for your location…");
    watchId = navigator.geolocation.watchPosition(function (pos) {
      var c = pos.coords, ll = [c.latitude, c.longitude];
      if (!me) {
        me = L.marker(ll, { icon: icon("", "sr-me", [18, 18]), title: "You", zIndexOffset: 900 }).addTo(map).bindTooltip("You");
        meRing = L.circle(ll, { radius: c.accuracy, color: "#0080ff", weight: 1, fillOpacity: 0.12 }).addTo(map);
        var far = haversine(ll, [PICKUP.lat, PICKUP.lng]) > 40000;
        toast("📍", far ? "Found you. You're outside St. Vincent, so the demo trip stays in Kingstown." : "Found you. Your real GPS position is on the map.");
        map.setView(ll, far ? 13 : 16);
      } else { me.setLatLng(ll); meRing.setLatLng(ll).setRadius(c.accuracy); }
      setText("accVal", "±" + Math.round(c.accuracy) + "m");
      log("you", ll, c.speed != null && !isNaN(c.speed) ? Math.round(c.speed * 3.6) : null);
      var btn = $("locBtn"); if (btn) btn.classList.add("on");
    }, function (err) {
      watchId = null;
      toast("⚠️", err.code === 1 ? "Location permission was denied. Allow it in your browser settings." : "Couldn't get your location. Try again near a window.");
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  }

  // ---------- share link ----------
  function shareUrl() {
    var u = new URL("saferoute-share.html", location.href);
    u.searchParams.set("t", String(trip.start + (trip.pausedMs || 0)));
    return u.toString();
  }
  function share() {
    var url = shareUrl(), text = "Follow my SafeRoute taxi live: " + url;
    if (navigator.share) {
      navigator.share({ title: "Follow my SafeRoute trip", text: "Follow my taxi live until I arrive.", url: url }).catch(function () {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () { toast("📋", "Live trip link copied. Send it to someone you trust."); });
    } else {
      window.prompt("Copy this link:", url);
    }
  }

  // ---------- public hooks ----------
  window.SRTrack = {
    zoom: function (dir) { dir > 0 ? map.zoomIn() : map.zoomOut(); },
    locate: locate,
    share: share,
    shareUrl: shareUrl,
    finish: function () { trip.start = Date.now() - (tripDuration() / SPEED_UP) * 1000 - (trip.pausedMs || 0) - 1000; },
    simulateDetour: function () { detour = { start: performance.now(), length: 16000 }; quietUntil = 0; toast("🧪", "Test: the taxi is turning off the route…"); },
    simulateStop: function () {
      if (stopStart !== null) return;
      trip.pausedBase = trip.pausedMs || 0;
      stopStart = Date.now(); quietUntil = 0;
      toast("🧪", "Test: the taxi has stopped…");
      setTimeout(function () { stopStart = null; trip.pausedBase = trip.pausedMs; }, 25000);
    },
  };

  // ---------- start ----------
  if (MODE === "share" && (!params.get("t") || Date.now() - trip.start > 2 * 60 * 60 * 1000)) {
    setText("shareStatus", "This trip link has expired. Links stop working after the trip ends.");
    map.removeLayer(car);
    return;
  }
  setRoute(FALLBACK);
  setText("accVal", "—");
  setText("ridePin", trip.pin ? trip.pin.split("").join(" ") : "");
  var link = $("shareLinkText"); if (link) link.textContent = shareUrl().replace(/^https?:\/\//, "");
  fetchRoute([PICKUP.lat, PICKUP.lng], [DEST.lat, DEST.lng]).then(setRoute).catch(function () {});
  requestAnimationFrame(frame);
  window.addEventListener("resize", function () { map.invalidateSize(); });
})();
