const express = require('express');
const { pool } = require('../db');
const config = require('../config');
const { postScopeSql } = require('../services/scope');
const { wrap } = require('../errors');
const { hasFfmpeg } = require('../services/clip');
const pkg = require('../../package.json');

const router = express.Router();

router.get('/config', wrap(async (req, res) => {
  res.json({ version: config.version, clipDownload: await hasFfmpeg(),
    alertPollSeconds: config.alertPollSeconds,
    maxRequestWindowMin: config.maxRequestWindowMin,
    defaultRetentionDays: config.defaultRetentionDays,
    footageLinkMinutes: config.footageLinkMinutes,
  });
}));

router.get('/posts', wrap(async (req, res) => {
  const params = [];
  const scope = postScopeSql(req.user, 'p', params);
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.zone_id, z.name AS zone_name
       FROM rpf_post p JOIN zone z ON z.id = p.zone_id
      WHERE p.active AND ${scope} ORDER BY p.zone_id, p.name`,
    params
  );
  res.json(rows);
}));

// Cameras a post may request footage for: active cameras on NVR units
// currently assigned to the caller's zone (all zones for super_admin).
router.get('/cameras', wrap(async (req, res) => {
  const params = [];
  let where = 'c.active';
  if (req.user.role !== 'super_admin') {
    params.push(req.user.zone_id);
    where += ` AND n.current_zone_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.mount_position, n.id AS nvr_id, n.name AS nvr_name, n.train_no, n.current_zone_id AS zone_id
       FROM camera c JOIN nvr_unit n ON n.id = c.nvr_id
      WHERE ${where} ORDER BY n.name, c.name`,
    params
  );
  res.json(rows);
}));

module.exports = router;
