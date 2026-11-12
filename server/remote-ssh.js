// How to ssh into a remote tab's machine: the same options for the tab's
// helper (bin/dtmux-remote.js) and for the daemon (gh on the machine,
// gh-remote.js), through the same shared connection.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { STATE_DIR } from './paths.js';
import { shellQuote } from './agent-resume.js';
import { kindOf, mux, MUX_DIR } from './remote-kinds.js';

export const KNOWN_HOSTS = path.join(STATE_DIR, 'known_hosts');

// How long to wait before connecting again after `fails` failures in a row
// (1, 2, ...), in ms: 3-5s, then twice as long each time up to 18-30s.
// Spread at random, because tabs lose their connections together (a network
// blip) and their machine's sshd turns away logins that come all at once.
// `rand` in [0, 1).
export function reconnectDelay(fails, rand = Math.random()) {
  const most = Math.min(30000, 5000 * 2 ** Math.max(0, fails - 1));
  return Math.round(most * (0.6 + 0.4 * rand));
}

// ssh's arguments up to and including user@address; a command may follow.
export function sshArgs(remote, host, address) {
  const user = kindOf(remote).user(remote, host);
  return [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`,
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=15',
    ...mux('8h'),
    ...(remote.identity ? ['-o', 'IdentitiesOnly=yes', '-i', remote.identity] : []),
    // Through the jump host's own shared connection (the controller's, often
    // already open), which -J would not reuse. %%C: the inner ssh's token.
    ...(remote.jump
      ? ['-o', `ProxyCommand=ssh ${mux('30m').join(' ').replace('%C', '%%C')} -W '[%h]:%p' ${shellQuote(remote.jump)}`]
      : []),
    `${user}@${address}`,
  ];
}

// Run a bash script on the machine, with `stdin` (a secret goes there, never
// into the command line) -> { code, out, err }. Never prompts.
export function runOnMachine(remote, host, address, script, { stdin = '', timeoutMs = 60000 } = {}) {
  fs.mkdirSync(MUX_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const args = ['-o', 'BatchMode=yes', ...sshArgs(remote, host, address), `bash -c ${shellQuote(script)}`];
  return new Promise((resolve) => {
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      err += `\ntimed out after ${timeoutMs / 1000}s`;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 255, out, err: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 255, out, err });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}
