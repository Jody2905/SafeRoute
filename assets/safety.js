/* SafeRoute safety helpers shared by passenger and driver pages.
   - Ride PIN: each trip gets a 4-digit PIN. The passenger shows it; the driver must enter it before the trip starts.
   - Trip record: start time and PIN, kept in this browser (localStorage) so a refresh continues the same trip.
   There is no server yet, so the PIN only syncs between pages in the same browser. */
(function () {
  "use strict";
  var KEY = "saferoute.trip";

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { return null; }
  }
  function save(t) {
    try { localStorage.setItem(KEY, JSON.stringify(t)); } catch (e) { /* storage blocked: trip lives in memory only */ }
    mem = t;
  }
  var mem = null;

  function randomPin() {
    var a = new Uint32Array(1);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return String(1000 + (a[0] % 9000));
  }

  /** Starts a new trip with a fresh PIN. */
  function newTrip() {
    var t = { id: Date.now().toString(36), pin: randomPin(), start: Date.now(), pinVerified: false, pinAttempts: 0, pausedMs: 0 };
    save(t);
    return t;
  }
  /** The current trip, or a new one if there isn't one (or the last one ended). */
  function current(maxAgeMs) {
    var t = load() || mem;
    if (!t || t.ended || (maxAgeMs && Date.now() - t.start > maxAgeMs)) t = newTrip();
    return t;
  }
  function update(patch) {
    var t = load() || mem || newTrip();
    for (var k in patch) t[k] = patch[k];
    save(t);
    return t;
  }

  // ---------- driver: confirm the passenger's PIN ----------
  function css() {
    if (document.getElementById("sr-safety-css")) return;
    var s = document.createElement("style");
    s.id = "sr-safety-css";
    s.textContent = [
      ".sr-pin-modal{position:fixed;inset:0;z-index:9600;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.65);padding:1rem}",
      ".sr-pin-modal>div{background:#111620;border:1px solid #1e2535;border-radius:18px;padding:1.5rem;width:min(380px,100%);color:#e8edf5;font-family:'DM Sans',sans-serif;text-align:center}",
      ".sr-pin-modal h2{font-family:'Syne',sans-serif;font-size:1.15rem;margin-bottom:.35rem}",
      ".sr-pin-modal p{font-size:.82rem;color:#9aa5bf;line-height:1.45;margin-bottom:1rem}",
      ".sr-pin-inputs{display:flex;gap:.5rem;justify-content:center;margin-bottom:.9rem}",
      ".sr-pin-inputs input{width:3rem;height:3.4rem;text-align:center;font-size:1.5rem;font-family:'Syne',sans-serif;background:#0d1117;border:1px solid #1e2535;border-radius:12px;color:#e8edf5}",
      ".sr-pin-inputs input:focus{outline:2px solid #00e5a0;border-color:#00e5a0}",
      ".sr-pin-modal button{width:100%;padding:.8rem;border-radius:12px;border:1px solid #1e2535;background:#0d1117;color:#e8edf5;font-size:.9rem;font-weight:600;cursor:pointer;margin-top:.45rem}",
      ".sr-pin-modal button.go{background:#00e5a0;border-color:#00e5a0;color:#00140d}",
      ".sr-pin-err{color:#ff4757;font-size:.8rem;min-height:1.1rem}",
      ".sr-pin-hint{font-size:.72rem;color:#6b7896;margin-top:.7rem}",
    ].join("");
    document.head.appendChild(s);
  }

  /** Shows the PIN check. Calls onOk() only when the driver enters the passenger's PIN. */
  function askPin(onOk, opts) {
    css();
    opts = opts || {};
    var trip = current();
    var m = document.createElement("div");
    m.className = "sr-pin-modal";
    m.setAttribute("role", "dialog");
    m.setAttribute("aria-modal", "true");
    m.setAttribute("aria-labelledby", "srPinTitle");
    m.innerHTML =
      '<div><h2 id="srPinTitle">🔢 Enter the passenger\'s PIN</h2>' +
      "<p>Ask " + (opts.passenger || "the passenger") + " for the 4-digit PIN on their app. The trip can't start until it matches, so they know they're in the right car.</p>" +
      '<div class="sr-pin-inputs">' + [0, 1, 2, 3].map(function (i) { return '<input inputmode="numeric" maxlength="1" aria-label="PIN digit ' + (i + 1) + '">'; }).join("") + "</div>" +
      '<div class="sr-pin-err" aria-live="polite"></div>' +
      '<button type="button" class="go">Start trip</button><button type="button" data-x>Cancel</button>' +
      '<div class="sr-pin-hint">Demo: the passenger\'s PIN is on their Track My Ride page. In this browser it\'s ' + trip.pin + ".</div></div>";
    var inputs = Array.prototype.slice.call(m.querySelectorAll("input"));
    var err = m.querySelector(".sr-pin-err");
    inputs.forEach(function (inp, i) {
      inp.addEventListener("input", function () {
        inp.value = inp.value.replace(/\D/g, "").slice(-1);
        if (inp.value && inputs[i + 1]) inputs[i + 1].focus();
      });
      inp.addEventListener("keydown", function (e) {
        if (e.key === "Backspace" && !inp.value && inputs[i - 1]) inputs[i - 1].focus();
        if (e.key === "Enter") check();
      });
    });
    function close() { m.remove(); }
    function check() {
      var entered = inputs.map(function (x) { return x.value; }).join("");
      if (entered.length < 4) { err.textContent = "Enter all 4 digits."; return; }
      var t = current();
      if (entered === t.pin) {
        update({ pinVerified: true, pinAttempts: 0, start: Date.now(), pausedMs: 0 });
        close();
        onOk();
        return;
      }
      var tries = (t.pinAttempts || 0) + 1;
      update({ pinAttempts: tries });
      inputs.forEach(function (x) { x.value = ""; });
      inputs[0].focus();
      if (tries >= 3) {
        err.textContent = "3 wrong PINs. Don't start this trip. The safety team has been told (demo).";
        m.querySelector(".go").disabled = true;
      } else {
        err.textContent = "That PIN doesn't match. " + (3 - tries) + " tr" + (3 - tries === 1 ? "y" : "ies") + " left.";
      }
    }
    m.querySelector(".go").addEventListener("click", check);
    if ((trip.pinAttempts || 0) >= 3) {
      err.textContent = "Too many wrong PINs for this trip. Don't start it.";
      m.querySelector(".go").disabled = true;
    }
    m.querySelector("[data-x]").addEventListener("click", close);
    document.body.appendChild(m);
    inputs[0].focus();
  }

  window.SRSafety = { current: current, newTrip: newTrip, update: update, askPin: askPin };
})();
