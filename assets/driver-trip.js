/* SafeRoute driver trip page. Shares the driver's GPS with the server and runs each booking's steps
   (drive to pickup → arrive → passenger's PIN → ride → complete). A shared ride has several bookings
   in the car at once: each gets its own card, and the driver picks which one the buttons act on. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var setText = function (id, t) { var el = $(id); if (el) el.textContent = t; };
  var show = function (id, on) { var el = $(id); if (el) el.hidden = !on; };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var tt;
  function toast(msg) { var el = $("toast"); el.textContent = msg; el.classList.add("show"); clearTimeout(tt); tt = setTimeout(function () { el.classList.remove("show"); }, 3600); }
  var toRad = Math.PI / 180;
  function haversine(a, b) {
    var dLat = (b[0] - a[0]) * toRad, dLng = (b[1] - a[1]) * toRad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }
  var mapsLink = function (lat, lng) { return "https://www.google.com/maps/dir/?api=1&destination=" + lat + "," + lng; };
  var LIVE = ["accepted", "arrived", "in_progress"];
  var isLive = function (t) { return t && LIVE.indexOf(t.status) >= 0; };
  var STATUS = { accepted: "Pick up", arrived: "Waiting · PIN", in_progress: "On board", completed: "Dropped off", cancelled: "Cancelled" };

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

    var trips = {};          // id → booking view (active ones, plus the last one that just ended)
    var layers = {};         // id → Leaflet layer group for that booking
    var focusId = null, chosen = false, last = null;
    var car = null, approachLine = null, fitted = false;
    var myPos = null, lastSent = 0, sim = null, gps = "off";

    var active = function () { return Object.keys(trips).map(function (k) { return trips[k]; }).filter(isLive); };
    var focus = function () { return trips[focusId] || null; };

    // ---------- map layers per booking ----------
    function drawTrip(t) {
      if (layers[t.id]) { map.removeLayer(layers[t.id]); delete layers[t.id]; }
      if (!isLive(t)) return;
      var g = L.layerGroup().addTo(map), on = t.id === focusId;
      if (t.route && t.route.length) L.polyline(t.route, { color: "#0080ff", weight: on ? 5 : 3, opacity: on ? 0.65 : 0.3 }).addTo(g);
      if (t.status !== "in_progress") L.marker([t.pickup.lat, t.pickup.lng], { icon: icon("", "sr-pickup", [16, 16]), title: "Pickup" }).addTo(g)
        .bindTooltip("Pickup · " + t.passengerName, { permanent: on, direction: "right", offset: [12, 0] });
      (t.stops || []).forEach(function (s, i) {
        L.marker([s.lat, s.lng], { icon: icon("", "sr-stop", [14, 14]), title: "Stop" }).addTo(g).bindTooltip("Stop " + (i + 1) + " · " + s.name, { direction: "top" });
      });
      L.marker([t.dest.lat, t.dest.lng], { icon: icon("📍", ""), title: "Drop-off" }).addTo(g).bindTooltip(t.passengerName + " → " + t.dest.name, { direction: "top" });
      layers[t.id] = g;
    }
    function fitAll() {
      var pts = [];
      active().forEach(function (t) { pts.push([t.pickup.lat, t.pickup.lng], [t.dest.lat, t.dest.lng]); });
      if (myPos) pts.push(myPos);
      if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [50, 50], animate: false, maxZoom: 16 });
    }

    // ---------- choosing which booking the buttons act on ----------
    function pickFocus() {
      var cur = focus();
      if (chosen && isLive(cur)) return;
      chosen = false;
      var list = active();
      if (!list.length) return;
      var dist = function (t, which) { return myPos ? haversine(myPos, which === "dest" ? [t.dest.lat, t.dest.lng] : [t.pickup.lat, t.pickup.lng]) : 0; };
      var by = function (status, which) { return list.filter(function (t) { return t.status === status; }).sort(function (a, b) { return dist(a, which) - dist(b, which); })[0]; };
      // Waiting passengers first, then the next pickup, then the nearest drop-off.
      var next = by("arrived") || by("accepted") || by("in_progress", "dest");
      if (next && next.id !== focusId) { focusId = next.id; resetPin(); }
    }
    function choose(id) { focusId = id; chosen = true; resetPin(); renderAll(); }

    // ---------- render ----------
    function update(t) {
      if (!t || !t.id) return;
      var was = trips[t.id];
      trips[t.id] = t;
      if (!isLive(t)) {
        last = t;
        if (was && isLive(was) && t.status === "cancelled") toast(t.passengerName + "'s booking was cancelled.");
      }
    }
    function renderAll() {
      // Bookings that ended drop out of the list once another booking needs the screen.
      Object.keys(trips).forEach(function (k) { if (!isLive(trips[k]) && (active().length || k !== (last && last.id))) delete trips[k]; });
      pickFocus();
      var list = active();
      Object.keys(layers).forEach(function (k) { if (!trips[k]) { map.removeLayer(layers[k]); delete layers[k]; } });
      Object.keys(trips).forEach(function (k) { drawTrip(trips[k]); });
      if (!fitted && list.length) { fitAll(); fitted = true; }

      // List of bookings (only when there's more than one).
      show("bookingsCard", list.length > 1);
      if (list.length > 1) {
        var seats = list.reduce(function (s, t) { return s + t.partySize; }, 0), cap = u.driver && u.driver.seats;
        setText("bookingsTitle", "Passengers in your car · " + seats + (cap ? " of " + cap + " seats" : " seats"));
        $("bookings").innerHTML = list.map(function (t, i) {
          return '<button class="bk' + (t.id === focusId ? " on" : "") + '" data-id="' + esc(t.id) + '"><span class="n">' + (i + 1) + "</span><span><b>" + esc(t.passengerName) + "</b>" +
            (t.partySize > 1 ? " +" + (t.partySize - 1) : "") + '<br><span style="color:var(--muted)">' + esc(t.status === "in_progress" ? "to " + t.dest.name : "at " + t.pickupName) + '</span></span><span class="s">' + STATUS[t.status] + "</span></button>";
        }).join("");
      }
      renderFocus(focus() || last);
    }

    function renderFocus(t) {
      ["actApproach", "actPin", "actRide", "actDone", "btnCancel", "tripCard", "alertCard"].forEach(function (id) { show(id, false); });
      if (approachLine) { map.removeLayer(approachLine); approachLine = null; }
      if (!t || !isLive(t)) {
        stopSim();
        if (!t) { setText("stage", "No trip right now"); setText("stageSub", "Accept a ride request to start a trip."); }
        else if (t.status === "cancelled") { setText("stage", "Trip cancelled"); setText("stageSub", "The passenger or you cancelled this ride."); }
        else { setText("stage", "Trip complete ✓"); setText("stageSub", "Fare EC$" + t.fareXcd + ". Location sharing has stopped."); }
        show("actDone", true);
        return;
      }
      var pick = [t.pickup.lat, t.pickup.lng], dest = [t.dest.lat, t.dest.lng];
      show("tripCard", true);
      setText("pName", t.passengerName);
      setText("pPickup", t.pickup.name);
      show("pStopsRow", (t.stops || []).length > 0);
      setText("pStops", (t.stops || []).map(function (s) { return s.name; }).join(", "));
      setText("pDest", t.dest.name + (t.earlyDropoff ? " (booked to " + t.earlyDropoff.bookedDest + ")" : ""));
      setText("pParty", t.partySize === 1 ? "1" : t.partySize + " (" + t.passengerName + " + " + (t.partySize - 1) + ")");
      setText("pKind", t.shared ? "Shared ride" : t.openRoute ? "Open route" : "Private ride 🔒");
      setText("pKm", t.routeKm + " km");
      setText("pFare", "EC$" + t.fareXcd + (t.shared ? " (shared price)" : ""));
      $("navPickup").href = mapsLink(t.pickup.lat, t.pickup.lng);
      var nextStop = t.status === "in_progress" && (t.stops || []).length ? t.stops[0] : null;
      $("navDest").href = mapsLink(t.dest.lat, t.dest.lng);
      var others = active().length - 1, also = others > 0 ? " · " + others + " other booking" + (others === 1 ? "" : "s") + " in your car" : "";

      if (t.status === "accepted") {
        var away = myPos ? haversine(myPos, pick) : null;
        setText("stage", "Drive to " + t.passengerName);
        setText("stageSub", "Pickup: " + t.pickup.name + (away != null ? " · " + (away / 1000).toFixed(1) + " km away" : "") + also);
        show("actApproach", true); show("btnCancel", true);
        if (myPos) approachLine = L.polyline([myPos, pick], { color: "#ff9f43", weight: 3, opacity: 0.7, dashArray: "6 8" }).addTo(map);
      } else if (t.status === "arrived") {
        setText("stage", "Ask " + t.passengerName + " for the PIN");
        setText("stageSub", "Enter the 4-digit PIN from their phone to start their trip." + also);
        show("actPin", true); show("btnCancel", true);
        $("btnStart").disabled = t.pinAttemptsLeft === 0;
        if (t.pinAttemptsLeft === 0) setText("pinErr", "Too many wrong PINs. This trip can't start. Cancel it.");
      } else {
        var left = myPos ? haversine(myPos, dest) : t.routeKm * 1000;
        setText("stage", "Driving " + t.passengerName + " to " + t.dest.name);
        setText("stageSub", (left / 1000).toFixed(1) + " km to go" + (nextStop ? " · stop at " + nextStop.name + " on the way" : "") + also);
        show("actRide", true);
        setText("btnComplete", "🏁 Drop off " + t.passengerName);
      }
      if (t.alerts && t.alerts.length) {
        show("alertCard", true);
        setText("alertText", t.alerts[0].kind === "off_route"
          ? "SafeRoute noticed the trip has left the planned route. Your passenger has been asked if they're OK."
          : "SafeRoute noticed the taxi has been stopped for a while. Your passenger has been asked if they're OK.");
      }
    }
    $("bookings").addEventListener("click", function (e) { var b = e.target.closest("[data-id]"); if (b) choose(b.dataset.id); });

    // ---------- location ----------
    function setPill() {
      var pill = $("gpsPill");
      var label = sim ? "Test drive" : { on: "GPS on", blocked: "GPS blocked", weak: "GPS weak", off: "GPS off" }[gps];
      pill.textContent = label;
      pill.className = "pill" + (sim || gps === "on" ? " live" : "");
    }
    function setPos(ll, speedKmh, accuracyM) {
      myPos = ll;
      if (!car) car = L.marker(ll, { icon: icon("🚕", "sr-car", [38, 38]), zIndexOffset: 1000, title: "You" }).addTo(map);
      else car.setLatLng(ll);
      setText("spd", speedKmh != null ? String(Math.round(speedKmh)) : "0");
      setText("acc", accuracyM != null ? String(Math.round(accuracyM)) : "—");
      setPill();
      if (approachLine) approachLine.setLatLngs([ll, approachLine.getLatLngs()[1]]);
      if (active().length && Date.now() - lastSent > 2100) {
        lastSent = Date.now();
        SR.api("/api/driver/location", { body: { lat: ll[0], lng: ll[1], speedKmh: speedKmh, accuracyM: accuracyM } })
          .catch(function (e) { if (e.status === 409) refresh(); });
      }
    }
    if (navigator.geolocation) {
      navigator.geolocation.watchPosition(function (p) {
        gps = "on";
        if (sim) return setPill(); // test drive in charge
        var c = p.coords;
        setPos([c.latitude, c.longitude], c.speed != null && !isNaN(c.speed) ? c.speed * 3.6 : null, c.accuracy);
      }, function (e) {
        gps = e.code === 1 ? "blocked" : "weak"; setPill();
        if (e.code === 1) toast("Location is blocked. Allow it in your browser settings so your passenger can see you, or turn on Test drive.");
      }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
    }
    try { if (navigator.wakeLock) navigator.wakeLock.request("screen").catch(function () {}); } catch (e) {}

    // ---------- test drive ----------
    function nearestIndex(route, p) {
      var best = 0, bd = Infinity;
      route.forEach(function (q, i) { var d = haversine(p, q); if (d < bd) { bd = d; best = i; } });
      return best;
    }
    function pathForStage() {
      var t = focus();
      if (!t) return null;
      if (t.status === "in_progress") return myPos ? [myPos].concat(t.route.slice(nearestIndex(t.route, myPos) + 1)) : t.route;
      if (t.status === "accepted") {
        var pick = [t.pickup.lat, t.pickup.lng];
        // Already driving someone: head straight from here to the next pickup.
        if (myPos && active().length > 1) return [myPos, pick];
        // Otherwise approach from about 2 km along the route, back to the pickup.
        var pts = [t.route[0]], d = 0;
        for (var i = 1; i < t.route.length && d < 2000; i++) { d += haversine(t.route[i - 1], t.route[i]); pts.push(t.route[i]); }
        return pts.reverse();
      }
      return null;
    }
    function startSim() {
      var path = pathForStage();
      if (!path || path.length < 2) { toast("Test drive works while driving to a pickup or during a ride."); setSimUI(false); return; }
      var i = 0, along = 0, kmh = 36, speedUp = 4, lastT = Date.now(), forId = focusId;
      var seg = function () { return haversine(path[i], path[i + 1]); };
      sim = setInterval(function () {
        var now = Date.now(), step = (kmh / 3.6) * ((now - lastT) / 1000) * speedUp; lastT = now;
        along += step;
        while (i < path.length - 2 && along > seg()) { along -= seg(); i++; }
        var s = Math.min(1, along / (seg() || 1)), a = path[i], b = path[i + 1];
        setPos([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s], kmh + Math.round(Math.sin(now / 1500) * 5), 5);
        if (i >= path.length - 2 && s >= 1) {
          var t = trips[forId];
          stopSim();
          if (t) toast(t.status === "accepted" ? "You're at " + t.passengerName + "'s pickup. Tap “I've arrived”." : "You're at " + t.passengerName + "'s drop-off. Tap “Drop off”.");
        }
      }, 1000);
      setSimUI(true);
    }
    function stopSim() { if (sim) clearInterval(sim); sim = null; setSimUI(false); }
    function setSimUI(on) { var t = $("simTog"); t.classList.toggle("on", on); t.setAttribute("aria-checked", String(on)); setPill(); }
    $("simTog").addEventListener("click", function () { sim ? stopSim() : startSim(); });

    // ---------- actions (always on the booking shown) ----------
    function act(path, body) {
      var t = focus();
      if (!t) return Promise.reject(new Error("No booking selected"));
      return SR.api("/api/trips/" + t.id + path, { body: body || {} }).then(function (v) { if (v && v.id) { update(v); renderAll(); } return v; });
    }
    $("btnArrived").addEventListener("click", function () {
      var t = focus(), away = myPos ? haversine(myPos, [t.pickup.lat, t.pickup.lng]) : null;
      if (away != null && away > 300 && !window.confirm("You look " + (away / 1000).toFixed(1) + " km from " + t.passengerName + "'s pickup. Mark yourself as arrived anyway?")) return;
      stopSim();
      act("/arrived").then(function () { toast(t.passengerName + " has been told you're here."); }).catch(function (e) { toast(e.message); });
    });
    var inputs = Array.prototype.slice.call(document.querySelectorAll(".pin-in input"));
    function resetPin() { inputs.forEach(function (x) { x.value = ""; }); setText("pinErr", ""); $("btnStart").disabled = false; }
    inputs.forEach(function (inp, i) {
      inp.addEventListener("input", function () { inp.value = inp.value.replace(/\D/g, "").slice(-1); if (inp.value && inputs[i + 1]) inputs[i + 1].focus(); });
      inp.addEventListener("keydown", function (e) { if (e.key === "Backspace" && !inp.value && inputs[i - 1]) inputs[i - 1].focus(); if (e.key === "Enter") $("btnStart").click(); });
    });
    $("btnStart").addEventListener("click", function () {
      var pin = inputs.map(function (x) { return x.value; }).join("");
      if (pin.length < 4) { setText("pinErr", "Enter all 4 digits."); return; }
      setText("pinErr", "");
      act("/start", { pin: pin }).then(function (v) {
        resetPin(); chosen = false;
        toast(v && v.shared ? "PIN matched. Shared ride started: everyone's fare is now the shared price." : "PIN matched. Trip started, drive safe.");
        refresh();
      }).catch(function (e) {
        inputs.forEach(function (x) { x.value = ""; }); inputs[0].focus();
        setText("pinErr", e.message);
        if (e.status === 423 || (e.data && e.data.attemptsLeft === 0)) $("btnStart").disabled = true;
      });
    });
    $("btnComplete").addEventListener("click", function () {
      var t = focus();
      if (!window.confirm("Drop off " + t.passengerName + " and complete their trip?")) return;
      stopSim();
      act("/complete").then(function () { chosen = false; toast(t.passengerName + " dropped off. Fare EC$" + t.fareXcd + "."); renderAll(); }).catch(function (e) { toast(e.message); });
    });
    $("btnCancel").addEventListener("click", function () {
      var t = focus();
      if (!window.confirm("Cancel " + t.passengerName + "'s trip? They will be told.")) return;
      stopSim();
      act("/cancel").then(function () { chosen = false; renderAll(); }).catch(function (e) { toast(e.message); });
    });

    // ---------- start ----------
    function refresh() {
      return SR.api("/api/driver/trips").then(function (list) {
        var ids = {};
        list.forEach(function (t) { ids[t.id] = 1; update(t); });
        // A booking that vanished from the list ended: fetch it once to show how.
        var gone = Object.keys(trips).filter(function (k) { return isLive(trips[k]) && !ids[k]; });
        return Promise.all(gone.map(function (k) { return SR.api("/api/trips/" + k).then(update).catch(function () { delete trips[k]; }); }));
      }).then(renderAll).catch(function (e) { toast(e.message); });
    }
    refresh();
    SR.connect({ type: "auth", token: SR.token() }, function (m) { if (m.type === "trip") { update(m.trip); renderAll(); } });
    setInterval(function () { if (active().length) refresh(); }, 15000);
    window.addEventListener("resize", function () { map.invalidateSize(); });
  }
})();
