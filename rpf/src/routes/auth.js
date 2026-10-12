const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { signToken, requireAuth, RPF_ROLES } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { badRequest, unauthorized, forbidden, HttpError, wrap } = require('../errors');

const router = express.Router();

// Small in-memory brake on password guessing: 10 failures / 15 min per ip+username.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;

function tooMany(key) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < WINDOW_MS);
  attempts.set(key, list);
  return list.length >= MAX_FAILS;
}
const recordFail = (key) => attempts.set(key, [...(attempts.get(key) || []), Date.now()]);

router.post('/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    throw badRequest('username and password are required');
  }
  const key = `${req.ip}|${username.toLowerCase()}`;
  if (tooMany(key)) throw new HttpError(429, 'too many failed attempts, try again later');

  const { rows } = await pool.query(
    `SELECT id, username, role, zone_id, post_id, status, password_hash FROM users WHERE username = $1`,
    [username]
  );
  const u = rows[0];
  // Compare even when the user is missing so timing does not reveal which usernames exist.
  const ok = await bcrypt.compare(password, u ? u.password_hash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
  if (!u || !ok || u.status !== 'active') {
    recordFail(key);
    throw unauthorized('invalid username or password');
  }
  if (!RPF_ROLES.includes(u.role)) {
    throw forbidden('this account is not an RPF dashboard user (operators use the CMS console)');
  }
  attempts.delete(key);
  await audit(null, { user: u, action: 'auth.login', entity: 'users', entityId: u.id });
  res.json({ token: signToken(u) });
}));

router.get('/me', requireAuth, (req, res) => {
  const { id, username, role, zone_id, zone_name, post_id, post_name } = req.user;
  res.json({ id, username, role, zone_id, zone_name, post_id, post_name });
});

module.exports = router;
