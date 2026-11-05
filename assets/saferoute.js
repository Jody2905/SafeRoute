/* SafeRoute shared helpers, loaded on every page.
   - Phone menu: the sidebar is hidden on small screens, so add a menu button that opens it.
   - Touch screens: hide the custom cursor dot (it has no mouse to follow) and restore the normal cursor.
   - SOS: an honest emergency sheet with a real call button and a real "share my location" link. */
(function () {
  // Emergency numbers for Jamaica, where the demo trips are set. Change these if you move the setting.
  var EMERGENCY = { police: "119", ambulance: "110" };

  var css = document.createElement("style");
  css.textContent = [
    "@media (hover:none),(pointer:coarse){.cursor,.cursor-ring{display:none!important}*{cursor:auto!important}}",
    "@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}",
    ":focus-visible{outline:2px solid #00e5a0;outline-offset:2px}",
    ".sr-menu{display:none;position:fixed;top:12px;left:12px;z-index:9100;width:44px;height:44px;border-radius:12px;border:1px solid #1e2535;background:#0d1117;color:#e8edf5;font-size:1.3rem;cursor:pointer}",
    ".sr-scrim{display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9000}",
    "@media (max-width:900px){.sr-menu{display:block}.topbar,.top-bar{padding-left:68px!important}",
    "body.sr-open .sidebar{display:flex!important;position:fixed!important;top:0;left:0;bottom:0;height:100vh;z-index:9050;width:min(280px,85vw)!important;overflow-y:auto}",
    "body.sr-open .sr-scrim{display:block}}",
    ".sr-sheet{position:fixed;inset:0;z-index:9500;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.6)}",
    ".sr-sheet>div{background:#111620;border:1px solid #ff4757;border-radius:18px 18px 0 0;padding:1.4rem;width:min(460px,100%);font-family:'DM Sans',sans-serif;color:#e8edf5}",
    ".sr-sheet h2{font-family:'Syne',sans-serif;font-size:1.15rem;margin-bottom:.4rem;color:#ff4757}",
    ".sr-sheet p{font-size:.82rem;color:#9aa5bf;margin-bottom:1rem;line-height:1.45}",
    ".sr-sheet a,.sr-sheet button{display:block;width:100%;text-align:center;padding:.85rem;border-radius:12px;margin-bottom:.55rem;font-size:.9rem;font-weight:600;text-decoration:none;cursor:pointer;border:1px solid #1e2535;background:#0d1117;color:#e8edf5}",
    ".sr-sheet .sr-call{background:#ff4757;border-color:#ff4757;color:#fff}",
    ".sr-sheet small{display:block;font-size:.72rem;color:#6b7896;margin-top:.4rem}",
  ].join("");
  document.head.appendChild(css);

  // ---- phone menu ----
  var sidebar = document.querySelector(".sidebar");
  if (sidebar) {
    var btn = document.createElement("button");
    btn.className = "sr-menu";
    btn.type = "button";
    btn.setAttribute("aria-label", "Open menu");
    btn.setAttribute("aria-expanded", "false");
    btn.textContent = "☰";
    var scrim = document.createElement("div");
    scrim.className = "sr-scrim";
    var toggle = function (open) {
      document.body.classList.toggle("sr-open", open);
      btn.setAttribute("aria-expanded", String(open));
      btn.textContent = open ? "✕" : "☰";
    };
    btn.addEventListener("click", function () { toggle(!document.body.classList.contains("sr-open")); });
    scrim.addEventListener("click", function () { toggle(false); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") toggle(false); });
    document.body.appendChild(scrim);
    document.body.appendChild(btn);
  }

  // Sidebar items are <div onclick>, so make them reachable with the keyboard too.
  document.querySelectorAll(".ni[onclick], .nav-item[onclick]").forEach(function (el) {
    el.setAttribute("role", "link");
    el.setAttribute("tabindex", "0");
    el.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.click(); } });
  });

  // ---- SOS ----
  function mapsLink(pos) {
    var c = pos.coords;
    return "https://maps.google.com/?q=" + c.latitude.toFixed(6) + "," + c.longitude.toFixed(6);
  }
  function shareLocation(status) {
    if (!navigator.geolocation) { status.textContent = "This browser can't read your location."; return; }
    status.textContent = "Getting your location…";
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        var link = mapsLink(pos);
        var text = "I need help. My live location from SafeRoute: " + link;
        if (navigator.share) {
          navigator.share({ title: "SafeRoute SOS", text: text }).then(
            function () { status.textContent = "Location shared."; },
            function () { status.textContent = "Share cancelled. Your link: " + link; },
          );
        } else if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(function () { status.textContent = "Link copied. Paste it to a trusted contact: " + link; });
        } else {
          status.textContent = link;
        }
      },
      function (err) {
        status.textContent = err.code === 1 ? "Location permission was denied. Allow it in your browser settings." : "Couldn't get your location. Try again outside or near a window.";
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  }
  window.triggerSOS = function () {
    if (document.querySelector(".sr-sheet")) return;
    var sheet = document.createElement("div");
    sheet.className = "sr-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "Emergency");
    sheet.innerHTML =
      '<div><h2>🆘 Emergency</h2>' +
      "<p>If you are in danger, call the police now. You can also send your exact GPS location to someone you trust.</p>" +
      '<a class="sr-call" href="tel:' + EMERGENCY.police + '">📞 Call police (' + EMERGENCY.police + ")</a>" +
      '<a href="tel:' + EMERGENCY.ambulance + '">🚑 Ambulance / fire (' + EMERGENCY.ambulance + ")</a>" +
      '<button type="button" data-act="share">📍 Share my live location</button>' +
      '<button type="button" data-act="close">Cancel</button>' +
      '<small data-status>Demo app: SafeRoute does not contact the police or your trusted contacts by itself yet.</small></div>';
    var status = sheet.querySelector("[data-status]");
    sheet.addEventListener("click", function (e) {
      var act = e.target.getAttribute && e.target.getAttribute("data-act");
      if (act === "share") shareLocation(status);
      if (act === "close" || e.target === sheet) sheet.remove();
    });
    document.body.appendChild(sheet);
    sheet.querySelector(".sr-call").focus();
  };
})();
