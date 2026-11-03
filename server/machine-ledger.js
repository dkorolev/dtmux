// Every remote machine dtmux made, so none is ever left running unseen.
//
// A tab's helper (bin/dtmux-remote.js) records a machine as soon as it is
// known: a LunaNode VM before it is even asked for (its name is chosen up
// front), a devbox account the moment `create` names it. The daemon's sweep
// (machine-sweep.js) deletes recorded machines that no tab, live or dotted,
// stands for any more, and drops entries for machines that are gone.
//
// ~/.dtmux/machines.json: { version: 1, machines: [ { remote, host, at } ] }
// `remote`: the name under `remotes:` in ~/.dtmux.yaml; `at`: unix ms recorded.
// Written by several processes (helpers, the daemon), under a lock file.
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './paths.js';

export const LEDGER_FILE = path.join(STATE_DIR, 'machines.json');
const LOCK = `${LEDGER_FILE}.lock`;

function read() {
  try {
    const data = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
    return (Array.isArray(data?.machines) ? data.machines : []).filter(
      (m) => m && typeof m.remote === 'string' && typeof m.host === 'string' && Number.isFinite(m.at),
    );
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e; // unreadable: better to stop than to forget machines
  }
}

// Run `fn(list) -> new list` under the lock; waits up to ~3 s for it, and
// takes over a lock left behind more than 10 s ago.
function update(fn) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const until = Date.now() + 3000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(LOCK, 'wx'));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > 10000) fs.rmSync(LOCK, { force: true });
      } catch {}
      if (Date.now() > until) throw new Error(`${LOCK} is held by another process`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    const next = fn(read());
    const tmp = `${LEDGER_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, machines: next }, null, 2) + '\n');
    fs.renameSync(tmp, LEDGER_FILE);
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}

const same = (m, remote, host) => m.remote === remote && m.host === host;

export function recordMachine(remote, host) {
  update((list) => (list.some((m) => same(m, remote, host)) ? list : [...list, { remote, host, at: Date.now() }]));
}

export function dropMachine(remote, host) {
  update((list) => list.filter((m) => !same(m, remote, host)));
}

export const listMachines = () => read();
