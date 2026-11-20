// A daemon started from the checkout hands itself to the single binary when
// ~/.dtmux/use-binary names one. The daemon it replaces does not know about
// the binary: it always starts server/daemon.js, and this file is what that
// process runs first, so tmux is never stopped on the way over.
// DTMUX_FROM_SOURCE=1 keeps the checkout's own code.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isSea } from 'node:sea';
import { STATE_DIR, LOG_FILE } from './paths.js';

export const USE_BINARY = path.join(STATE_DIR, 'use-binary');

// Spawns the binary and returns true when this process should exit without
// listening. False when there is nothing to hand over to.
export function maybeHandoffToBinary() {
  if (isSea() || process.env.DTMUX_FROM_SOURCE) return false;
  let target;
  try {
    target = fs.readFileSync(USE_BINARY, 'utf8').trim();
  } catch {
    return false;
  }
  if (!target) return false;
  try {
    fs.accessSync(target, fs.constants.X_OK);
  } catch {
    return false;
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(target, ['--daemon', ...process.argv.slice(2)], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  return true;
}
