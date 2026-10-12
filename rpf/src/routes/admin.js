const express = require('express');
const { pool } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { postScopeSql } = require('../services/scope');
const { parseLimit } = require('../services/util');
const { wrap } = require('../errors');

const router = express.Router();
router.use(requireAdmin);

/** GET /api/admin/audit?action=&limit= - chain-of-custody trail, zone-scoped for zone admins. */
router.get('/audit', wrap(async (req, res) => {
  const params = [];
  const where = [];
  if (req.user.role === 'zone_admin') {
    params.push(req.user.zone_id);
    where.push(`a.zone_id = $${params.length}`);
  }
  if (req.query.action) {
    params.push(`${String(req.query.action)}%`);
    where.push(`a.action LIKE $${params.length}`);
  }
  const limit = parseLimit(req.query.limit, 100, 500);
  const { rows } = await pool.query(
    `SELECT a.id, a.occurred_at, a.action, a.entity, a.entity_id, a.zone_id, a.details,
            u.username AS actor_username
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY a.id DESC LIMIT ${limit}`,
    params
  );
  res.json(rows);
}));

module.exports = router;
