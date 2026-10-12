const express = require('express');
const { pool } = require('../db');
const { requirePostUser } = require('../middleware/auth');
const { notificationScope } = require('../services/scope');
const { parseLimit } = require('../services/util');
const { wrap } = require('../errors');

const router = express.Router();

/** GET /api/notifications?unread=1&limit= - notices CMS wrote for the caller's post (footage ready, request rejected, ...). */
router.get('/', wrap(async (req, res) => {
  const params = [];
  const where = [notificationScope(req.user, params, req.query.post_id)];
  if (req.query.unread === '1') where.push('n.read_at IS NULL');
  const { rows } = await pool.query(
    `SELECT n.id, n.kind, n.title, n.body, n.ref_entity, n.ref_id, n.created_at, n.read_at, p.name AS post_name
       FROM notification n LEFT JOIN rpf_post p ON p.id = n.post_id
      WHERE ${where.join(' AND ')} ORDER BY n.id DESC LIMIT ${parseLimit(req.query.limit, 30, 100)}`, params);
  res.json(rows);
}));

/** POST /api/notifications/read { ids? } - mark some (or all) of the post's notices read. */
router.post('/read', requirePostUser, wrap(async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : null;
  const { rowCount } = await pool.query(
    `UPDATE notification SET read_at = now(), read_by = $2 WHERE post_id = $1 AND read_at IS NULL ${ids ? 'AND id = ANY($3)' : ''}`,
    ids ? [req.user.post_id, req.user.id, ids] : [req.user.post_id, req.user.id]);
  res.json({ marked: rowCount });
}));

module.exports = router;
