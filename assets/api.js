/* SafeRoute API client, shared by every page.
   - Live mode: talks to the SafeRoute server (accounts, trips, live location over WebSockets).
   - Demo mode: no server reachable (or ?demo in the address), so pages fall back to their built-in demo.
   The GitHub Pages copy of the site talks to the server on Render. */
(function () {
  "use strict";
  // The SafeRoute server on Render. Change this if Render gives your service a different address.
  var HOSTED_API = "https://saferoute-api.onrender.com";
  var KEY_TOKEN = "saferoute.token", KEY_USER = "saferoute.user";

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} },
  };

  var demoForced = /[?&]demo\b/.test(location.search) || location.protocol === "file:";
  var base = /\.github\.io$/.test(location.hostname) ? HOSTED_API : "";
  var readyPromise = null;

  function health(timeoutMs) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var t = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs);
    return fetch(base + "/api/health", ctrl ? { signal: ctrl.signal } : {})
      .then(function (r) { clearTimeout(t); return r.ok; })
      .catch(function () { clearTimeout(t); return false; });
  }

  /** Resolves true when the server is reachable (live mode), false for demo mode. */
  function ready() {
    if (readyPromise) return readyPromise;
    if (demoForced) return (readyPromise = Promise.resolve(false));
    // Free Render servers sleep when idle and can take up to a minute to wake.
    var slow = setTimeout(function () { banner("Waking up the SafeRoute server… this can take up to a minute."); }, 2500);
    readyPromise = health(70000).then(function (ok) { clearTimeout(slow); banner(null); return ok; });
    return readyPromise;
  }

  function token() { return store.get(KEY_TOKEN); }
  function user() { try { return JSON.parse(store.get(KEY_USER) || "null"); } catch (e) { return null; } }
  function saveSession(r) { store.set(KEY_TOKEN, r.token); store.set(KEY_USER, JSON.stringify(r.user)); }
  function signOut(to) { store.set(KEY_TOKEN, null); store.set(KEY_USER, null); if (to !== false) location.href = to || "saferoute-auth.html"; }

  /** Calls the API. Rejects with an Error whose message is safe to show. */
  function api(path, opts) {
    opts = opts || {};
    var headers = { "Content-Type": "application/json" };
    if (token() && opts.auth !== false) headers.Authorization = "Bearer " + token();
    return fetch(base + path, { method: opts.method || (opts.body ? "POST" : "GET"), headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) {
        return r.text().then(function (txt) {
          var data = null;
          try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
          if (r.status === 401 && opts.auth !== false) signOut("saferoute-auth.html?expired=1");
          if (!r.ok) { var e = new Error((data && data.error) || "Something went wrong (" + r.status + ")"); e.status = r.status; e.data = data; throw e; }
          return data;
        });
      }, function () { throw new Error("Can't reach SafeRoute. Check your connection and try again."); });
  }

  /** Signed-in pages call this. Sends people to sign in, or to their own side of the app. */
  function requireUser(role) {
    var u = user();
    if (!token() || !u) { location.href = "saferoute-auth.html?next=" + encodeURIComponent(location.pathname.split("/").pop() + location.search); return null; }
    if (role && u.role !== role) { location.href = homeFor(u); return null; }
    return u;
  }
  function homeFor(u) { return u && u.role === "driver" ? "saferoute-ride-requests.html" : "saferoute-booking.html"; }

  /** Live updates. onMessage gets { type: "trip", trip } and, for drivers, { type: "requests" }. Reconnects by itself. */
  function connect(hello, onMessage) {
    var ws = null, closed = false, retry = 1000;
    function open() {
      var url = (base || location.origin).replace(/^http/, "ws") + "/ws";
      ws = new WebSocket(url);
      ws.onopen = function () { retry = 1000; ws.send(JSON.stringify(hello)); };
      ws.onmessage = function (e) { try { onMessage(JSON.parse(e.data)); } catch (err) {} };
      ws.onclose = function () { if (!closed) setTimeout(open, retry = Math.min(retry * 2, 15000)); };
    }
    open();
    return {
      send: function (m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); },
      close: function () { closed = true; if (ws) ws.close(); },
    };
  }

  // Small banner at the top of the page for connection messages.
  function banner(text) {
    var el = document.getElementById("sr-conn");
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement("div");
      el.id = "sr-conn";
      el.setAttribute("role", "status");
      el.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9800;background:#ff9f43;color:#1a0f00;text-align:center;padding:.5rem 1rem;font:600 .8rem 'DM Sans',sans-serif";
      document.body.appendChild(el);
    }
    el.textContent = text;
  }

  /** Loads a script (used to pick the live or demo version of a page). */
  function load(src) {
    return new Promise(function (res, rej) { var s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.body.appendChild(s); });
  }

  window.SR = { ready: ready, api: api, token: token, user: user, saveSession: saveSession, signOut: signOut,
    requireUser: requireUser, homeFor: homeFor, connect: connect, banner: banner, load: load,
    get base() { return base; } };
})();
