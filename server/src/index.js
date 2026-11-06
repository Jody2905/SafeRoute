require('./env');
const http = require('http');
const { createApp } = require('./app');
const live = require('./services/realtime');
const T = require('./services/trips');

const port = Number(process.env.PORT) || 3000;
const server = http.createServer(createApp());
live.attach(server, { loadViews: id => T.views(id) });

// Every 10 s: escalate alerts nobody answered. Every 10 min: delete old GPS trails.
setInterval(async () => {
  try { for (const id of await T.escalateUnanswered()) await live.tripChanged(id); }
  catch (e) { console.error('alert sweep:', e.message); }
}, 10_000).unref();
setInterval(() => T.purgeOldLocations().catch(e => console.error('privacy purge:', e.message)), 10 * 60_000).unref();

server.listen(port, () => console.log(`SafeRoute API listening on http://localhost:${port}`));
