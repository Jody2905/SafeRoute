# SafeRoute: Privacy-First GPS Taxi

**Live app:** https://saferoute-api-ir4y.onrender.com · **Also on GitHub Pages:** https://jody2905.github.io/SafeRoute/

SafeRoute is a full-stack ride-hailing app for St. Vincent and the Grenadines, built around passenger safety. A passenger books a ride from their real GPS location, watches the driver come to them live on a map, gives the driver a PIN that the **server** checks before the trip can start, and can send a private live link to someone they trust. The server watches every ride and asks the passenger "Are you OK?" if the taxi leaves the route or stops too long.

![Server tests](https://github.com/Jody2905/SafeRoute/actions/workflows/server-tests.yml/badge.svg)

## Try it

The free server sleeps when idle, so the first visit can take up to a minute.

1. **Passenger:** on one phone or browser, sign in as `passenger@example.com` (password `saferoute-demo`), tap **Use my location as pickup** (or pick a place), choose a destination and book.
2. **Driver:** on a second phone, or a private/incognito window, sign in as `driver@example.com` (same password). The request appears instantly on **Ride Requests**. Tap **Accept**.
3. On the driver's trip page, drive (or turn on **Test drive** to move the taxi from a desk). The passenger sees the taxi move in real time.
4. Tap **I've arrived**. The passenger is told to check the plate and give their PIN. Enter the PIN on the driver's phone to start the ride. Three wrong PINs block the trip.
5. On the passenger's phone, tap **Share Link** and open it on a third device: a trusted contact sees the taxi, driver, car and plate, but not the PIN or the exact pickup address.
6. **Complete trip** on the driver's phone. Everyone sees "Arrived safely", and the share link stops working.

**Shared ride:** book a second ride as `passenger2@example.com` from a place on the first passenger's way, with **Open route** on. Once the first passenger is in the car, the driver sees it as **On your route**, picks them up, and both fares drop to the shared price after the second PIN. `driver3@example.com` drives a 14-seat van for bigger groups.

You can also create your own passenger or driver account. Without the server (opening the files from your computer, or adding `?demo`), every page runs a built-in demo trip instead.

## Fares

Prices are in EC$ and worked out by the server from the planned road route.

| Rule | Price |
|---|---|
| **Ride fare** | EC$8 plus EC$2.50 per km, at least EC$10 |
| **Extra people on your booking** | 1/3 of the ride fare each |
| **Private ride** (Open route off) | +10%. No one else is added, and the car isn't shown to other passengers until the trip ends |
| **Shared ride** (two bookings in one car) | Each booking pays 2/3 of its own ride fare, plus 15% of it for each extra person. A EC$60 ride with one extra person costs 40 + 9 = EC$49 |
| **Extra stops** | EC$3 each, up to 3 |
| **Changing the drop-off** | The fare is worked out again for the new route. "Drop me here" uses the taxi's position |
| **Driver detours** | Never charged: the fare only uses the planned route |

Seats depend on the vehicle: car 4, SUV 6, van 14. A shared ride only matches someone whose pickup is within about 1 km of the route and who is heading the same way, and only while there are enough free seats. Private bookings are never shared.

## How safety works

| Feature | How it works |
|---|---|
| **Ride PIN** | The server makes a random 4-digit PIN for each trip and shows it only to the passenger. The driver enters it at pickup and the server compares it in constant time. Three wrong tries block the trip and warn the passenger. The PIN is deleted the moment it matches. |
| **Live location** | The driver's phone sends GPS every few seconds. The server keeps the trail and pushes each update over **WebSockets** to the passenger and anyone following a share link. |
| **Share links** | A random 192-bit token. Only its SHA-256 hash is stored, so a database leak can't reveal live links. Links work only while the trip is happening, and can be switched off at any time. |
| **Route alerts** | The server measures the taxi's distance from the planned road route. More than 150 m off route for 20 s, or stopped within 30 m for over 3 minutes, opens an alert. The passenger has 60 s to answer **I'm OK** or **I need help**, or the alert is escalated. **SOS** escalates straight away. |
| **Privacy** | Drivers see only the distance to a request until they accept. GPS trails, pickup coordinates and share tokens are deleted 24 hours after a trip ends (`LOCATION_RETENTION_HOURS`). |
| **Accounts** | Passwords hashed with bcrypt (cost 12), sign-in tokens that expire after 12 hours, rate limits on sign-in, and the same response time whether or not an email exists. Drivers need a vehicle and H plate, and must be verified before accepting rides. |
| **Audit log** | Every sign-in, trip step, wrong PIN, alert and share is recorded with who did it. |

## Tech

- **Front end:** HTML, CSS and JavaScript pages, no build step. Maps use [Leaflet](https://leafletjs.com) with © OpenStreetMap contributors data, and routes come from the public [OSRM](https://project-osrm.org) server. `assets/api.js` connects every page to the server.
- **Back end (`server/`):** Node.js, Express 5, PostgreSQL (Neon), `ws` for WebSockets, zod for input checks, helmet for security headers. The server also serves the site, but only the pages and `assets/`, never its own files.
- **Tests:** 9 end-to-end tests against a real PostgreSQL database, run on every push by GitHub Actions: a full trip, wrong PINs, share links, route alerts, privacy clean-up, contacts, live WebSocket updates, and a check that server files can't be downloaded.

```
cd server
npm install
cp .env.example .env        # add your Neon connection string and a long JWT_SECRET
npm run db:setup            # creates the tables and sample accounts
npm run dev                 # http://localhost:3000
TEST_DATABASE_URL=postgres://… npm test   # use a throwaway database: the tests erase it
```

## Deploy (Render + Neon, free)

1. In [Neon](https://neon.tech), create a project called **saferoute** and copy its **pooled** connection string.
2. In [Render](https://render.com), choose **New → Blueprint** and pick this repo. `render.yaml` creates the `saferoute-api` service. Paste the Neon string as `DATABASE_URL`.
3. The first start creates the tables and sample accounts. Check `/api/health` shows `{"ok":true}`.
4. If Render gives the service a different address, update `HOSTED_API` at the top of `assets/api.js` so the GitHub Pages copy connects to it.

## Status

A portfolio project. Trips, accounts and alerts are real, but payments are not taken, alerts are recorded rather than sent by SMS, and drivers are verified automatically (`DEMO_MODE=true`). All sample people, plates and trips are fictional. Prices are in EC$. Place coordinates are approximate town centres.

## Author

Jody-Ann Trimmingham · [GitHub @Jody2905](https://github.com/Jody2905)
