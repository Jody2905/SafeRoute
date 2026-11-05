/* SafeRoute live tracking map, used by the passenger page and the shared "follow my trip" page.

   A trip has three stages:
     1. approach – the driver drives to the passenger's pickup point (their real GPS location if shared)
     2. waiting  – the driver is at the pickup; the trip can't start until they enter the passenger's PIN
     3. ride     – pickup to Kingstown; route alerts are on
   Positions are worked out from the trip's clock, so the shared link shows the same place on any phone.
   Map: Leaflet + OpenStreetMap. Roads: OSRM routing service, with a straight-line fallback. */
(function () {
  "use strict";
  if (!window.L || !document.getElementById("map")) return;

  var MODE = document.body.getAttribute("data-track") || "passenger"; // "passenger" | "share"
  var DEST = { name: "Kingstown", lat: 13.1562, lng: -61.2276 };
  var DEFAULT_PICKUP = { name: "Arnos Vale", lat: 13.1431, lng: -61.2117, isDefault: true };
  // Used to label a GPS pickup point, e.g. "near Richland Park".
  var PLACES = [
    ["Kingstown", 13.1562, -61.2276], ["Arnos Vale", 13.1431, -61.2117], ["Calliaqua", 13.1296, -61.1925],
    ["Villa", 13.1335, -61.2010], ["Richland Park", 13.1878, -61.1826], ["Mesopotamia", 13.1715, -61.1755],
    ["Greiggs", 13.2060, -61.1760], ["Biabou", 13.1960, -61.1395], ["Georgetown", 13.2780, -61.1200],
    ["Layou", 13.2020, -61.2690], ["Barrouallie", 13.2380, -61.2690], ["Vermont", 13.1930, -61.2220],
    ["Campden Park", 13.1720, -61.2470], ["Brighton", 13.1230, -61.1730], ["Diamond", 13.1450, -61.1580],
    ["Peruvian Vale", 13.1630, -61.1420], ["Chateaubelair", 13.2900, -61.2440], ["Colonarie", 13.2380, -61.1360],
  ];
  var AVG_KMH = 32;
  var APPROACH_M = 3000; // the driver starts about 3 km away
  var OFF_ROUTE_M = 150, OFF_ROUTE_S = 20, STOP_S = 180, ANSWER_S = 30;
  var ALERT_SPEED_UP = 6; // alert timers run faster in the demo so you don't wait 3 minutes

  var $ = function (id) { return document.getElementById(id); };
  var setHTML = function (id, html) { var el = $(id); if (el) el.innerHTML = html; };
  var setText = function (id, t) { var el = $(id); if (el) el.textContent = t; };
  var toast = function (i, t) { if (typeof window.showToast === "function") window.showToast(i, t); };
  var fmtTime = function (ms) { return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); };

  // ---------- geometry ----------
  var toRad = Math.PI / 180;
  function haversine(a, b) {
    var dLat = (b[0] - a[0]) * toRad, dLng = (b[1] - a[1]) * toRad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }
  function nearestPlace(ll) {
    var best = null, bd = Infinity;
    PLACES.forEach(function (p) { var d = haversine(ll, [p[1], p[2]]); if (d < bd) { bd = d; best = p[0]; } });
    return best;
  }
  function Route(coords) {
    this.pts = coords; this.cum = [0];
    for (var i = 1; i < coords.length; i++) this.cum.push(this.cum[i - 1] + haversine(coords[i - 1], coords[i]));
    this.total = this.cum[this.cum.length - 1];
  }
  Route.prototype.at = function (d) {
    var pts = this.pts, cum = this.cum;
    if (d <= 0) return { p: pts[0], i: 0, dir: [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]] };
    if (d >= this.total) return { p: pts[pts.length - 1], i: pts.length - 1, dir: null };
    var i = 1;
    while (cum[i] < d) i++;
    var t = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1), a = pts[i - 1], b = pts[i];
    return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], i: i, dir: [b[0] - a[0], b[1] - a[1]] };
  };
  Route.prototype.distTo = function (p) {
    var best = Infinity, kx = 111320 * Math.cos(p[0] * toRad), ky = 110540, pts = this.pts;
    for (var i = 1; i < pts.length; i++) {
      var ax = (pts[i - 1][1] - p[1]) * kx, ay = (pts[i - 1][0] - p[0]) * ky, bx = (pts[i][1] - p[1]) * kx, by = (pts[i][0] - p[0]) * ky;
      var dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy, t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return best;
  };
  /** The first `metres` of this route, reversed: the driver's approach to the pickup. */
  Route.prototype.approachFrom = function (metres) {
    var end = this.at(Math.min(metres, this.total * 0.5)), pts = this.pts.slice(0, end.i).concat([end.p]);
    return new Route(pts.reverse());
  };
  function straight(a, b) {
    var out = [];
    for (var i = 0; i <= 10; i++) out.push([a[0] + (b[0] - a[0]) * i / 10, a[1] + (b[1] - a[1]) * i / 10]);
    return out;
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

  // ---------- trip state ----------
  var params = new URLSearchParams(location.search);
  var trip;
  if (MODE === "share") {
    var pp = (params.get("p") || "").split(",").map(Number);
    trip = {
      start: Number(params.get("a")) || 0,
      rideStart: Number(params.get("r")) || null,
      pickup: pp.length === 2 && !isNaN(pp[0]) ? { lat: pp[0], lng: pp[1], name: params.get("n") || nearestPlace(pp) } : DEFAULT_PICKUP,
      pausedMs: 0,
    };
  } else {
    trip = window.SRSafety ? SRSafety.current(45 * 60 * 1000) : { start: Date.now(), pausedMs: 0 };
    if (!trip.pickup) trip.pickup = DEFAULT_PICKUP;
  }
  var save = function (patch) { for (var k in patch) trip[k] = patch[k]; if (MODE === "passenger" && window.SRSafety) SRSafety.update(patch); };

  // Demo time runs faster than real time so a trip takes a couple of minutes to watch.
  function speedUp(route, demoSeconds) { return Math.max(3, (route.total / (AVG_KMH / 3.6)) / demoSeconds); }
  // Distance along a route after `sec` real-world seconds: slower at the ends, averaging AVG_KMH.
  function progress(route, sec) {
    var dur = route.total / (AVG_KMH / 3.6), u = Math.min(1, sec / dur);
    return { d: route.total * (0.7 * u + 0.3 * (u - Math.sin(2 * Math.PI * u) / (2 * Math.PI))), kmh: u >= 1 ? 0 : AVG_KMH * (0.7 + 0.3 * (1 - Math.cos(2 * Math.PI * u))), done: u >= 1, leftSec: Math.max(0, dur - sec) };
  }

  // ---------- map ----------
  var map = L.map("map", { zoomControl: false }).setView([trip.pickup.lat, trip.pickup.lng], 14);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, subdomains: "abc",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  var icon = function (html, cls, size) {
    size = size || [34, 34];
    return L.divIcon({ html: html, className: "sr-pin " + (cls || ""), iconSize: size, iconAnchor: [size[0] / 2, size[1] / 2] });
  };
  var pickupMarker = L.marker([trip.pickup.lat, trip.pickup.lng], { icon: icon("", "sr-pickup", [16, 16]), title: "Pickup" }).addTo(map);
  L.marker([DEST.lat, DEST.lng], { icon: icon("📍", "sr-dest"), title: "Destination" }).addTo(map)
    .bindTooltip(DEST.name, { permanent: true, direction: "right", offset: [14, 0], className: "sr-label" });
  var car = L.marker([trip.pickup.lat, trip.pickup.lng], { icon: icon("🚕", "sr-car", [38, 38]), zIndexOffset: 1000, title: "Taxi" }).addTo(map);
  var lines = [];

  var ride = null, approach = null, rideSpeed = 3, approachSpeed = 3;
  function draw() {
    lines.forEach(function (l) { map.removeLayer(l); });
    lines = [
      L.polyline(approach.pts, { color: "#ff9f43", weight: 4, opacity: 0.7, dashArray: "6 8" }).addTo(map),
      L.polyline(ride.pts, { color: "#0080ff", weight: 5, opacity: 0.55 }).addTo(map),
    ];
    doneLine = L.polyline([ride.pts[0]], { color: "#00e5a0", weight: 6, opacity: 0.95 }).addTo(map);
    lines.push(doneLine);
    pickupMarker.setLatLng([trip.pickup.lat, trip.pickup.lng]).unbindTooltip()
      .bindTooltip("Pickup · " + (trip.pickup.isDefault ? trip.pickup.name : "you, near " + trip.pickup.name), { direction: "top", offset: [0, -10] });
    var b = L.latLngBounds(ride.pts).extend(approach.pts);
    map.stop();
    map.fitBounds(b, MODE === "passenger" ? { paddingTopLeft: [190, 70], paddingBottomRight: [70, 120], animate: false } : { padding: [50, 50], animate: false });
  }
  var doneLine = null;
  function plan(coords) {
    ride = new Route(coords);
    approach = ride.approachFrom(APPROACH_M);
    rideSpeed = speedUp(ride, 150); // about 2½ minutes to watch the ride
    approachSpeed = speedUp(approach, 60); // about 1 minute for the driver to arrive
    draw();
  }
  function planRoute() {
    var from = [trip.pickup.lat, trip.pickup.lng], to = [DEST.lat, DEST.lng];
    plan(straight(from, to));
    return fetchRoute(from, to).then(plan).catch(function () { /* keep the straight-line fallback */ });
  }

  // ---------- incidents (tests) and alerts ----------
  var detour = null, stopStart = null, pausedBase = trip.pausedMs || 0, skipMs = 0;
  function detourOffsetM(now) {
    if (!detour) return 0;
    var k = (now - detour.start) / detour.length;
    if (k >= 1) { detour = null; return 0; }
    return 420 * Math.sin(Math.PI * k);
  }
  var offSince = 0, stillSince = 0, alertOpen = false, quietUntil = 0, lastPos = null;
  function openAlert(kind) {
    if (MODE !== "passenger" || alertOpen || Date.now() < quietUntil) return;
    alertOpen = true;
    var box = document.createElement("div");
    box.className = "sr-alert";
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    box.innerHTML =
      "<div><h2>⚠️ " + (kind === "route" ? "Your taxi has left the planned route" : "Your taxi has been stopped for over 3 minutes") + "</h2>" +
      "<p>Are you OK? If you don't answer, your trusted contacts get your live trip link.</p>" +
      '<div class="sr-count" aria-live="polite"></div><button type="button" class="ok">✅ I\'m OK</button><button type="button" class="help">🆘 I need help</button></div>';
    var count = box.querySelector(".sr-count"), left = ANSWER_S;
    function show() { count.textContent = "Alerting your contacts in " + left + " s"; }
    var timer = setInterval(function () { left--; show(); if (left <= 0) { finish(); toast("📣", "No answer, so your trusted contacts were sent your live link (demo)."); log("alert", "Contacts alerted"); } }, 1000);
    function finish() { clearInterval(timer); box.remove(); alertOpen = false; quietUntil = Date.now() + 15000; }
    box.querySelector(".ok").addEventListener("click", function () { finish(); toast("✅", "Thanks. We'll keep watching the route."); log("alert", "Passenger OK"); });
    box.querySelector(".help").addEventListener("click", function () { finish(); if (window.triggerSOS) window.triggerSOS(); });
    show();
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
    if (kind === "alert") row.children[1].textContent = "⚠️ " + a;
    else { row.children[1].textContent = (kind === "you" ? "📍 " : "") + a[0].toFixed(5) + ", " + a[1].toFixed(5); row.children[2].textContent = b == null ? "—" : b + "km/h"; }
    box.insertBefore(row, box.firstChild);
    while (box.children.length > 8) box.removeChild(box.lastChild);
  }

  // ---------- status panel ----------
  function step(n, state, label, sub) {
    var dot = $("step" + n + "Dot"), l = $("step" + n + "Label");
    if (dot) dot.className = "pt-dot" + (state === "done" ? " done" : state === "active" ? " active" : "");
    var con = $("step" + n + "Line"); if (con) con.className = "pt-connector" + (state === "done" ? " done" : "");
    if (l) { l.textContent = label; l.style.color = state === "active" ? "var(--accent2)" : state === "todo" ? "var(--muted)" : ""; }
    setText("step" + n + "Sub", sub);
  }
  var lastPhase = null;
  function showPhase(phase, info) {
    var pickName = trip.pickup.isDefault ? trip.pickup.name : "your location (near " + trip.pickup.name + ")";
    setText("fromName", trip.pickup.isDefault ? trip.pickup.name : "near " + trip.pickup.name);
    if (phase === "approach") {
      step(1, "active", "Driver on the way", "Marcus T. · H 4421 · arriving in " + info.min + " min");
      step(2, "todo", "Pickup", pickName);
      step(3, "todo", "Destination", DEST.name);
    } else if (phase === "waiting") {
      step(1, "done", "Driver arrived", "Waiting at the pickup point");
      step(2, "active", "Give your driver the PIN", "Check the plate is H 4421 first");
      step(3, "todo", "Destination", DEST.name);
    } else if (phase === "ride") {
      step(1, "done", "Driver arrived", "PIN checked ✓");
      step(2, "done", "Picked up", pickName + " — " + fmtTime(trip.rideStart));
      step(3, "active", "En route to " + DEST.name, "ETA " + info.min + " min");
    } else {
      step(1, "done", "Driver arrived", "PIN checked ✓");
      step(2, "done", "Picked up", pickName + " — " + fmtTime(trip.rideStart));
      step(3, "done", "Arrived", DEST.name);
    }
    if (phase === lastPhase) return;
    lastPhase = phase;
    var badge = $("rideBadge");
    if (badge) badge.textContent = { approach: "Driver en route", waiting: "At pickup", ride: "In progress", arrived: "Arrived" }[phase];
    setText("etaKey", phase === "ride" || phase === "arrived" ? "ETA" : "Pickup in");
    var banner = $("pickupBanner"); if (banner) banner.hidden = phase !== "waiting";
    var share = $("shareStatus");
    if (share && phase !== "ride") share.textContent = phase === "approach" ? "Driver on the way to pick her up" : phase === "waiting" ? "Driver is at the pickup point" : "Arrived safely at " + DEST.name;
    if (phase === "waiting") toast("🚕", "Your driver has arrived. Check the plate, then give them your PIN.");
    if (phase === "ride") toast("✅", "PIN matched. Your ride has started.");
  }

  // ---------- animation loop ----------
  var arrived = false, sinceLog = 0, lastFrame = performance.now();
  function frame(now) {
    var dt = (now - lastFrame) / 1000; lastFrame = now;
    var wall = Date.now();
    if (ride) {
      var phase, pos, kmh, leftM, min, on = null, along = null;
      if (!trip.rideStart) {
        var pa = progress(approach, ((wall - trip.start) / 1000) * approachSpeed);
        var at = approach.at(pa.d);
        pos = at.p; kmh = pa.kmh; leftM = approach.total - pa.d; min = Math.max(1, Math.round(pa.leftSec / 60));
        phase = pa.done ? "waiting" : "approach";
        on = approach; along = at;
      } else {
        if (stopStart !== null) trip.pausedMs = pausedBase + (wall - stopStart);
        var pr = progress(ride, ((wall - trip.rideStart - (trip.pausedMs || 0) + skipMs) / 1000) * rideSpeed);
        var rt = ride.at(pr.d);
        pos = rt.p; kmh = stopStart !== null ? 0 : pr.kmh; leftM = ride.total - pr.d; min = Math.round(pr.leftSec / 60);
        phase = pr.done ? "arrived" : "ride";
        on = ride; along = rt;
        doneLine.setLatLngs(ride.pts.slice(0, rt.i).concat([rt.p]));
        var off = detourOffsetM(now);
        if (off && rt.dir) {
          var kx = 111320 * Math.cos(pos[0] * toRad), ky = 110540, vx = rt.dir[1] * kx, vy = rt.dir[0] * ky, len = Math.hypot(vx, vy) || 1;
          pos = [pos[0] + (vx / len) * off / ky, pos[1] - (vy / len) * off / kx];
        }
        if (phase === "ride") {
          var demoDt = dt * rideSpeed * ALERT_SPEED_UP;
          offSince = ride.distTo(pos) > OFF_ROUTE_M ? offSince + demoDt : 0;
          if (offSince > OFF_ROUTE_S) openAlert("route");
          stillSince = lastPos && haversine(lastPos, pos) < 0.5 && pr.d > 20 ? stillSince + demoDt : 0;
          if (stillSince > STOP_S) openAlert("stop");
        }
        if (phase === "arrived" && !arrived) {
          arrived = true;
          if (MODE === "passenger") { save({ ended: true }); if (typeof window.showArrivalModal === "function") setTimeout(window.showArrivalModal, 800); }
        }
      }
      lastPos = pos;
      car.setLatLng(pos);
      var km = (leftM / 1000).toFixed(1);
      setText("speedVal", String(Math.round(phase === "waiting" ? 0 : kmh)));
      setText("distVal", km);
      setHTML("etaDist", km + '<span class="unit"> km</span>');
      setHTML("etaMin", (phase === "waiting" ? "Now" : min + '<span class="unit"> min</span>'));
      setHTML("elapsedMin", (trip.rideStart ? Math.max(0, Math.floor((wall - trip.rideStart) / 60000)) : 0) + '<span class="unit"> min</span>');
      setText("distKey", phase === "ride" || phase === "arrived" ? "Distance Left" : "Driver is");
      if (phase === "ride") setText("shareStatus", "On the way to " + DEST.name + " · about " + min + " min left");
      showPhase(phase, { min: min });
      sinceLog += dt;
      if (sinceLog > 3 && (phase === "approach" || phase === "ride")) { sinceLog = 0; log("taxi", pos, Math.round(kmh)); }
    }
    requestAnimationFrame(frame);
  }

  // ---------- your real location ----------
  var me = null, meRing = null, watchId = null;
  function usePickup(ll) {
    if (MODE !== "passenger" || trip.rideStart || !trip.pickup.isDefault) return false;
    if (haversine(ll, [DEST.lat, DEST.lng]) > 40000) return false; // outside St. Vincent
    save({ pickup: { lat: ll[0], lng: ll[1], name: nearestPlace(ll) }, start: Date.now() });
    planRoute();
    return true;
  }
  function locate(quiet) {
    if (!navigator.geolocation) { if (!quiet) toast("⚠️", "This browser can't read your location."); return; }
    if (watchId !== null && me) { map.setView(me.getLatLng(), 16); return; }
    if (!quiet) toast("📡", "Asking for your location…");
    watchId = navigator.geolocation.watchPosition(function (pos) {
      var c = pos.coords, ll = [c.latitude, c.longitude];
      if (!me) {
        me = L.marker(ll, { icon: icon("", "sr-me", [18, 18]), title: "You", zIndexOffset: 900 }).addTo(map).bindTooltip("You");
        meRing = L.circle(ll, { radius: c.accuracy, color: "#0080ff", weight: 1, fillOpacity: 0.12 }).addTo(map);
        if (usePickup(ll)) toast("📍", "Pickup set to your location near " + trip.pickup.name + ". Your driver is on the way.");
        else if (haversine(ll, [DEST.lat, DEST.lng]) > 40000) toast("📍", "Found you. You're outside St. Vincent, so the demo pickup stays at " + trip.pickup.name + ".");
        else toast("📍", "Found you. Your real GPS position is the blue dot.");
      } else { me.setLatLng(ll); meRing.setLatLng(ll).setRadius(c.accuracy); }
      setText("accVal", String(Math.round(c.accuracy)));
      log("you", ll, c.speed != null && !isNaN(c.speed) ? Math.round(c.speed * 3.6) : null);
      var btn = $("locBtn"); if (btn) btn.classList.add("on");
    }, function (err) {
      watchId = null;
      if (!quiet || err.code !== 1) toast("⚠️", err.code === 1 ? "Location is off, so the demo pickup is " + trip.pickup.name + ". Tap “Use my location” to change it." : "Couldn't get your location. Try again near a window.");
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  }

  // ---------- share link ----------
  function shareUrl() {
    var u = new URL("saferoute-share.html", location.href);
    u.searchParams.set("a", String(trip.start));
    if (trip.rideStart) u.searchParams.set("r", String(trip.rideStart + (trip.pausedMs || 0)));
    if (!trip.pickup.isDefault) {
      u.searchParams.set("p", trip.pickup.lat.toFixed(5) + "," + trip.pickup.lng.toFixed(5));
      u.searchParams.set("n", trip.pickup.name);
    }
    return u.toString();
  }
  function share() {
    var url = shareUrl();
    var el = $("shareLinkText"); if (el) el.textContent = url.replace(/^https?:\/\//, "");
    if (navigator.share) navigator.share({ title: "Follow my SafeRoute trip", text: "Follow my taxi live until I arrive.", url: url }).catch(function () {});
    else if (navigator.clipboard) navigator.clipboard.writeText("Follow my SafeRoute taxi live: " + url).then(function () { toast("📋", "Live trip link copied. Send it to someone you trust."); });
    else window.prompt("Copy this link:", url);
  }

  // ---------- public hooks ----------
  var needRide = function () { if (!trip.rideStart) { toast("ℹ️", "Route alerts start once you're in the taxi (after the PIN check)."); return true; } return false; };
  window.SRTrack = {
    zoom: function (dir) { dir > 0 ? map.zoomIn() : map.zoomOut(); },
    locate: function () { locate(false); },
    share: share,
    shareUrl: shareUrl,
    /** Demo: act as the driver at the pickup and enter the PIN on this phone. */
    driverPin: function () {
      if (!window.SRSafety) return;
      SRSafety.askPin(function () { trip = SRSafety.current(); if (!trip.pickup) trip.pickup = DEFAULT_PICKUP; pausedBase = 0; refreshPin(); }, { passenger: "Jody-Ann" });
    },
    finish: function () {
      if (!trip.rideStart) { toast("ℹ️", "The ride hasn't started yet."); return; }
      skipMs = ((ride.total / (AVG_KMH / 3.6)) / rideSpeed) * 1000 + 1000; // jump to the end without changing the pickup time
    },
    simulateDetour: function () { if (needRide()) return; detour = { start: performance.now(), length: 16000 }; quietUntil = 0; toast("🧪", "Test: the taxi is turning off the route…"); },
    simulateStop: function () {
      if (needRide() || stopStart !== null) return;
      pausedBase = trip.pausedMs || 0; stopStart = Date.now(); quietUntil = 0;
      toast("🧪", "Test: the taxi has stopped…");
      setTimeout(function () { stopStart = null; pausedBase = trip.pausedMs; }, 25000);
    },
  };

  function refreshPin() {
    setText("ridePin", trip.pin ? trip.pin.split("").join(" ") : "");
    var el = $("pinStatus");
    if (el) { el.className = "pin-status " + (trip.pinVerified ? "ok" : "wait"); el.textContent = trip.pinVerified ? "✓ Your driver entered the right PIN" : "Give it to your driver when they arrive"; }
  }

  // ---------- start ----------
  if (MODE === "share" && (!trip.start || Date.now() - trip.start > 2 * 60 * 60 * 1000)) {
    setText("shareStatus", "This trip link has expired. Links stop working after the trip ends.");
    map.removeLayer(car);
    return;
  }
  setText("accVal", "—");
  refreshPin();
  var linkEl = $("shareLinkText"); if (linkEl) linkEl.textContent = shareUrl().replace(/^https?:\/\//, "");
  planRoute();
  requestAnimationFrame(frame);
  if (MODE === "passenger") locate(true); // ask for the real location straight away; the pickup moves there
  window.addEventListener("resize", function () { map.invalidateSize(); });
})();
