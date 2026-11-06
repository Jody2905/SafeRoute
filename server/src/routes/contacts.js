const express = require('express');
const { z } = require('zod');
const { pool, audit } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

const Contact = z.object({
  name: z.string().trim().min(1).max(60),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number'),
  relation: z.string().trim().max(30).optional(),
});

router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, phone, relation FROM trusted_contacts WHERE user_id = $1 ORDER BY id', [req.user.id]);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const c = Contact.parse(req.body);
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM trusted_contacts WHERE user_id = $1', [req.user.id]);
  if (n >= 5) return res.status(400).json({ error: 'You can have up to 5 trusted contacts' });
  const { rows: [row] } = await pool.query(
    'INSERT INTO trusted_contacts (user_id, name, phone, relation) VALUES ($1,$2,$3,$4) RETURNING id, name, phone, relation',
    [req.user.id, c.name, c.phone, c.relation || null]);
  await audit(pool, req.user.id, 'contact.add', row.id);
  res.status(201).json(row);
});

router.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM trusted_contacts WHERE id = $1 AND user_id = $2', [Number(req.params.id) || 0, req.user.id]);
  if (!rowCount) return res.status(404).json({ error: 'Contact not found' });
  await audit(pool, req.user.id, 'contact.remove', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
