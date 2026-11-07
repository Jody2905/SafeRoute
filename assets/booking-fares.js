/* Booking page: vehicle type, passengers, open route / private, and the fare.
   Live mode asks the server for the quote (real road distance); otherwise it estimates. */
(function () {
  var F = window.SR_FARES, $ = function (id) { return document.getElementById(id); };
  var state = { vehicleType: "car", openRoute: true, quote: null, live: false };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };

  function partySize() { return parseInt($("passengerCount").value, 10) || 1; }
  function place(name) {
    var n = String(name || "").trim().toLowerCase();
    return SR_PLACES.filter(function (p) { return p.name.toLowerCase() === n; })[0] || null;
  }
  function ends() { return { pickup: window.srPickupFix || place($("pickup").value), dest: place($("destination").value) }; }

  /* Passenger list follows the vehicle's seats. */
  function fillPassengers() {
    var sel = $("passengerCount"), keep = partySize(), seats = F.VEHICLES[state.vehicleType].seats;
    sel.innerHTML = "";
    for (var i = 1; i <= seats; i++) {
      var o = document.createElement("option");
      o.value = i; o.textContent = i === 1 ? "Just me" : "Me + " + (i - 1) + " more";
      sel.appendChild(o);
    }
    sel.value = Math.min(keep, seats);
  }
  /* Smallest vehicle that fits the group. */
  function fitVehicle() {
    var n = partySize();
    if (n <= F.VEHICLES[state.vehicleType].seats) return;
    var t = ["car", "suv", "van"].filter(function (k) { return F.VEHICLES[k].seats >= n; })[0];
    pick(t, true);
  }
  function pick(type, quiet) {
    state.vehicleType = type;
    document.querySelectorAll("#rideTypes .ride-type-card").forEach(function (c) { c.classList.toggle("selected", c.dataset.type === type); });
    fillPassengers(); refresh();
    if (!quiet) showToast(F.VEHICLES[type].icon, F.VEHICLES[type].label + " selected · up to " + F.VEHICLES[type].seats + " passengers");
  }

  window.selectVehicle = function (el) { pick(el.dataset.type); };
  window.toggleOpenRoute = function () {
    state.openRoute = !state.openRoute;
    var t = $("openRouteTog");
    t.classList.toggle("on", state.openRoute); t.setAttribute("aria-checked", state.openRoute);
    $("openRouteSub").textContent = state.openRoute
      ? "Other SafeRoute passengers going your way can share the car. If someone joins, you pay 2/3 of the fare."
      : "Private ride: no one else is added and your car isn't shown to other passengers until your trip ends. Costs 10% more.";
    refresh();
  };
  $("openRouteTog").addEventListener("keydown", function (e) { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleOpenRoute(); } });
  document.querySelectorAll("#rideTypes .ride-type-card").forEach(function (c) {
    c.addEventListener("keydown", function (e) { if (e.key === " " || e.key === "Enter") { e.preventDefault(); pick(c.dataset.type); } });
  });
  $("passengerCount").addEventListener("change", function () { fitVehicle(); refresh(); });
  ["pickup", "destination"].forEach(function (id) { $(id).addEventListener("change", refresh); });
  $("useMyLocation").addEventListener("click", function () { setTimeout(refresh, 1500); });

  /* Work out the fare: server quote when live, otherwise an estimate. */
  var seq = 0;
  function refresh() {
    var e = ends(), my = ++seq;
    if (!e.pickup || !e.dest) { state.quote = null; return render(); }
    var opts = { partySize: partySize(), openRoute: state.openRoute, vehicleType: state.vehicleType };
    var local = function () {
      var m = F.estimateMetres(e.pickup, e.dest);
      return { estimate: true, routeKm: Math.round(m / 100) / 10, alone: F.price(Object.assign({ routeM: m }, opts)), shared: state.openRoute ? F.price({ routeM: m, partySize: opts.partySize, shared: true }) : null };
    };
    if (!state.live) { state.quote = local(); return render(); }
    state.quote = local(); render();
    SR.api("/api/fare/quote", { body: Object.assign({ pickup: { lat: e.pickup.lat, lng: e.pickup.lng, name: e.pickup.name }, dest: { lat: e.dest.lat, lng: e.dest.lng, name: e.dest.name } }, opts) })
      .then(function (q) { if (my === seq) { state.quote = q; render(); } })
      .catch(function () {});
  }

  function rows(lines, total) {
    return lines.map(function (l) { return '<div class="fare-row"><span class="label">' + esc(l.label) + '</span><span class="value">' + F.fmtLine(l) + "</span></div>"; }).join("") +
      '<div class="fare-row total"><span class="label">Total</span><span class="value">EC$' + total + "</span></div>";
  }
  function render() {
    var q = state.quote, v = F.VEHICLES[state.vehicleType];
    document.querySelectorAll("[data-fare-for]").forEach(function (el) { el.textContent = q ? "EC$" + q.alone.total : "EC$–"; });
    if ($("fareDisplay")) $("fareDisplay").textContent = q ? "EC$" + q.alone.total : "EC$–";
    var e = ends();
    if ($("roPickup")) $("roPickup").textContent = e.pickup ? e.pickup.name : $("pickup").value || "Choose a pickup";
    if ($("roDest")) $("roDest").textContent = e.dest ? e.dest.name : $("destination").value || "Choose a destination";
    if ($("kmDisplay")) $("kmDisplay").innerHTML = (q ? q.routeKm : "–") + '<span style="font-size:.7rem">km</span>';
    if ($("etaDisplay")) $("etaDisplay").innerHTML = (q ? Math.max(1, Math.round(q.routeKm / 30 * 60)) : "–") + '<span style="font-size:.7rem">min</span>';
    var est = $("fareEstimate"), sum = $("fareSummary");
    if (!q) {
      est.innerHTML = '<div class="fare-row"><span class="label">Choose a pickup and destination to see the fare.</span></div>';
      sum.innerHTML = est.innerHTML; return;
    }
    var about = q.estimate ? "about " : "";
    var head = '<div class="fare-row"><span class="label">' + v.icon + " " + v.label + " · " + partySize() + (partySize() === 1 ? " passenger" : " passengers") + " · " + about + q.routeKm + ' km</span><span class="value">' + (state.openRoute ? "Open route" : "Private") + "</span></div>";
    var shared = q.shared
      ? '<div class="fare-row"><span class="label">If another passenger shares the car</span><span class="value" style="color:var(--accent)">EC$' + q.shared.total + "</span></div>"
      : "";
    est.innerHTML = head + rows(q.alone.lines, q.alone.total) + shared;
    sum.innerHTML = head + rows(q.alone.lines, q.alone.total) + shared +
      '<div class="fare-row"><span class="label" style="font-size:.7rem">Extra stops are EC$3 each. Changing your drop-off updates the fare. Driver detours are never charged.</span></div>';
  }

  window.SRB = { options: function () { return { partySize: partySize(), openRoute: state.openRoute, vehicleType: state.vehicleType }; }, refresh: refresh };
  SR.ready().then(function (live) { state.live = !!live; refresh(); });
  fillPassengers(); refresh();
})();
