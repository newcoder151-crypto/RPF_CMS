const express = require('express');
const { pool, withTransaction } = require('../db');
const { requirePostUser } = require('../middleware/auth');
const { ALERT_SELECT, ackDelivery } = require('../services/alerts');
const { REQUEST_SELECT, footageForRequests } = require('../services/requests');
const { postScopeSql, canSeePost, notificationScope } = require('../services/scope');
const { audit } = require('../services/audit');
const { parseId, parseLimit, requireText } = require('../services/util');
const { setAlertStatus } = require('../services/alerts');
const { badRequest, notFound, forbidden, wrap } = require('../errors');

const router = express.Router();

const STATE_FILTERS = {
  unacked: "(d.ack_at IS NULL AND a.status IN ('routed','escalated'))",
  // an alert is "closed" once its incident is closed, or it was resolved at the post / dismissed by CMS
  active: "((i.status IS NULL OR i.status <> 'closed') AND a.status NOT IN ('resolved','dismissed'))",
  closed: "(i.status = 'closed' OR a.status IN ('resolved','dismissed'))",
  all: 'TRUE',
};

/** GET /api/alerts?state=active|unacked|closed|all&post_id=&limit= - the alert inbox. */
router.get('/', wrap(async (req, res) => {
  const state = req.query.state || 'active';
  if (!STATE_FILTERS[state]) throw badRequest(`state must be one of ${Object.keys(STATE_FILTERS).join(', ')}`);
  const params = [];
  const scope = postScopeSql(req.user, 'p', params, req.query.post_id);
  const limit = parseLimit(req.query.limit);
  const base = `${ALERT_SELECT} WHERE ${scope} AND ${STATE_FILTERS[state]}`;
  // An escalated alert is delivered to several posts. An admin looking across posts sees each ALERT once
  // (so the list, the tile and CMS all count the same thing); an officer sees their own post's delivery.
  const sql = req.user.role === 'post_user'
    ? `${base} ORDER BY d.id DESC LIMIT ${limit}`
    : `SELECT * FROM (SELECT DISTINCT ON (q.alert_id) q.* FROM (${base}) q ORDER BY q.alert_id, q.delivery_id DESC) z ORDER BY z.delivery_id DESC LIMIT ${limit}`;
  const { rows } = await pool.query(sql, params);
  res.json(rows);
}));

/**
 * GET /api/alerts/summary - cheap counters the browser polls. A changed
 * last_delivery_id means a new alert arrived; a changed last_footage_id
 * means CMS delivered footage.
 */
router.get('/summary', wrap(async (req, res) => {
  const params = [];
  const scope = postScopeSql(req.user, 'p', params, req.query.post_id);
  const nParams = []; const nScope = notificationScope(req.user, nParams, req.query.post_id);
  const [alerts, reqs, footage, notes] = await Promise.all([
    pool.query(
      `SELECT COUNT(DISTINCT d.alert_id) FILTER (WHERE d.ack_at IS NULL AND a.status IN ('routed','escalated')) AS unacked,
              COUNT(DISTINCT d.alert_id) FILTER (WHERE (i.status IS NULL OR i.status <> 'closed') AND a.status NOT IN ('resolved','dismissed')) AS active,
              COALESCE(MAX(d.id), 0) AS last_delivery_id
         FROM alert_delivery d
         JOIN alert a ON a.id = d.alert_id AND a.event_time = d.alert_event_time
         JOIN rpf_post p ON p.id = d.post_id
         LEFT JOIN LATERAL (SELECT status FROM incident WHERE alert_delivery_id = d.id ORDER BY id LIMIT 1) i ON TRUE
        WHERE ${scope}`, params),
    pool.query(
      `SELECT COUNT(*) AS open_requests FROM video_request r JOIN rpf_post p ON p.id = r.post_id
        WHERE ${scope} AND r.status IN ('submitted','approved','amended','awaiting_upload')`, params),
    pool.query(
      `SELECT COALESCE(MAX(f.id), 0) AS last_footage_id
         FROM delivered_footage f
         JOIN video_request r ON r.id = f.video_request_id
         JOIN rpf_post p ON p.id = r.post_id
        WHERE ${scope}`, params),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE n.read_at IS NULL) AS unread_notifications, COALESCE(MAX(n.id), 0) AS last_notification_id
         FROM notification n WHERE ${nScope}`, nParams),
  ]);
  res.json({ ...alerts.rows[0], ...reqs.rows[0], ...footage.rows[0], ...notes.rows[0] });
}));

/** GET /api/alerts/:deliveryId - one alert with its incident, requests, footage and status history. */
router.get('/:deliveryId', wrap(async (req, res) => {
  const id = parseId(req.params.deliveryId, 'deliveryId');
  const { rows } = await pool.query(`${ALERT_SELECT} WHERE d.id = $1`, [id]);
  const alert = rows[0];
  // 404 (not 403) for out-of-scope rows so ids of other posts are not confirmed to exist.
  if (!alert || !canSeePost(req.user, alert.post_id, alert.zone_id)) throw notFound('alert not found');

  const [reqs, history] = await Promise.all([
    pool.query(`${REQUEST_SELECT} WHERE r.alert_id = $1 AND r.post_id = $2 ORDER BY r.id DESC`, [alert.alert_id, alert.post_id]),
    pool.query(
      `SELECT h.changed_at, h.from_status, h.to_status, h.note, u.username AS changed_by_username
         FROM alert_history h LEFT JOIN users u ON u.id = h.changed_by
        WHERE h.alert_id = $1 AND h.alert_event_time = $2 ORDER BY h.id`,
      [alert.alert_id, alert.alert_event_time]),
  ]);
  const footage = await footageForRequests(reqs.rows.map((r) => r.id));
  res.json({ alert, requests: reqs.rows, footage, history: history.rows });
}));

/** POST /api/alerts/:deliveryId/ack - officer acknowledges the alert (stops CMS escalation clock). */
router.post('/:deliveryId/ack', requirePostUser, wrap(async (req, res) => {
  const id = parseId(req.params.deliveryId, 'deliveryId');
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, alert_id, alert_event_time, post_id, ack_at FROM alert_delivery WHERE id = $1 FOR UPDATE`,
      [id]
    );
    const d = rows[0];
    if (!d || d.post_id !== req.user.post_id) throw notFound('alert not found');
    const did = await ackDelivery(client, req.user, d, req.body && req.body.note);
    if (!did) throw badRequest('alert was already acknowledged');
    await audit(client, { user: req.user, action: 'alert.ack', entity: 'alert_delivery', entityId: id, details: { alert_id: d.alert_id } });
  });
  res.json({ ok: true });
}));

async function myDelivery(client, user, id) {
  const { rows } = await client.query(
    `SELECT d.id, d.alert_id, d.alert_event_time, d.post_id, d.ack_at, a.status AS alert_status
       FROM alert_delivery d JOIN alert a ON a.id = d.alert_id AND a.event_time = d.alert_event_time WHERE d.id = $1 FOR UPDATE OF d`, [id]);
  const d = rows[0];
  if (!d || d.post_id !== user.post_id) throw notFound('alert not found');
  return d;
}

/** POST /api/alerts/:deliveryId/notes { text } - "what was done": a dated note on the alert, visible to CMS in its history. */
router.post('/:deliveryId/notes', requirePostUser, wrap(async (req, res) => {
  const id = parseId(req.params.deliveryId, 'deliveryId');
  const text = requireText(req.body && req.body.text, 'text', 1000);
  await withTransaction(async (client) => {
    const d = await myDelivery(client, req.user, id);
    await client.query(
      `INSERT INTO alert_history (alert_id, alert_event_time, changed_by, from_status, to_status, note) VALUES ($1,$2,$3,$4,$4,$5)`,
      [d.alert_id, d.alert_event_time, req.user.id, d.alert_status, `Action note: ${text}`]);
    await audit(client, { user: req.user, action: 'alert.note', entity: 'alert_delivery', entityId: id, details: { alert_id: d.alert_id, text } });
  });
  res.status(201).json({ ok: true });
}));

/** POST /api/alerts/:deliveryId/resolve { note } - close an alert that needs no incident, recording the action taken. */
router.post('/:deliveryId/resolve', requirePostUser, wrap(async (req, res) => {
  const id = parseId(req.params.deliveryId, 'deliveryId');
  const note = requireText(req.body && req.body.note, 'note (what was done)', 1000);
  await withTransaction(async (client) => {
    const d = await myDelivery(client, req.user, id);
    const { rows: inc } = await client.query(`SELECT id FROM incident WHERE alert_delivery_id = $1 AND status <> 'closed' LIMIT 1`, [id]);
    if (inc.length) throw badRequest(`incident #${inc[0].id} is still open - close the incident instead (it resolves the alert)`);
    if (['resolved', 'dismissed'].includes(d.alert_status)) throw badRequest(`this alert is already ${d.alert_status}`);
    await ackDelivery(client, req.user, d, null);
    await setAlertStatus(client, req.user, d.alert_id, d.alert_event_time, 'resolved', null, `Resolved: ${note}`);
    await audit(client, { user: req.user, action: 'alert.resolve', entity: 'alert_delivery', entityId: id, details: { alert_id: d.alert_id, note } });
  });
  res.json({ ok: true });
}));

module.exports = router;
