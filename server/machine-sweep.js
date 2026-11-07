// Deletes remote machines that dtmux made and no tab stands for any more.
//
// Closing a tab for good deletes its machine at once (tmux-session.js), but
// a tab can also go without that: tmux's own kill-window, its helper dying,
// the tab closed while its machine was still being made. This sweep catches
// all of those. A machine recorded in the ledger (machine-ledger.js) is kept
// while a live window (the @dtmux_remote option), a dotted tab (saved
// windows) or the crash snapshot names it. One that none names in two sweeps
// in a row, and that was recorded minutes ago, is deleted, unless its kind
// says not to (devbox accounts: they expire on their own when idle); one
// that is gone already (expired, deleted elsewhere) just leaves the ledger.
import { execFile } from 'node:child_process';
import { TMUX_BIN, tmuxArgs } from './tmux-control.js';
import { allSaved } from './saved-windows.js';
import { readSnapshot } from './live-snapshot.js';
import { REMOTE_OPTION, parseRemote, currentRemotes } from './remotes.js';
import { kindOf, deleteMachine } from './remote-kinds.js';
import { listMachines, dropMachine } from './machine-ledger.js';

// DTMUX_SWEEP_MS: a shorter interval, for trying it out.
export const SWEEP_MS = Number(process.env.DTMUX_SWEEP_MS) || 2 * 60000;
const MIN_AGE_MS = 1.5 * SWEEP_MS; // a tab that just made its machine may not name it yet

const key = (remote, host) => `${remote}/${host}`;

// `name/host` of every remote window tmux has, or null when tmux could not
// say (then nothing is swept). No tmux server: no live windows.
function liveRemotes() {
  return new Promise((resolve) => {
    execFile(TMUX_BIN, tmuxArgs('list-windows', '-a', '-F', `#{${REMOTE_OPTION}}`), { timeout: 5000 }, (err, out, stderr) => {
      if (err) return resolve(/no server running|error connecting/.test(stderr) ? [] : null);
      resolve(out.split('\n').map(parseRemote).filter(Boolean).map((r) => key(r.name, r.host)));
    });
  });
}

// The keys of machines some tab stands for, or null when that is not known.
async function wanted() {
  const live = await liveRemotes();
  if (!live) return null;
  const keep = new Set(live);
  for (const e of allSaved()) if (e.remote) keep.add(key(e.remote.name, e.remote.host));
  for (const w of readSnapshot()?.live ?? []) if (w.remote) keep.add(key(w.remote.name, w.remote.host));
  return keep;
}

const unseen = new Set(); // keys no tab named in the last sweep
const leftAlone = new Set(); // tabless machines of kinds the sweep does not delete, already logged

export async function sweepMachines(log) {
  let machines, remotes;
  try {
    machines = listMachines();
    if (!machines.length) return unseen.clear();
    remotes = currentRemotes();
  } catch (e) {
    return log(`machine sweep skipped: ${e.message}`);
  }
  const keep = await wanted();
  if (!keep) return log('machine sweep skipped: tmux did not list its windows');
  const now = Date.now();
  const missing = machines.filter((m) => !keep.has(key(m.remote, m.host)) && now - m.at > MIN_AGE_MS);
  const before = new Set(unseen);
  unseen.clear();
  for (const m of missing) {
    const k = key(m.remote, m.host);
    unseen.add(k);
    if (!before.has(k)) continue; // twice in a row before acting
    const remote = remotes[m.remote];
    if (!remote) {
      log(`machine sweep: ${k} has no tab, but "${m.remote}" is not in the config any more; left alone`);
      continue;
    }
    const kind = kindOf(remote);
    try {
      const found = await kind.lookup(remote, m.host);
      if (found.making) continue; // delete it once it is made
      if (found.address && kind.sweep === false) {
        // Left alone (see the kind); said once, not every sweep.
        if (!leftAlone.has(k)) log(`machine sweep: no tab stands for ${remote.label} ${kind.noun} ${m.host}; left alone (${kind.lifetime(remote)})`);
        leftAlone.add(k);
        continue;
      }
      if (found.address) await deleteMachine(remote, m.host, 'machine sweep: no tab stands for it, in two sweeps in a row');
      dropMachine(m.remote, m.host);
      unseen.delete(k);
    } catch (e) {
      log(`machine sweep: ${k}: ${e.message}; trying again later`);
    }
  }
}
