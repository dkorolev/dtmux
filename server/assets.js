// The files the page runs: public/, and the xterm.js bundles. From the
// checkout they are read off disk, so a soft restart serves whatever is
// there now. The single binary carries the same bytes and serves those.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isSea, getAsset, getAssetKeys } from 'node:sea';
import { repoRoot } from './locate.js';

// URL path under /vendor/ -> path relative to the checkout root. The binary
// build embeds these same paths, so the two cannot drift.
export const VENDOR = {
  'xterm.mjs': 'node_modules/@xterm/xterm/lib/xterm.mjs',
  'xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  'addon-fit.mjs': 'node_modules/@xterm/addon-fit/lib/addon-fit.mjs',
  'addon-web-links.mjs': 'node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs',
  'addon-webgl.mjs': 'node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs',
};

function seaHas(key) {
  try {
    getAsset(key);
    return true;
  } catch {
    return false;
  }
}

export function readRepoFile(rel) {
  if (isSea()) return Buffer.from(getAsset(rel));
  return fs.readFileSync(path.join(repoRoot(), rel));
}

export function repoFileExists(rel) {
  if (isSea()) return seaHas(rel);
  try {
    fs.accessSync(path.join(repoRoot(), rel));
    return true;
  } catch {
    return false;
  }
}

// Paths under public/, with '/' separators, in the order a directory walk
// visits them (each directory's names sorted). The page's build id is a
// hash of this, so the walk has to stay stable.
function publicRelPaths() {
  if (isSea()) {
    return getAssetKeys()
      .filter((key) => key.startsWith('public/') && key.length > 'public/'.length)
      .map((key) => key.slice('public/'.length))
      .sort((a, b) => a.localeCompare(b));
  }
  const pub = path.join(repoRoot(), 'public');
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(file);
      else if (ent.isFile()) out.push(path.relative(pub, file).split(path.sep).join('/'));
    }
  };
  walk(pub);
  return out;
}

export function pageFingerprint() {
  try {
    const hash = createHash('sha1');
    for (const rel of publicRelPaths()) hash.update(rel).update('\0').update(readRepoFile(`public/${rel}`));
    return hash.digest('hex').slice(0, 12);
  } catch {
    return '';
  }
}

// The commit baked into the binary, or null when running from the checkout
// (there the page reads git, so it follows the worktree).
export function bakedCommit() {
  if (!isSea()) return null;
  try {
    return Buffer.from(getAsset('meta/commit')).toString('utf8').trim();
  } catch {
    return '';
  }
}

export function gitCommit() {
  const opts = { cwd: repoRoot(), encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], opts).trim().slice(0, 7);
    if (!/^[0-9a-f]{7}$/.test(hash)) return '';
    const dirty = execFileSync('git', ['status', '--porcelain'], opts).trim() ? '-dirty' : '';
    return hash + dirty;
  } catch {
    return '';
  }
}
