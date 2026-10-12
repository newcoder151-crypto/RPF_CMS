const jwt = require('jsonwebtoken');
const config = require('../config');
const { pool } = require('../db');
const { unauthorized, forbidden, wrap } = require('../errors');

// Roles allowed into the RPF dashboard. 'operator' is a CMS console role.
const RPF_ROLES = ['post_user', 'zone_admin', 'super_admin'];

function signToken(user) {
  return jwt.sign({ sub: user.id }, config.jwtSecret, {
    expiresIn: `${config.sessionHours}h`,
    issuer: 'rpf-dashboard',
  });
}

/** Loads the user fresh from the DB on every request, so a disabled account loses access immediately. */
const requireAuth = wrap(async (req, res, next) => {
  const header = req.get('authorization') || '';
  const m = header.match(/^Bearer (.+)$/i);
  if (!m) throw unauthorized();

  let payload;
  try {
    payload = jwt.verify(m[1], config.jwtSecret, { issuer: 'rpf-dashboard' });
  } catch (_) {
    throw unauthorized('session expired or invalid');
  }

  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.role, u.zone_id, u.post_id, u.status,
            z.name AS zone_name, p.name AS post_name
       FROM users u
       LEFT JOIN zone z ON z.id = u.zone_id
       LEFT JOIN rpf_post p ON p.id = u.post_id
      WHERE u.id = $1`,
    [payload.sub]
  );
  const user = rows[0];
  if (!user || user.status !== 'active' || !RPF_ROLES.includes(user.role)) {
    throw unauthorized('account not active');
  }
  // A zone/super admin may WORK AS a post (header X-Act-As-Post): they then get that post's officer powers, scoped to that
  // post only. Everything is still recorded under their own account, marked as acting for the post.
  const act = req.get('x-act-as-post');
  if (act && ['zone_admin', 'super_admin'].includes(user.role)) {
    const postId = Number(act);
    if (!Number.isInteger(postId)) throw forbidden('invalid post');
    const pr = await pool.query(`SELECT p.id, p.name, p.zone_id, z.name AS zone_name FROM rpf_post p JOIN zone z ON z.id = p.zone_id WHERE p.id = $1 AND p.active`, [postId]);
    const post = pr.rows[0];
    if (!post || (user.role === 'zone_admin' && Number(post.zone_id) !== Number(user.zone_id))) throw forbidden('that post is not in your scope');
    req.user = { ...user, real_role: user.role, role: 'post_user', acting: true, post_id: post.id, post_name: post.name, zone_id: post.zone_id, zone_name: post.zone_name };
    return next();
  }
  req.user = user;
  next();
});

/** Only officers (post_user) may change state; admins are read-only in RPF. */
function requirePostUser(req, res, next) {
  if (req.user.role !== 'post_user') {
    return next(forbidden('only RPF post officers can perform this action'));
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'zone_admin' && req.user.role !== 'super_admin') {
    return next(forbidden('admin access required'));
  }
  next();
}

module.exports = { requireAuth, requirePostUser, requireAdmin, signToken, RPF_ROLES };
