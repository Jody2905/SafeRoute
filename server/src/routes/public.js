// Routes anyone can use without signing in.
const express = require('express');
const T = require('../services/trips');

const router = express.Router();

// Someone following a shared trip. Only the token holder can see it, and only while the trip is happening.
router.get('/share/:token', async (req, res) => {
  const id = await T.tripIdForShareToken(req.params.token);
  if (!id) return res.status(404).json({ error: 'This trip link has expired or is not valid' });
  const v = await T.views(id);
  if (!v || !v.share) return res.status(404).json({ error: 'This trip link has expired or is not valid' });
  res.set('Cache-Control', 'no-store');
  res.json(v.share);
});

module.exports = router;
