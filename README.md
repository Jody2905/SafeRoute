# SafeRoute: Privacy-First GPS Taxi

**Live site:** https://jody2905.github.io/SafeRoute/

SafeRoute is a front-end prototype of a ride-hailing app built around passenger and driver safety: live GPS trip tracking, trusted contacts, an SOS button, privacy controls and verified drivers. It has two sides:

- **Passenger:** dashboard, booking, live tracking, trip history, trusted contacts, privacy settings, notifications, profile, payments, reviews, settings
- **Driver:** dashboard, ride requests, live map, trip history, earnings, performance, messages, settings

Start at the landing page, then sign in with any email and password (the sign-in is simulated) to reach the passenger dashboard. The driver side starts at `saferoute-driver.html`.

## Safety features

- **SOS sheet** on the live tracking page: one tap to call the police (119) or an ambulance (110), and a **Share my live location** button that reads your real GPS position with the browser's Geolocation API and shares a map link through the phone's share menu (or copies it).
- Trusted contacts, trip sharing and privacy controls for what drivers can see.
- Driver verification status (licence, insurance, vehicle fitness, background check).

## Tech

Plain HTML, CSS and JavaScript, no build step. `assets/saferoute.js` is shared by every page: the phone menu, keyboard access for the sidebar, touch-screen cursor fix and the SOS sheet.

## Publish on GitHub Pages

1. Push this repo to GitHub.
2. Go to **Settings → Pages**. Under **Build and deployment**, set **Source** to *Deploy from a branch*, then pick **main** and **/ (root)**, and click **Save**.
3. After a minute or two the site is live at `https://jody2905.github.io/SafeRoute/`. `index.html` is the landing page.

## Status

This is a front-end prototype. Bookings, payments, messages and sign-in use sample data and don't save anything. All people, plates and trips are fictional.

## Author

Jody-Ann Trimmingham · [GitHub @Jody2905](https://github.com/Jody2905)
