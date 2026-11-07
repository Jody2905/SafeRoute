/* SafeRoute Track My Ride, live mode: the passenger's real trip from the SafeRoute server.
   Shows the driver's real position (sent from their phone), the trip stage, the PIN,
   the share link, and answers route alerts. Updates arrive over WebSockets. */
(function () {
  "use strict";
  var u = SR.requireUser("passenger");
  if (!u || !window.L) return;

  var $ = function (id) { return document.getElementById(id); };
  var setText = function (id, t) { var el = $(id); if (el) el.textContent = t; };
  var setHTML = function (id, h) { var el = $(id); if (el) el.innerHTML = h; };
  var toast = function (i, t) { if (window.showToast) window.showToast(i, t); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var fmt = function (d) { return d ? new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : ""; };
  var toRad = Math.PI / 180;
  function haversine(a, b) {
    var dLat = (b[0] - a[0]) * toRad, dLng = (b[1] - a[1]) * toRad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }
  /** Metres left along the route from point p (from the closest route point onwards). */
  function remaining(route, p) {
    if (!route || route.length < 2) return 0;
    var best = 0, bd = Infinity;
    route.forEach(function (q, i) { var d = haversine(p, q); if (d < bd) { bd = d; best = i; } });
    var m = bd;
    for (var i = best + 1; i < route.length; i++) m += haversine(route[i - 1], route[i]);
    return m;
  }

  // Hide demo-only controls.
  ["testRow", "pbDemo"].forEach(function (id) { var el = $(id); if (el) el.hidden = true; });
  setText("alertHelp", "SafeRoute's server checks the taxi against the planned route. If it goes more than 150 m off the route, or stops for over 3 minutes, you're asked if you're OK. No answer in 60 seconds and the alert is escalated.");

  // ---------- map ----------
  var map = L.map("map", { zoomControl: false }).setView([13.17, -61.21], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, subdomains: "abc",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  var icon = function (html, cls, size) { size = size || [34, 34]; return L.divIcon({ html: html, className: "sr-pin " + (cls || ""), iconSize: size, iconAnchor: [size[0] / 2, size[1] / 2] }); };
  var pickupM = null, destM = null, car = null, routeLine = null, approachLine = null, me = null, meRing = null;
  var fitted = false;

  window.adjustZoom = function (dir) { dir > 0 ? map.zoomIn() : map.zoomOut(); };

  // ---------- state ----------
  var trip = null, lastStatus = null, shownAlerts = {}, logged = 0;

  var drawnKey = null, stopLayer = null;
  function drawStatic(t) {
    var pick = [t.pickup.lat, t.pickup.lng], dest = [t.dest.lat, t.dest.lng];
    if (!pickupM) pickupM = L.marker(pick, { icon: icon("", "sr-pickup", [16, 16]), title: "Pickup" }).addTo(map).bindTooltip("Pickup · " + t.pickup.name);
    // Redraw the drop-off, stops and route whenever the passenger changes them.
    var key = [t.dest.lat, t.dest.lng, (t.stops || []).length, t.route ? t.route.length : 0, t.routeKm].join("|");
    if (key !== drawnKey) {
      drawnKey = key;
      if (destM) map.removeLayer(destM);
      if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
      if (stopLayer) map.removeLayer(stopLayer);
      destM = L.marker(dest, { icon: icon("📍", "sr-dest"), title: "Destination" }).addTo(map)
        .bindTooltip(t.dest.name, { permanent: true, direction: "right", offset: [14, 0], className: "sr-label" });
      stopLayer = L.layerGroup().addTo(map);
      (t.stops || []).forEach(function (p, i) { L.marker([p.lat, p.lng], { icon: icon("", "sr-stop", [13, 13]), title: "Stop" }).addTo(stopLayer).bindTooltip("Stop " + (i + 1) + " · " + p.name); });
      if (t.route && t.route.length) routeLine = L.polyline(t.route, { color: "#0080ff", weight: 5, opacity: 0.6 }).addTo(map);
    }
    if (!fitted) {
      var b = L.latLngBounds([pick, dest]);
      if (t.position) b.extend([t.position.lat, t.position.lng]);
      map.fitBounds(b, { paddingTopLeft: [190, 70], paddingBottomRight: [70, 120], animate: false });
      fitted = true;
    }
  }

  function step(n, state, label, sub) {
    var dot = $("step" + n + "Dot"), l = $("step" + n + "Label"), line = $("step" + n + "Line");
    if (dot) dot.className = "pt-dot" + (state === "done" ? " done" : state === "active" ? " active" : "");
    if (line) line.className = "pt-connector" + (state === "done" ? " done" : "");
    if (l) { l.textContent = label; l.style.color = state === "active" ? "var(--accent2)" : state === "todo" ? "var(--muted)" : ""; }
    setText("step" + n + "Sub", sub);
  }

  function render(t) {
    trip = t;
    if (!t) return noTrip();
    drawStatic(t);
    var d = t.driver, pos = t.position ? [t.position.lat, t.position.lng] : null;
    setText("rideTitle", "Ride #" + t.id.slice(0, 8).toUpperCase());

    // Driver card
    setText("drvName", d ? d.name : "Finding your driver…");
    setText("drvPlate", d ? d.plate + " · " + d.vehicle : "We'll show their name, car and plate here");
    setText("drvRating", d ? "★ " + Number(d.rating).toFixed(1) : "");

    // Car on the map
    if (pos) {
      if (!car) car = L.marker(pos, { icon: icon("🚕", "sr-car", [38, 38]), zIndexOffset: 1000, title: "Your driver" }).addTo(map);
      else car.setLatLng(pos);
      if (logged !== t.position.at) { logged = t.position.at; log(pos, t.position.speedKmh); }
    }
    if (approachLine) { map.removeLayer(approachLine); approachLine = null; }
    if (pos && (t.status === "accepted")) approachLine = L.polyline([pos, [t.pickup.lat, t.pickup.lng]], { color: "#ff9f43", weight: 3, opacity: 0.7, dashArray: "6 8" }).addTo(map);

    // Numbers
    var toPickupM = pos ? haversine(pos, [t.pickup.lat, t.pickup.lng]) : null;
    var leftM = t.status === "in_progress" && pos ? remaining(t.route, pos) : t.status === "in_progress" ? t.routeKm * 1000 : toPickupM;
    var mins = leftM != null ? Math.max(1, Math.round(leftM / 1000 / 30 * 60)) : null;
    var riding = t.status === "in_progress" || t.status === "completed";
    setText("speedVal", t.position && t.position.speedKmh != null ? String(Math.round(t.position.speedKmh)) : "0");
    setText("distKey", riding ? "Distance Left" : "Driver is");
    setText("distVal", leftM != null ? (leftM / 1000).toFixed(1) : "—");
    setText("etaKey", riding ? "ETA" : "Pickup in");
    setHTML("etaMin", mins != null ? mins + '<span class="unit"> min</span>' : "—");
    setHTML("etaDist", leftM != null ? (leftM / 1000).toFixed(1) + '<span class="unit"> km</span>' : "—");
    setHTML("elapsedMin", (t.times.started ? Math.max(0, Math.floor((Date.now() - new Date(t.times.started)) / 60000)) : 0) + '<span class="unit"> min</span>');

    // Stages
    var badge = { requested: "Finding driver", accepted: "Driver en route", arrived: "At pickup", in_progress: "In progress", completed: "Arrived", cancelled: "Cancelled" }[t.status];
    setText("rideBadge", badge);
    if (t.status === "requested") {
      step(1, "active", "Finding you a driver", "Nearby verified drivers can see your request");
      step(2, "todo", "Pickup", t.pickup.name);
      step(3, "todo", "Destination", t.dest.name);
    } else if (t.status === "accepted") {
      step(1, "active", d.name + " is on the way", d.vehicle + " · " + d.plate + (mins ? " · about " + mins + " min" : ""));
      step(2, "todo", "Pickup", t.pickup.name);
      step(3, "todo", "Destination", t.dest.name);
    } else if (t.status === "arrived") {
      step(1, "done", d.name + " has arrived", "Waiting at your pickup");
      step(2, "active", "Give your driver the PIN", "Check the plate is " + d.plate + " first");
      step(3, "todo", "Destination", t.dest.name);
    } else if (t.status === "in_progress" || t.status === "completed") {
      step(1, "done", "Driver arrived", "PIN checked ✓");
      step(2, "done", "Picked up", t.pickup.name + " — " + fmt(t.times.started));
      step(3, t.status === "completed" ? "done" : "active", t.status === "completed" ? "Arrived" : "En route to " + t.dest.name, t.status === "completed" ? t.dest.name + " — " + fmt(t.times.completed) : "ETA " + mins + " min");
    } else {
      step(1, "todo", "Trip cancelled", fmt(t.times.cancelled));
      step(2, "todo", "Pickup", t.pickup.name);
      step(3, "todo", "Destination", t.dest.name);
    }

    // Pickup banner: check the plate, then give the PIN
    var banner = $("pickupBanner");
    if (banner) {
      banner.hidden = !(t.status === "arrived" || t.pinBlocked);
      if (t.pinBlocked) {
        setText("pbTitle", "⚠️ Don't get in this taxi");
        setText("pbText", "The driver entered the wrong PIN 3 times, so this trip is blocked. Cancel it and book again, or tap SOS if you feel unsafe.");
      } else if (d) {
        setText("pbTitle", "🚕 " + d.name.split(" ")[0] + " has arrived");
        setHTML("pbText", "Check the plate is <b>" + esc(d.plate) + "</b> on a " + esc(d.vehicle) + ", then tell them your PIN. They enter it on their phone to start the trip.");
      }
    }

    // PIN
    setText("ridePin", t.pin ? t.pin.split("").join(" ") : t.pinVerified ? "✓ ✓ ✓ ✓" : "- - - -");
    var ps = $("pinStatus");
    if (ps) {
      ps.className = "pin-status " + (t.pinVerified ? "ok" : "wait");
      ps.textContent = t.pinVerified ? "✓ Your driver entered the right PIN" : t.pinBlocked ? "Blocked after 3 wrong PINs" : "Give it to your driver when they arrive";
    }

    // End / cancel button
    var end = $("endRideBtn");
    if (end) {
      var canCancel = ["requested", "accepted", "arrived"].indexOf(t.status) >= 0;
      end.disabled = !canCancel && t.status !== "completed" && t.status !== "cancelled";
      end.textContent = canCancel ? "✕ Cancel this ride" : t.status === "in_progress" ? "🏁 Your driver ends the trip when you arrive" : "🚕 Book another ride";
    }

    renderFare(t);

    // Alerts from the server
    (t.alerts || []).forEach(function (a) { if (!shownAlerts[a.id]) { shownAlerts[a.id] = true; showAlert(a); } });

    if (t.status !== lastStatus) {
      if (lastStatus) {
        if (t.status === "accepted") toast("🚕", d.name + " accepted your ride and is on the way.");
        if (t.status === "arrived") toast("🚕", "Your driver has arrived. Check the plate, then give them your PIN.");
        if (t.status === "in_progress") toast("✅", "PIN matched. Your ride has started.");
        if (t.status === "cancelled") toast("✕", "This ride was cancelled.");
      }
      if (t.status === "completed" && lastStatus && window.showArrivalModal) setTimeout(window.showArrivalModal, 600);
      lastStatus = t.status;
    }
  }

  // ---------- fare, stops and drop-off ----------
  var money = function (n) { return "EC$" + (Math.round(n * 100) % 100 ? Number(n).toFixed(2) : n); };
  var lastFare = null, editMode = null;
  function renderFare(t) {
    var sec = $("fareSection");
    if (!sec) return;
    sec.hidden = t.status === "cancelled";
    var lines = t.fareBreakdown || [{ label: "Ride fare", xcd: t.fareXcd }];
    setText("fareTitle", t.status === "completed" ? "You paid" : "Your fare");
    setHTML("fareLines", lines.map(function (l) { return '<div class="fare-line"><span>' + esc(l.label) + "</span><span>" + money(l.xcd) + "</span></div>"; }).join("") +
      '<div class="fare-line total"><span>Total</span><span>EC$' + t.fareXcd + "</span></div>");
    var note = $("fareNote"), parts = [];
    note.className = "fare-note" + (t.shared ? " shared" : "");
    if (t.shared) parts.push("🤝 Shared ride: you're sharing the car with " + t.othersInCar + " other booking" + (t.othersInCar === 1 ? "" : "s") + ", so you pay the shared price.");
    else if (t.openRoute && t.status !== "completed") parts.push("🛣 Open route: if another passenger going your way joins, your fare drops to the shared price.");
    else if (!t.openRoute) parts.push("🔒 Private ride: no one else is added, and your car isn't shown to other passengers until your trip ends.");
    parts.push(t.partySize + (t.partySize === 1 ? " passenger" : " passengers") + " · " + ({ car: "Car", suv: "SUV", van: "Van" }[t.vehicleType] || "Car") + " · " + t.routeKm + " km planned. Driver detours are never charged.");
    note.textContent = parts.join(" ");
    var canEdit = ["requested", "accepted", "arrived", "in_progress"].indexOf(t.status) >= 0;
    show("tripEdit", canEdit);
    if (!canEdit) closeEdit();
    $("btnAddStop").disabled = (t.stops || []).length >= 3;
    $("btnAddStop").textContent = (t.stops || []).length >= 3 ? "3 stops max" : "＋ Add a stop";
    show("btnDropHere", t.status === "in_progress" && !!t.position);
    if (lastFare != null && t.fareXcd !== lastFare) toast("💵", "Your fare is now EC$" + t.fareXcd + (t.fareXcd < lastFare ? " (down from EC$" + lastFare + ")" : " (was EC$" + lastFare + ")"));
    lastFare = t.fareXcd;
  }
  function show(id, on) { var el = $(id); if (el) el.hidden = !on; }
  function closeEdit() { editMode = null; show("editForm", false); }
  function openEdit(mode) {
    if (editMode === mode) return closeEdit();
    editMode = mode;
    show("editForm", true);
    $("editPlace").value = "";
    $("editPlace").placeholder = mode === "stop" ? "Where should the driver stop?" : "Where do you want to get off?";
    setText("editGo", mode === "stop" ? "Add stop" : "Change");
    $("editPlace").focus();
  }
  function changeTrip(path, place, msg) {
    return SR.api("/api/trips/" + trip.id + path, { body: { lat: place.lat, lng: place.lng, name: place.name } })
      .then(function (t) { closeEdit(); render(t); toast("🗺", msg + " New fare EC$" + t.fareXcd + "."); })
      .catch(function (e) { toast("⚠️", e.message); });
  }
  (function setupEdit() {
    var dl = $("trackPlaces");
    if (!dl || !$("editForm")) return;
    SR_PLACES.forEach(function (p) { var o = document.createElement("option"); o.value = p.name; dl.appendChild(o); });
    $("btnAddStop").addEventListener("click", function () { openEdit("stop"); });
    $("btnChangeDest").addEventListener("click", function () { openEdit("dest"); });
    $("btnDropHere").addEventListener("click", function () {
      if (!trip || !trip.position) return;
      var p = trip.position, near = SR_nearestPlace(p.lat, p.lng);
      if (!window.confirm("Get off here, near " + near.name + "? Your fare will be worked out to this point.")) return;
      changeTrip("/destination", { lat: p.lat, lng: p.lng, name: "Near " + near.name }, "Drop-off changed to here.");
    });
    $("editForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var n = $("editPlace").value.trim().toLowerCase();
      var place = SR_PLACES.filter(function (p) { return p.name.toLowerCase() === n; })[0];
      if (!place) return toast("⚠️", "Choose a place from the list.");
      if (editMode === "stop") changeTrip("/stops", place, "Stop added at " + place.name + ".");
      else changeTrip("/destination", place, "Drop-off changed to " + place.name + ".");
    });
  })();

  function noTrip() {
    setText("rideTitle", "No active ride");
    setText("rideBadge", "—");
    step(1, "todo", "No ride in progress", "Book a ride to start tracking");
    step(2, "todo", "Pickup", "");
    step(3, "todo", "Destination", "");
    var end = $("endRideBtn"); if (end) { end.disabled = false; end.textContent = "🚕 Book a ride"; }
  }

  // ---------- actions ----------
  window.endRide = function () {
    if (!trip || trip.status === "completed" || trip.status === "cancelled") { location.href = "saferoute-booking.html"; return; }
    if (["requested", "accepted", "arrived"].indexOf(trip.status) < 0) return;
    if (!window.confirm("Cancel this ride?")) return;
    SR.api("/api/trips/" + trip.id + "/cancel", { body: {} }).then(render).catch(function (e) { toast("⚠️", e.message); });
  };

  function shareKey() { return "saferoute.share." + (trip && trip.id); }
  function shareUrl(tok) { var u2 = new URL("saferoute-share.html", location.href); u2.searchParams.set("s", tok); return u2.toString(); }
  function getShareToken() {
    var saved = null;
    try { saved = localStorage.getItem(shareKey()); } catch (e) {}
    if (saved && trip.sharing) return Promise.resolve(saved);
    return SR.api("/api/trips/" + trip.id + "/share", { body: {} }).then(function (r) {
      try { localStorage.setItem(shareKey(), r.token); } catch (e) {}
      return r.token;
    });
  }
  function share() {
    if (!trip || ["requested", "accepted", "arrived", "in_progress"].indexOf(trip.status) < 0) { toast("ℹ️", "You can share a ride once you've booked one."); return; }
    getShareToken().then(function (tok) {
      var url = shareUrl(tok);
      setText("shareLinkText", url.replace(/^https?:\/\//, ""));
      if (navigator.share) navigator.share({ title: "Follow my SafeRoute ride", text: "Follow my taxi live until I arrive.", url: url }).catch(function () {});
      else if (navigator.clipboard) navigator.clipboard.writeText("Follow my SafeRoute taxi live: " + url).then(function () { toast("📋", "Private trip link copied. Send it to someone you trust."); });
      else window.prompt("Copy this link:", url);
    }).catch(function (e) { toast("⚠️", e.message); });
  }

  // Route alerts: "Are you OK?"
  function showAlert(a) {
    var box = document.createElement("div");
    box.className = "sr-alert";
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    var title = a.kind === "off_route" ? "Your taxi has left the planned route" : "Your taxi has been stopped for over 3 minutes";
    box.innerHTML = "<div><h2>⚠️ " + title + "</h2><p>Are you OK? If you don't answer, SafeRoute escalates the alert.</p>" +
      '<div class="sr-count" aria-live="polite"></div><button type="button" class="ok">✅ I\'m OK</button><button type="button" class="help">🆘 I need help</button></div>';
    var count = box.querySelector(".sr-count");
    var timer = setInterval(function () {
      var left = Math.max(0, Math.round((new Date(a.answerBy) - Date.now()) / 1000));
      count.textContent = left ? "Escalating in " + left + " s" : "Escalated: SafeRoute has been alerted.";
      if (!left) { clearInterval(timer); setTimeout(close, 2500); }
    }, 500);
    function close() { clearInterval(timer); box.remove(); }
    function answer(ok) {
      SR.api("/api/alerts/" + a.id + "/respond", { body: { ok: ok } }).catch(function () {});
      close();
      if (ok) toast("✅", "Thanks. We'll keep watching the route.");
      else if (window.triggerSOS) window.triggerSOS();
    }
    box.querySelector(".ok").addEventListener("click", function () { answer(true); });
    box.querySelector(".help").addEventListener("click", function () { answer(false); });
    document.body.appendChild(box);
    box.querySelector(".ok").focus();
  }

  // SOS also tells the server (logged and escalated), then opens the call / share sheet.
  var baseSOS = window.triggerSOS;
  window.triggerSOS = function () {
    if (trip && ["accepted", "arrived", "in_progress"].indexOf(trip.status) >= 0) SR.api("/api/trips/" + trip.id + "/sos", { body: {} }).catch(function () {});
    if (baseSOS) baseSOS();
  };

  // Your own location (blue dot + real accuracy).
  var watchId = null;
  function locate() {
    if (!navigator.geolocation) return toast("⚠️", "This browser can't read your location.");
    if (watchId !== null && me) return map.setView(me.getLatLng(), 16);
    watchId = navigator.geolocation.watchPosition(function (p) {
      var ll = [p.coords.latitude, p.coords.longitude];
      if (!me) { me = L.marker(ll, { icon: icon("", "sr-me", [18, 18]), title: "You", zIndexOffset: 900 }).addTo(map).bindTooltip("You"); meRing = L.circle(ll, { radius: p.coords.accuracy, color: "#0080ff", weight: 1, fillOpacity: 0.12 }).addTo(map); }
      else { me.setLatLng(ll); meRing.setLatLng(ll).setRadius(p.coords.accuracy); }
      setText("accVal", String(Math.round(p.coords.accuracy)));
      var btn = $("locBtn"); if (btn) btn.classList.add("on");
    }, function (e) { watchId = null; toast("⚠️", e.code === 1 ? "Location permission was denied." : "Couldn't get your location."); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  }

  function log(p, kmh) {
    var box = $("gpsLog"); if (!box) return;
    var row = document.createElement("div");
    row.className = "log-entry";
    row.innerHTML = '<span class="log-time"></span><span class="log-coords"></span><span class="log-speed"></span>';
    row.children[0].textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
    row.children[1].textContent = p[0].toFixed(5) + ", " + p[1].toFixed(5);
    row.children[2].textContent = kmh == null ? "—" : Math.round(kmh) + "km/h";
    box.insertBefore(row, box.firstChild);
    while (box.children.length > 8) box.removeChild(box.lastChild);
  }

  function loadContacts() {
    SR.api("/api/contacts").then(function (list) {
      var box = $("contactsList"); if (!box) return;
      box.innerHTML = list.length ? list.map(function (c) {
        return '<div class="contact-item"><div class="contact-avatar">👤</div><span class="contact-name">' + esc(c.name) + '</span><span class="contact-status notified">Send link</span></div>';
      }).join("") : '<p class="pin-help">No trusted contacts yet. Add them on the Trusted Contacts page.</p>';
    }).catch(function () {});
  }

  window.SRTrack = { zoom: window.adjustZoom, locate: locate, share: share };
  window.toggleSharing = function () {
    if (!trip) return;
    var t = $("shareToggle");
    if (trip.sharing) SR.api("/api/trips/" + trip.id + "/share", { method: "DELETE" }).then(function () { trip.sharing = false; if (t) t.classList.remove("on"); toast("🔒", "Sharing stopped. Old links no longer work."); setText("shareLinkText", "Sharing is off"); });
    else share();
  };

  // ---------- start ----------
  setText("accVal", "—");
  setText("shareLinkText", "Tap Share Link to create a private link");
  SR.api("/api/trips/current").then(function (t) {
    render(t);
    if (t) {
      var tg = $("shareToggle"); if (tg) tg.classList.toggle("on", !!t.sharing);
      if (t.sharing) try { var tok = localStorage.getItem(shareKey()); if (tok) setText("shareLinkText", shareUrl(tok).replace(/^https?:\/\//, "")); } catch (e) {}
    }
  }).catch(function (e) { toast("⚠️", e.message); });
  loadContacts();
  SR.connect({ type: "auth", token: SR.token() }, function (m) { if (m.type === "trip") render(m.trip); });
  // Backup in case the live connection drops: refresh every 15 s.
  setInterval(function () { if (trip && trip.status !== "completed" && trip.status !== "cancelled") SR.api("/api/trips/" + trip.id).then(render).catch(function () {}); }, 15000);
  locate();
  window.addEventListener("resize", function () { map.invalidateSize(); });
})();
