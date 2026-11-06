/* SafeRoute driver trip page: shares the driver's GPS with the server and runs the trip steps
   (drive to pickup → arrive → passenger's PIN → ride → complete). */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var setText = function (id, t) { var el = $(id); if (el) el.textContent = t; };
  var show = function (id, on) { var el = $(id); if (el) el.hidden = !on; };
  var tt;
  function toast(msg) { var el = $("toast"); el.textContent = msg; el.classList.add("show"); clearTimeout(tt); tt = setTimeout(function () { el.classList.remove("show"); }, 3200); }
  var toRad = Math.PI / 180;
  function haversine(a, b) {
    var dLat = (b[0] - a[0]) * toRad, dLng = (b[1] - a[1]) * toRad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }
  var mapsLink = function (lat, lng) { return "https://www.google.com/maps/dir/?api=1&destination=" + lat + "," + lng; };

  SR.ready().then(function (live) {
    if (!live) {
      setText("stage", "This page needs the SafeRoute server");
      setText("stageSub", "Open SafeRoute from its live address to drive real trips.");
      return;
    }
    var u = SR.requireUser("driver");
    if (u) start(u);
  });

  function start(u) {
    var map = L.map("map", { zoomControl: false }).setView([13.17, -61.21], 12);
    L.control.zoom({ position: "topright" }).addTo(map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, subdomains: "abc",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
    var icon = function (html, cls, size) { size = size || [34, 34]; return L.divIcon({ html: html, className: "sr-pin " + (cls || ""), iconSize: size, iconAnchor: [size[0] / 2, size[1] / 2] }); };
    var pickupM, destM, routeLine, approachLine, car = null, fitted = false;
    var trip = null, myPos = null, lastSent = 0, sim = null;

    // ---------- render ----------
    function render(t) {
      var first = !trip;
      trip = t;
      // Send the position we already have straight away, so the passenger sees the taxi at once.
      if (first && myPos && t && ["accepted", "arrived", "in_progress"].indexOf(t.status) >= 0) setTimeout(function () { setPos(myPos, null, null, sim ? "sim" : "gps"); }, 0);
      ["actApproach", "actPin", "actRide", "actDone", "btnCancel", "tripCard", "alertCard"].forEach(function (id) { show(id, false); });
      if (!t || t.status === "cancelled") {
        setText("stage", t ? "Trip cancelled" : "No trip right now");
        setText("stageSub", t ? "The passenger or you cancelled this ride." : "Accept a ride request to start a trip.");
        show("actDone", true);
        stopSim();
        return;
      }
      var pick = [t.pickup.lat, t.pickup.lng], dest = [t.dest.lat, t.dest.lng];
      if (!pickupM) pickupM = L.marker(pick, { icon: icon("", "sr-pickup", [16, 16]), title: "Pickup" }).addTo(map).bindTooltip("Pickup · " + t.passengerName, { permanent: true, direction: "right", offset: [12, 0] });
      if (!destM) destM = L.marker(dest, { icon: icon("📍", ""), title: "Drop-off" }).addTo(map).bindTooltip(t.dest.name, { direction: "top" });
      if (!routeLine && t.route.length) routeLine = L.polyline(t.route, { color: "#0080ff", weight: 5, opacity: 0.6 }).addTo(map);
      if (!fitted) { var b = L.latLngBounds([pick, dest]); if (myPos) b.extend(myPos); map.fitBounds(b, { padding: [50, 50], animate: false }); fitted = true; }

      show("tripCard", true);
      setText("pName", t.passengerName);
      setText("pPickup", t.pickup.name);
      setText("pDest", t.dest.name);
      setText("pKm", t.routeKm + " km");
      setText("pFare", "EC$" + t.fareXcd);
      $("navPickup").href = mapsLink(t.pickup.lat, t.pickup.lng);
      $("navDest").href = mapsLink(t.dest.lat, t.dest.lng);

      if (t.status === "accepted") {
        var away = myPos ? haversine(myPos, pick) : null;
        setText("stage", "Drive to " + t.passengerName);
        setText("stageSub", "Pickup: " + t.pickup.name + (away != null ? " · " + (away / 1000).toFixed(1) + " km away" : ""));
        show("actApproach", true); show("btnCancel", true);
      } else if (t.status === "arrived") {
        setText("stage", "Ask " + t.passengerName + " for the PIN");
        setText("stageSub", "Enter the 4-digit PIN from their phone to start the trip.");
        show("actPin", true); show("btnCancel", true);
        if (t.pinAttemptsLeft === 0) { $("btnStart").disabled = true; setText("pinErr", "Too many wrong PINs. This trip can't start. Cancel it."); }
      } else if (t.status === "in_progress") {
        var left = myPos ? haversine(myPos, dest) : t.routeKm * 1000;
        setText("stage", "Driving to " + t.dest.name);
        setText("stageSub", (left / 1000).toFixed(1) + " km to go · route alerts are on");
        show("actRide", true);
      } else if (t.status === "completed") {
        setText("stage", "Trip complete ✓");
        setText("stageSub", "Fare EC$" + t.fareXcd + ". Location sharing has stopped.");
        show("actDone", true);
        stopSim();
      }
      if (t.alerts && t.alerts.length) {
        show("alertCard", true);
        setText("alertText", t.alerts[0].kind === "off_route"
          ? "SafeRoute noticed the trip has left the planned route. Your passenger has been asked if they're OK."
          : "SafeRoute noticed the taxi has been stopped for a while. Your passenger has been asked if they're OK.");
      }
      if (approachLine) { map.removeLayer(approachLine); approachLine = null; }
      if (myPos && t.status === "accepted") approachLine = L.polyline([myPos, pick], { color: "#ff9f43", weight: 3, opacity: 0.7, dashArray: "6 8" }).addTo(map);
    }

    // ---------- location ----------
    function setPos(ll, speedKmh, accuracyM, source) {
      myPos = ll;
      if (!car) car = L.marker(ll, { icon: icon("🚕", "sr-car", [38, 38]), zIndexOffset: 1000, title: "You" }).addTo(map);
      else car.setLatLng(ll);
      setText("spd", speedKmh != null ? String(Math.round(speedKmh)) : "0");
      setText("acc", accuracyM != null ? String(Math.round(accuracyM)) : "—");
      var pill = $("gpsPill");
      pill.textContent = source === "sim" ? "Test drive" : "GPS on";
      pill.className = "pill live";
      if (trip && ["accepted", "arrived", "in_progress"].indexOf(trip.status) >= 0 && Date.now() - lastSent > 2100) {
        lastSent = Date.now();
        SR.api("/api/trips/" + trip.id + "/location", { body: { lat: ll[0], lng: ll[1], speedKmh: speedKmh, accuracyM: accuracyM } })
          .catch(function (e) { if (e.status === 409) refresh(); });
      }
    }
    if (navigator.geolocation) {
      navigator.geolocation.watchPosition(function (p) {
        if (sim) return; // test drive in charge
        var c = p.coords;
        setPos([c.latitude, c.longitude], c.speed != null && !isNaN(c.speed) ? c.speed * 3.6 : null, c.accuracy, "gps");
      }, function (e) {
        var pill = $("gpsPill"); pill.textContent = e.code === 1 ? "GPS blocked" : "GPS weak"; pill.className = "pill";
        if (e.code === 1) toast("Location is blocked. Allow it in your browser settings so your passenger can see you, or turn on Test drive.");
      }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
    }
    // Keep the screen awake while driving, where supported.
    try { if (navigator.wakeLock) navigator.wakeLock.request("screen").catch(function () {}); } catch (e) {}

    // ---------- test drive ----------
    function pathForStage() {
      if (!trip) return null;
      if (trip.status === "in_progress") return trip.route;
      if (trip.status === "accepted") {
        // Approach from about 2 km along the route, back to the pickup.
        var pts = [trip.route[0]], d = 0;
        for (var i = 1; i < trip.route.length && d < 2000; i++) { d += haversine(trip.route[i - 1], trip.route[i]); pts.push(trip.route[i]); }
        return pts.reverse();
      }
      return null;
    }
    function startSim() {
      var path = pathForStage();
      if (!path || path.length < 2) { toast("Test drive works while driving to the pickup or during the ride."); setSimUI(false); return; }
      var i = 0, along = 0, kmh = 36, speedUp = 4, last = Date.now();
      var seg = function () { return haversine(path[i], path[i + 1]); };
      sim = setInterval(function () {
        var now = Date.now(), step = (kmh / 3.6) * ((now - last) / 1000) * speedUp; last = now;
        along += step;
        while (i < path.length - 2 && along > seg()) { along -= seg(); i++; }
        var s = Math.min(1, along / (seg() || 1)), a = path[i], b = path[i + 1];
        var p = [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
        setPos(p, kmh + Math.round(Math.sin(now / 1500) * 5), 5, "sim");
        if (i >= path.length - 2 && s >= 1) { stopSim(); toast(trip.status === "accepted" ? "You're at the pickup. Tap “I've arrived”." : "You're at the drop-off. Tap “Complete trip”."); }
      }, 1000);
      setSimUI(true);
    }
    function stopSim() { if (sim) clearInterval(sim); sim = null; setSimUI(false); }
    function setSimUI(on) { var t = $("simTog"); t.classList.toggle("on", on); t.setAttribute("aria-checked", String(on)); }
    $("simTog").addEventListener("click", function () { sim ? stopSim() : startSim(); });

    // ---------- actions ----------
    function act(path, body) {
      return SR.api("/api/trips/" + trip.id + path, { body: body || {} }).then(function (t) { if (t && t.id) render(t); return t; });
    }
    $("btnArrived").addEventListener("click", function () {
      var away = myPos ? haversine(myPos, [trip.pickup.lat, trip.pickup.lng]) : null;
      if (away != null && away > 300 && !window.confirm("You look " + (away / 1000).toFixed(1) + " km from the pickup. Mark yourself as arrived anyway?")) return;
      stopSim();
      act("/arrived").then(function () { toast("Your passenger has been told you're here."); }).catch(function (e) { toast(e.message); });
    });
    var inputs = Array.prototype.slice.call(document.querySelectorAll(".pin-in input"));
    inputs.forEach(function (inp, i) {
      inp.addEventListener("input", function () { inp.value = inp.value.replace(/\D/g, "").slice(-1); if (inp.value && inputs[i + 1]) inputs[i + 1].focus(); });
      inp.addEventListener("keydown", function (e) { if (e.key === "Backspace" && !inp.value && inputs[i - 1]) inputs[i - 1].focus(); if (e.key === "Enter") $("btnStart").click(); });
    });
    $("btnStart").addEventListener("click", function () {
      var pin = inputs.map(function (x) { return x.value; }).join("");
      if (pin.length < 4) { setText("pinErr", "Enter all 4 digits."); return; }
      setText("pinErr", "");
      act("/start", { pin: pin }).then(function () { toast("PIN matched. Trip started, drive safe."); inputs.forEach(function (x) { x.value = ""; }); })
        .catch(function (e) {
          inputs.forEach(function (x) { x.value = ""; }); inputs[0].focus();
          setText("pinErr", e.message);
          if (e.status === 423 || (e.data && e.data.attemptsLeft === 0)) $("btnStart").disabled = true;
        });
    });
    $("btnComplete").addEventListener("click", function () {
      if (!window.confirm("Complete this trip?")) return;
      stopSim();
      act("/complete").then(function () { toast("Trip complete. Thanks for driving safely!"); }).catch(function (e) { toast(e.message); });
    });
    $("btnCancel").addEventListener("click", function () {
      if (!window.confirm("Cancel this trip? The passenger will be told.")) return;
      stopSim();
      act("/cancel").catch(function (e) { toast(e.message); });
    });

    // ---------- start ----------
    function refresh() { return SR.api("/api/trips/current").then(function (t) { if (t || !trip) render(t); else if (trip) SR.api("/api/trips/" + trip.id).then(render); }).catch(function (e) { toast(e.message); }); }
    refresh();
    SR.connect({ type: "auth", token: SR.token() }, function (m) { if (m.type === "trip") render(m.trip); });
    setInterval(function () { if (trip && ["completed", "cancelled"].indexOf(trip.status) < 0) refresh(); }, 15000);
    window.addEventListener("resize", function () { map.invalidateSize(); });
  }
})();
