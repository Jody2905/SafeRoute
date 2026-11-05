# SafeRoute: Privacy-First GPS Taxi

**Live site:** https://jody2905.github.io/SafeRoute/

SafeRoute is a front-end prototype of a ride-hailing app for St. Vincent and the Grenadines, built around passenger and driver safety: live GPS trip tracking, trusted contacts, an SOS button, privacy controls and verified drivers. It has two sides:

- **Passenger:** dashboard, booking, live tracking, trip history, trusted contacts, privacy settings, notifications, profile, payments, reviews, settings
- **Driver:** dashboard, ride requests, live map, trip history, earnings, performance, messages, settings

Start at the landing page, then sign in with any email and password (the sign-in is simulated) to reach the passenger dashboard. The driver side starts at `saferoute-driver.html`.

## Safety features

- **SOS sheet** on the live tracking page: one tap to call emergency services (911 or 999 in St. Vincent and the Grenadines), and a **Share my live location** button that reads your real GPS position with the browser's Geolocation API and shares a map link through the phone's share menu (or copies it).
- **Real map and GPS** on the tracking page: an OpenStreetMap map of St. Vincent (Leaflet), a real road route from Arnos Vale to Kingstown (OSRM routing, with a built-in fallback), a taxi that moves along it with live distance and ETA, and a **Use my location** button that shows your phone's real position, accuracy and speed.
- **Ride PIN:** every trip gets a 4-digit PIN on the passenger's Track My Ride page. When a driver accepts a ride, they must enter it before the trip can start, so the passenger knows it's the right car. Three wrong tries block the trip.
- **Share my trip:** a live link (`saferoute-share.html`) a trusted contact can open on any phone to follow the taxi on the map, with the driver's name, car and plate. The taxi's position is worked out from the trip's start time, so everyone sees the same place. The link expires after the trip.
- **Route alerts:** the app measures how far the taxi is from the planned route. More than 150 m off route, or stopped for over 3 minutes, and the passenger gets an "Are you OK?" check; no answer in 30 seconds alerts their trusted contacts. Test buttons on the tracking page trigger a detour or a long stop.
- Trusted contacts, trip sharing and privacy controls for what drivers can see.
- Driver verification status (licence, insurance, vehicle fitness, background check).

## Tech

Plain HTML, CSS and JavaScript, no build step. Maps use [Leaflet](https://leafletjs.com) (bundled in `assets/vendor/leaflet`) with © OpenStreetMap contributors map data; routes come from the public [OSRM](https://project-osrm.org) demo server. `assets/tracking.js` runs the live map, share page and route alerts; `assets/safety.js` handles ride PINs. `assets/saferoute.js` is shared by every page: the phone menu, keyboard access for the sidebar, touch-screen cursor fix and the SOS sheet.

## Publish on GitHub Pages

1. Push this repo to GitHub.
2. Go to **Settings → Pages**. Under **Build and deployment**, set **Source** to *Deploy from a branch*, then pick **main** and **/ (root)**, and click **Save**.
3. After a minute or two the site is live at `https://jody2905.github.io/SafeRoute/`. `index.html` is the landing page.

## Status

This is a front-end prototype. Bookings, payments, messages and sign-in use sample data and don't save anything. Without a server, the ride PIN only syncs between pages in the same browser, and alerts to contacts are simulated. All people, plates and trips are fictional. Prices are in EC$.

## Author

Jody-Ann Trimmingham · [GitHub @Jody2905](https://github.com/Jody2905)
