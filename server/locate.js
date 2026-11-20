// Where this process's code lives, and how to start it again.
//
// From the checkout, dtmux is `node` running the files here, and a restart
// runs those files as they are on disk. Inside the single binary (node:sea)
// there is no checkout: a restart runs the binary itself, and the page and
// node-pty come out of the binary rather than node_modules.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';

export function repoRoot() {
  if (isSea()) throw new Error('the dtmux binary has no checkout to read');
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
}

// [executable, argv] for a detached daemon. `node server/daemon.js <port>`
// from the checkout; `<this-binary> --daemon <port>` from the binary.
export function daemonSpawn(port, { restarted = false } = {}) {
  const args = isSea()
    ? ['--daemon', String(port)]
    : [path.join(repoRoot(), 'server', 'daemon.js'), String(port)];
  if (restarted) args.push('--restarted');
  return [process.execPath, args];
}

// [executable, argv before the remote's own arguments] for a remote tab.
export function remoteExec() {
  if (isSea()) return [process.execPath, ['--remote']];
  return [process.execPath, [path.join(repoRoot(), 'bin', 'dtmux-remote.js')]];
}

// What the page shows for starting the daemon again. Quoted for a shell,
// then escaped for the attribute it is written into.
export function startCommand() {
  const bin = isSea() ? process.execPath : path.join(repoRoot(), 'bin', 'dtmux.js');
  const shell = /^[\w/.-]+$/.test(bin) ? bin : `'${bin.replaceAll("'", `'\\''`)}'`;
  return shell.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
