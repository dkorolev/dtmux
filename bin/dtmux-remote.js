#!/usr/bin/env node
// Runs inside a dtmux tab that lives on a remote machine: makes or finds the
// machine, then ssh-es into its tmux, and back in when the connection drops.
//
//   dtmux-remote.js <remote> <host> [--new | --addr <address> [--up <secs>]]
//
// <remote> names an entry of `remotes:` in ~/.dtmux.yaml (see
// server/remote-config.js), <host> the machine; how machines of its kind are
// made, found and named is in server/remote-kinds.js. With --new the machine
// is made when it does not exist yet; without it (reopening a saved tab) a
// missing machine is reported and only made again when you say so.
// With --addr (reopening a tab that knew its machine) ssh goes straight
// there; the controller is only asked when that address does not answer.
//
// Joining is quick because ssh connections stay open: one master connection
// per host (ssh ControlMaster, kept for hours after the last tab leaves), so
// a tab joining again reuses it instead of logging in again, which over a
// long round trip takes seconds.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadConfig } from '../server/config.js';
import { STATE_DIR } from '../server/paths.js';
import { shellQuote } from '../server/agent-resume.js';
import { kindOf, mux, MUX_DIR, transient } from '../server/remote-kinds.js';

const [name, firstHost, ...flags] = process.argv.slice(2);
const flag = (f) => (flags.includes(f) ? flags[flags.indexOf(f) + 1] ?? null : null);
const KNOWN_HOSTS = path.join(STATE_DIR, 'known_hosts');
const KEEPALIVE_MS = 30 * 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text, color = '36') => process.stdout.write(`\x1b[${color}m▸ ${text}\x1b[0m\r\n`);
const warn = (text) => say(text, '33');

let host = firstHost;
let remote;
let kind;
let mayCreate = flags.includes('--new');

async function main() {
  if (!name || !host) throw new Error('usage: dtmux-remote.js <remote> <host> [--new | --addr <address> [--up <secs>]]');
  remote = loadConfig().remotes?.[name];
  if (!remote) throw new Error(`No remote "${name}" in ${process.env.DTMUX_CONFIG || '~/.dtmux.yaml'} (remotes: ...).`);
  kind = kindOf(remote);
  fs.mkdirSync(MUX_DIR, { recursive: true, mode: 0o700 });
  const known = flag('--addr');
  if (known) {
    say(`Joining ${remote.label} ${kind.noun} ${host}…`);
    const up = Number(flag('--up'));
    tmux('set-option', '-w', '@dtmux_remote_addr', known);
    if (up) tmux('set-option', '-w', '@dtmux_remote_up', String(up));
    if ((await connect(known, false, { probe: true })) !== 'unreachable') return;
    warn(`${known} does not answer; asking the controller about ${host}…`);
  } else say(`${remote.label} ${kind.noun} ${host}: asking the controller (${remote.controller.join(' ')})…`);
  // The controller is reached over the network, and making a machine can take
  // minutes: a dropped connection to it is retried, picking up where things are.
  for (;;) {
    try {
      const m = await settle();
      if (!m) return;
      tmux('set-option', '-w', '@dtmux_remote_addr', m.address);
      if (m.upSince) tmux('set-option', '-w', '@dtmux_remote_up', String(m.upSince));
      await connect(m.address, m.fresh);
      return;
    } catch (e) {
      if (!transient(e)) throw e;
      warn(`Lost touch with the controller (${e.message}); trying again in 10s…`);
      await sleep(10000);
    }
  }
}

// Make or find the machine: { address, upSince, fresh } (fresh: just made),
// or null when you chose to close the tab instead of making a new one.
async function settle() {
  const found = await kind.lookup(remote, host, say);
  if (found.address) return found;
  if (found.making) {
    say(`${host} is being made; waiting for it…`);
    return found.making();
  }
  if (found.none && mayCreate) return make();
  warn(found.gone ?? `${host} is not there.`);
  const again = `Press Enter to make a new ${remote.label} ${kind.noun} (${kind.lifetime(remote)}), Ctrl+C to close this tab.`;
  if (!(await ask(again))) return null;
  host = kind.newHost(remote);
  adopt(host);
  mayCreate = true;
  return make();
}

async function make() {
  const m = await kind.create(remote, host, say);
  if (m.host !== host) {
    host = m.host;
    adopt(host);
  }
  return m;
}

// This tab now stands for another machine: tell dtmux (the window option it
// saves) and rename the tab.
function adopt(newHost) {
  tmux('set-option', '-w', '@dtmux_remote', `${name}/${newHost}`);
  tmux('set-option', '-wu', '@dtmux_remote_addr');
  tmux('set-option', '-wu', '@dtmux_remote_up');
  tmux('rename-window', newHost);
}

// A command on this tab's own window, in dtmux's tmux.
function tmux(cmd, ...args) {
  const pane = process.env.TMUX_PANE;
  if (pane) spawnSync(process.env.TMUX_BIN || 'tmux', [cmd, '-t', pane, ...args], { stdio: 'ignore' });
}

// ssh into the machine's tmux until its shell ends, connecting again when
// the connection drops. `probe`: give up with 'unreachable' if the very
// first try cannot connect, for the caller to ask the controller instead.
async function connect(address, fresh, { probe = false } = {}) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // VM addresses are reused: a new VM at an old address has a new host key.
  if (fresh) spawnSync('ssh-keygen', ['-R', address, '-f', KNOWN_HOSTS], { stdio: 'ignore' });
  const user = kind.user(remote, host);
  const base = [
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
  // An account deleted when idle stays alive while its tab is connected.
  const touch = () => spawn('ssh', [...base, 'touch .dtmux-alive'], { stdio: 'ignore' }).on('error', () => {});
  const keepAlive = kind.keepAlive ? setInterval(touch, KEEPALIVE_MS) : null;
  const started = Date.now();
  let tries = 0;
  let booting = false;
  try {
    for (;;) {
      if (!booting && (tries || !probe)) say(`ssh ${user}@${address}${remote.jump ? ` via ${remote.jump}` : ''}  (${remote.label} ${kind.noun} ${host})`);
      // Once ssh is in (and its shared connection up), not alongside it.
      const first = kind.keepAlive ? setTimeout(touch, 10000) : null;
      // Ctrl+C belongs to the remote side while ssh runs.
      const keep = () => {};
      process.on('SIGINT', keep);
      const code = await new Promise((resolve) => {
        const child = spawn('ssh', ['-t', ...base, remote.attach], { stdio: 'inherit' });
        child.on('error', () => resolve(255));
        child.on('close', (c) => resolve(c ?? 255));
      });
      process.off('SIGINT', keep);
      clearTimeout(first);
      if (code !== 255) {
        // The session there ended (its last shell exited, or it was detached).
        // The tab stays, so the machine is not forgotten while it still runs.
        const next = await ended();
        if (next === 'reconnect') {
          tries = 0;
          continue;
        }
        return;
      }
      tries++;
      if (probe && tries === 1) return 'unreachable';
      // A new VM's sshd takes a moment to come up.
      if (fresh && Date.now() - started < 180000) {
        if (!booting) say(`Waiting for the new ${kind.noun} to let ssh in…`);
        booting = true;
        await sleep(3000);
        continue;
      }
      booting = false;
      if (tries % 5 === 0) {
        const now = await kind.lookup(remote, host).catch(() => ({ address }));
        if (now.gone) {
          warn(now.gone);
          return finish();
        }
      }
      warn('The connection dropped; connecting again in 5s (Ctrl+C closes this tab)…');
      await sleep(5000);
    }
  } finally {
    clearInterval(keepAlive);
  }
}

// The session on the machine has ended: reconnect (Enter), delete the
// machine (d), or close the tab and leave the machine running (Ctrl+C). The
// page shows the same choices as buttons on the tab (see the window option).
async function ended() {
  tmux('set-option', '-w', '@dtmux_remote_state', 'ended');
  try {
    for (;;) {
      say(`The session on ${remote.label} ${kind.noun} ${host} has ended; the ${kind.noun} is still there (${kind.lifetime(remote)}).`);
      const key = await askKey(`Enter: reconnect · d: delete the ${kind.noun} · Ctrl+C: close this tab and leave the ${kind.noun} running`, ['\r', '\n', 'd', 'D', '\x03', '\x04']);
      if (key === '\r' || key === '\n') return 'reconnect';
      if (key === '\x03' || key === '\x04') return 'close';
      say(`Deleting ${host}…`);
      try {
        await kind.remove(remote, host);
        say(`Deleted ${remote.label} ${kind.noun} ${host}.`);
        await sleep(1500);
        return 'deleted';
      } catch (e) {
        warn(`Could not delete ${host}: ${e.message}`);
      }
    }
  } finally {
    tmux('set-option', '-wu', '@dtmux_remote_state');
  }
}

// Wait for one of `keys`; resolves to it.
function askKey(text, keys) {
  say(text);
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(keys[keys.length - 1]);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', function on(d) {
      const k = d.toString('latin1')[0];
      if (!keys.includes(k)) return;
      process.stdin.off('data', on);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(k);
    });
  });
}

// Wait for Enter (true) or Ctrl+C / Ctrl+D (false).
function ask(text) {
  say(text);
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(false);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', function on(d) {
      const k = d[0];
      if (k !== 13 && k !== 10 && k !== 3 && k !== 4) return;
      process.stdin.off('data', on);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(k === 13 || k === 10);
    });
  });
}

async function finish() {
  await ask('Press Enter to close this tab.');
  process.exit(0);
}

main().catch(async (err) => {
  warn(err.message);
  await finish();
});
