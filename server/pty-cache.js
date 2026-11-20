// node-pty's native half cannot be dlopen'd from inside the binary, so the
// first run writes it under ~/.dtmux/native/<hash>/ (not a node_modules, so
// a cleanup of those leaves it). Deleting the directory only costs the next
// start a rewrite from the bytes in the binary.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { getAsset, getAssetKeys } from 'node:sea';
import { STATE_DIR } from './paths.js';

const PREFIX = 'pty/';

export function ensurePty() {
  const keys = getAssetKeys().filter((key) => key.startsWith(PREFIX)).sort();
  if (!keys.length) throw new Error('this dtmux binary has no pty files in it');
  const hash = createHash('sha256');
  const blobs = new Map();
  for (const key of keys) {
    const data = Buffer.from(getAsset(key));
    blobs.set(key, data);
    hash.update(key);
    hash.update(data);
  }
  const dir = path.join(STATE_DIR, 'native', hash.digest('hex').slice(0, 16));
  const ready = path.join(dir, 'lib', 'index.js');
  if (fs.existsSync(ready) && helperOk(dir)) return dir;
  fs.rmSync(dir, { recursive: true, force: true });

  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [key, data] of blobs) {
    const file = path.join(tmp, key.slice(PREFIX.length));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data, { mode: path.basename(file) === 'spawn-helper' ? 0o755 : 0o644 });
  }
  const helper = helperPath(tmp);
  if (fs.existsSync(helper)) spawnSync('codesign', ['--sign', '-', '--force', helper], { stdio: 'ignore' });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.renameSync(tmp, dir);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!fs.existsSync(ready)) throw err;
  }
  return dir;
}

function helperPath(dir) {
  return path.join(dir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
}

function helperOk(dir) {
  try {
    fs.accessSync(helperPath(dir), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
