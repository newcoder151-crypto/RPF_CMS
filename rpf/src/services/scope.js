/**
 * Role -> visibility mapping (design doc "per-post + admin dashboards").
 *
 *   post_user   -> RPF officer: only their own post
 *   zone_admin  -> Thana/zone admin: every post in their zone (read-only)
 *   super_admin -> cross-zone (read-only)
 *   operator    -> CMS console user, not an RPF dashboard user
 */
const { badRequest } = require('../errors');

const isPostUser = (u) => u.role === 'post_user';
const isAdmin = (u) => u.role === 'zone_admin' || u.role === 'super_admin';

/**
 * Appends a scope condition on rpf_post alias `postAlias` to `params` and
 * returns the SQL fragment (never empty; "TRUE" for super_admin).
 * `postFilter` is an optional post id an admin narrows the view to.
 */
function postScopeSql(user, postAlias, params, postFilter) {
  const parts = [];
  if (isPostUser(user)) {
    params.push(user.post_id);
    parts.push(`${postAlias}.id = $${params.length}`);
  } else if (user.role === 'zone_admin') {
    params.push(user.zone_id);
    parts.push(`${postAlias}.zone_id = $${params.length}`);
  }
  if (postFilter != null && postFilter !== '') {
    const id = Number(postFilter);
    if (!Number.isInteger(id)) throw badRequest('post_id must be an integer');
    params.push(id);
    parts.push(`${postAlias}.id = $${params.length}`);
  }
  return parts.length ? parts.join(' AND ') : 'TRUE';
}

/** True if the user may see rows belonging to (postId, zoneId). */
function canSeePost(user, postId, zoneId) {
  if (user.role === 'super_admin') return true;
  if (user.role === 'zone_admin') return Number(user.zone_id) === Number(zoneId);
  if (user.role === 'post_user') return Number(user.post_id) === Number(postId);
  return false;
}

/** Notifications belong to a post (officers) or a zone (admins). */
function notificationScope(user, params, postFilter) {
  const parts = [];
  if (isPostUser(user)) { params.push(user.post_id); parts.push(`n.post_id = $${params.length}`); }
  else if (user.role === 'zone_admin') { params.push(user.zone_id); parts.push(`n.zone_id = $${params.length}`); }
  if (postFilter != null && postFilter !== '') {
    const id = Number(postFilter);
    if (!Number.isInteger(id)) throw badRequest('post_id must be an integer');
    params.push(id); parts.push(`n.post_id = $${params.length}`);
  }
  return parts.length ? parts.join(' AND ') : 'TRUE';
}

module.exports = { isPostUser, isAdmin, postScopeSql, canSeePost, notificationScope };
