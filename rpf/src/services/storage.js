/**
 * Resolves delivered_footage.storage_path to a real file under MEDIA_ROOT.
 * Footage is one stitched file per request (RDSO Cl. 3.12). Paths that
 * escape MEDIA_ROOT (.., absolute paths elsewhere, symlinks) are refused.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

async function resolveFootageFile(storagePath) {
  const cleaned = String(storagePath || '').replace(/^file:\/\//, '');
  if (!cleaned) return null;

  let root;
  try {
    root = await fs.promises.realpath(config.mediaRoot);
  } catch (_) {
    return null; // MEDIA_ROOT missing
  }

  const candidate = path.resolve(root, cleaned);
  let real;
  try {
    real = await fs.promises.realpath(candidate);
  } catch (_) {
    return null; // file missing
  }

  const rel = path.relative(root, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

  const stat = await fs.promises.stat(real);
  if (!stat.isFile()) return null;
  return { file: real, size: stat.size, name: path.basename(real) };
}

const MIME = {
  mp4: 'video/mp4',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
};

const mimeFor = (format) => MIME[String(format || '').toLowerCase()] || 'application/octet-stream';
// Browsers reliably play MP4 only; AVI/MKV are download-only in the UI.
const playableInBrowser = (format) => String(format || '').toLowerCase() === 'mp4';

module.exports = { resolveFootageFile, mimeFor, playableInBrowser };
