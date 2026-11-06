const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const { rateLimit } = require('express-rate-limit');
const { ZodError } = require('zod');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // On Render (one proxy in front), trust X-Forwarded-For so rate limits apply per visitor.
  if (process.env.RENDER || process.env.TRUST_PROXY) app.set('trust proxy', 1);

  // The site's pages use inline scripts, OpenStreetMap tiles, the OSRM routing service and Google Fonts.
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ['https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https://*.tile.openstreetmap.org'],
        connectSrc: ["'self'", 'https://router.project-osrm.org', 'wss:', 'ws:'],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    // OpenStreetMap's tile servers require a Referer, so send the site's origin (not the full page address).
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(cors({ origin: (process.env.CORS_ORIGIN || 'http://localhost:5500').split(',').map(s => s.trim()) }));
  app.use(express.json({ limit: '20kb' }));

  const limiter = (limit, windowMs) =>
    process.env.NODE_ENV === 'test'
      ? (req, res, next) => next()
      : rateLimit({ windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false,
          message: { error: 'Too many requests. Wait a few minutes and try again.' } });

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', limiter(20, 15 * 60 * 1000), require('./routes/auth'));
  app.use('/api/share', limiter(600, 15 * 60 * 1000));
  // Location updates arrive every few seconds, so this limit is generous.
  app.use('/api', limiter(2000, 15 * 60 * 1000));
  app.use('/api', require('./routes/public'));
  app.use('/api/contacts', require('./routes/contacts'));
  app.use('/api', require('./routes/trips'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // The website itself (the HTML pages one folder up), so the Render address serves the whole app.
  // Only the top-level .html pages and the assets/ folder are public: never server/, .env or .git.
  const site = path.join(__dirname, '..', '..');
  const publicPath = /^\/(?:[a-z0-9-]+\.html|assets\/[A-Za-z0-9._\/-]+)?$/;
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!publicPath.test(req.path) || req.path.includes('..')) return res.status(404).send('Page not found');
    next();
  });
  app.use(express.static(site, { index: 'index.html', dotfiles: 'deny', fallthrough: true,
    setHeaders: res => res.set('Permissions-Policy', 'geolocation=(self)') }));
  app.use((req, res) => res.status(404).send('Page not found'));

  // Express 5 sends async errors here.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return res.status(400).json({ error: first ? (first.path.length ? first.path.join('.') + ': ' : '') + first.message : 'Invalid request' });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side. Try again.' });
  });
  return app;
}

module.exports = { createApp };
