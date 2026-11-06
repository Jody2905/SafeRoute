const jwt = require('jsonwebtoken');
const { pool } = require('./db');

const SECRET = () => {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET must be set and at least 32 characters');
  return s;
};

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, SECRET(), { expiresIn: '12h' });
}

/** Reads the user from a token. Returns null if the token is missing, expired or the account is gone. */
async function userFromToken(token) {
  if (!token) return null;
  try {
    const { sub } = jwt.verify(token, SECRET());
    const { rows } = await pool.query('SELECT id, role, name FROM users WHERE id = $1', [sub]);
    return rows[0] || null;
  } catch {
    return null;
  }
}

async function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const user = await userFromToken(header.startsWith('Bearer ') ? header.slice(7) : null);
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  req.user = user;
  next();
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Not allowed for this account type' });

module.exports = { signToken, userFromToken, requireAuth, requireRole };
