// Tabs that live on a remote machine. Such a tab is an ordinary tmux window
// here whose pane runs bin/dtmux-remote.js: it makes or finds the VM and
// ssh-es into it, where the shells run in the VM's own tmux. The window
// option @dtmux_remote ("<remote>/<host>") marks it, so saving the window
// (a Disconnect, a full restart) remembers the VM and reopening the tab joins
// that same VM again.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, CONFIG_PATH } from './config.js';
import { STATE_DIR } from './paths.js';
import { shellQuote } from './agent-resume.js';
import { isRemoteAddress } from './remote-config.js';
import { kindOf } from './remote-kinds.js';

export const REMOTE_OPTION = '@dtmux_remote';
// Set by the helper once it knows them: the VM's address, so joining it again
// needs no controller, and since when it has been up (unix seconds).
export const REMOTE_ADDR_OPTION = '@dtmux_remote_addr';
export const REMOTE_UP_OPTION = '@dtmux_remote_up';
// "ended" while the session on the machine has ended and the tab waits for
// you to reconnect or delete the machine.
export const REMOTE_STATE_OPTION = '@dtmux_remote_state';
// All four in one tmux format; parseRemote reads what it gives.
export const REMOTE_FORMAT = `#{${REMOTE_OPTION}}|#{${REMOTE_ADDR_OPTION}}|#{${REMOTE_UP_OPTION}}|#{${REMOTE_STATE_OPTION}}`;
// What the page's control client subscribes to (refresh-client -B), to hear
// at once when the helper changes them: options change no other notification.
export const REMOTE_SUBSCRIPTION = `dtmux-remote:@*:#{${REMOTE_ADDR_OPTION}}|#{${REMOTE_UP_OPTION}}|#{${REMOTE_STATE_OPTION}}`;

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dtmux-remote.js');

// "lunanode/dtmux-1a2b3c4d", or REMOTE_FORMAT's "lunanode/dtmux-1a2b3c4d|addr|up|state",
// -> { name, host, address, upSince, ended }; anything else -> null.
export function parseRemote(value) {
  const [where, addr = '', up = '', state = ''] = String(value ?? '').split('|');
  const m = /^([a-z][a-z0-9-]{0,30})\/([a-z0-9][a-z0-9.-]{0,62})$/.exec(where);
  if (!m) return null;
  return {
    name: m[1],
    host: m[2],
    address: isRemoteAddress(addr) ? addr : null,
    upSince: /^\d{9,11}$/.test(up) ? Number(up) : null,
    ended: state === 'ended',
  };
}

export const remoteValue = ({ name, host }) => `${name}/${host}`;

// The remotes ~/.dtmux.yaml has now (read fresh, so edits count without a
// restart). Throws ConfigError when the file is invalid.
export const currentRemotes = () => loadConfig().remotes ?? {};

// The name a new tab of `remote` starts with (its kind decides).
export const newHost = (remote) => kindOf(remote).newHost(remote);

// The shell command a remote tab's pane runs. `create`: make the VM if it
// does not exist yet (a new tab); otherwise only join it (a reopened tab),
// straight at its known address when there is one.
export function remoteCommand({ name, host, address, upSince }, { create = false } = {}) {
  const env = `DTMUX_CONFIG=${shellQuote(CONFIG_PATH)} DTMUX_STATE_DIR=${shellQuote(STATE_DIR)}`;
  const known = [...(address ? ['--addr', address] : []), ...(upSince ? ['--up', String(upSince)] : [])];
  const args = [name, host, ...(create ? ['--new'] : known)].map(shellQuote).join(' ');
  return `${env} exec ${shellQuote(process.execPath)} ${shellQuote(HELPER)} ${args}`;
}
