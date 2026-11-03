// Tabs that live on a remote machine. Such a tab is an ordinary tmux window
// here whose pane runs bin/dtmux-remote.js: it makes or finds the VM and
// ssh-es into it, where the shells run in the VM's own tmux. The window
// option @dtmux_remote ("<remote>/<host>") marks it, so saving the window
// (a Disconnect, a full restart) remembers the VM and reopening the tab joins
// that same VM again.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, CONFIG_PATH } from './config.js';
import { STATE_DIR } from './paths.js';
import { shellQuote } from './agent-resume.js';

export const REMOTE_OPTION = '@dtmux_remote';
const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dtmux-remote.js');

// "lunanode/dtmux-1a2b3c4d" -> { name, host }; anything else -> null.
export function parseRemote(value) {
  const m = /^([a-z][a-z0-9-]{0,30})\/([a-z0-9][a-z0-9.-]{0,62})$/.exec(String(value ?? ''));
  return m ? { name: m[1], host: m[2] } : null;
}

export const remoteValue = ({ name, host }) => `${name}/${host}`;

// The remotes ~/.dtmux.yaml has now (read fresh, so edits count without a
// restart). Throws ConfigError when the file is invalid.
export const currentRemotes = () => loadConfig().remotes ?? {};

export const newHost = (remote) => `${remote.hostPrefix}-${randomBytes(4).toString('hex')}`;

// The shell command a remote tab's pane runs. `create`: make the VM if it
// does not exist yet (a new tab); otherwise only join it (a reopened tab).
export function remoteCommand({ name, host }, { create = false } = {}) {
  const env = `DTMUX_CONFIG=${shellQuote(CONFIG_PATH)} DTMUX_STATE_DIR=${shellQuote(STATE_DIR)}`;
  return `${env} exec ${shellQuote(process.execPath)} ${shellQuote(HELPER)} ${shellQuote(name)} ${shellQuote(host)}${create ? ' --new' : ''}`;
}
