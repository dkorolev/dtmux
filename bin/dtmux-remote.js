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
import { kindOf, MUX_DIR, transient } from '../server/remote-kinds.js';
import { recordMachine, dropMachine } from '../server/machine-ledger.js';
import { TMUX_BIN } from '../server/tmux-control.js';
import { sshArgs, KNOWN_HOSTS } from '../server/remote-ssh.js';

const [name, firstHost, ...flags] = process.argv.slice(2);
const flag = (f) => (flags.includes(f) ? flags[flags.indexOf(f) + 1] ?? null : null);
const KEEPALIVE_MS = 30 * 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text, color = '36') => process.stdout.write(`\x1b[${color}m▸ ${text}\x1b[0m\r\n`);
const warn = (text) => say(text, '33');

let host = firstHost;
let remote;
let kind;
let mayCreate = flags.includes('--new');
let making = false;
let hungUp = false;
// The tab is gone: its terminal is too, so writes to it are dropped.
process.on('SIGHUP', () => {
  hungUp = true;
  if (!making) process.exit(129);
});
process.stdout.on('error', () => {});

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

// Recorded in the ledger (machine-ledger.js) as soon as its name is known,
// so the daemon deletes it should this tab go without deleting it. A tab
// closing meanwhile (SIGHUP) does not stop this: the machine is still
// recorded, then the helper exits.
async function make() {
  making = true;
  try {
    if (!kind.namedByCreate) recordMachine(name, host);
    const m = await kind.create(remote, host, say);
    recordMachine(name, m.host);
    if (m.host !== host) {
      host = m.host;
      adopt(host);
    }
    return m;
  } finally {
    making = false;
    if (hungUp) process.exit(129);
  }
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
  if (pane) spawnSync(TMUX_BIN, [cmd, '-t', pane, ...args], { stdio: 'ignore' });
}

// ssh into the machine's tmux until its shell ends, connecting again when
// the connection drops. `probe`: give up with 'unreachable' if the very
// first try cannot connect, for the caller to ask the controller instead.
async function connect(address, fresh, { probe = false } = {}) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // VM addresses are reused: a new VM at an old address has a new host key.
  if (fresh) spawnSync('ssh-keygen', ['-R', address, '-f', KNOWN_HOSTS], { stdio: 'ignore' });
  const user = kind.user(remote, host);
  const base = sshArgs(remote, host, address);
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
        // ssh came back on its own: the machine's tmux either ended (its last
        // shell exited, Ctrl+D) or was only detached. Ended: the machine has
        // nothing left to do, so it is deleted and the tab closes. Detached,
        // or not sure: it stays, and you choose.
        const alive = await remoteTmux(base);
        if (alive === false) {
          say(`The last shell on ${remote.label} ${kind.noun} ${host} exited.`);
          if (await removeMachine()) return;
        }
        const why = alive ? `The session on ${remote.label} ${kind.noun} ${host} was detached` : `ssh to ${host} ended`;
        const next = await ended(why);
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
      warn('The connection dropped; connecting again in 5s (Ctrl+C: other choices)…');
      if (await interruptibleSleep(5000)) {
        const next = await ended(`Not connected to ${remote.label} ${kind.noun} ${host}`);
        if (next === 'reconnect') {
          tries = 0;
          continue;
        }
        return;
      }
    }
  } finally {
    clearInterval(keepAlive);
  }
}

// The machine's tmux was detached (or could not be asked), or the
// connection is down and you pressed Ctrl+C: reconnect (Enter) or delete the
// machine, which closes the tab (d). The page shows the same choices as
// buttons on the tab (see the window option).
async function ended(why) {
  tmux('set-option', '-w', '@dtmux_remote_state', 'ended');
  try {
    for (;;) {
      say(`${why}; the ${kind.noun} is still there (${kind.lifetime(remote)}).`);
      const key = await askKey(`Enter: reconnect · d: delete the ${kind.noun} (and this tab)`, ['\r', '\n', 'd', 'D']);
      if (key === null) return 'close';
      if (key === '\r' || key === '\n') return 'reconnect';
      if ((await askCode()) && (await removeMachine())) return 'deleted';
    }
  } finally {
    tmux('set-option', '-wu', '@dtmux_remote_state');
  }
}

// Delete this tab's machine; true when it is gone. The tab closes when the
// helper exits after this.
async function removeMachine() {
  say(`Deleting ${remote.label} ${kind.noun} ${host}…`);
  try {
    await kind.remove(remote, host);
  } catch (e) {
    warn(`Could not delete ${host}: ${e.message}`);
    return false;
  }
  try {
    dropMachine(name, host);
  } catch {} // the daemon's sweep drops it once it sees the machine gone
  say(`Deleted ${remote.label} ${kind.noun} ${host}.`);
  await sleep(1500);
  return true;
}

// Does the machine's tmux still run (a session detached, not ended)? true,
// false, or null when the machine could not be asked.
function remoteTmux(base) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('ssh', [...base, 'tmux ls >/dev/null 2>&1 && echo alive || echo gone'], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(/alive/.test(out) ? true : /gone/.test(out) ? false : null));
  });
}

// Sleep, cut short by Ctrl+C: resolves true when it was.
function interruptibleSleep(ms) {
  return new Promise((resolve) => {
    const done = (hit) => {
      clearTimeout(timer);
      process.off('SIGINT', onInt);
      if (process.stdin.isTTY) {
        process.stdin.off('data', onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
      resolve(hit);
    };
    const onInt = () => done(true);
    const onData = (d) => d.includes(3) && done(true);
    const timer = setTimeout(() => done(false), ms);
    process.on('SIGINT', onInt);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', onData);
    }
  });
}

// Wait for one of `keys`; resolves to it (null with no terminal to ask).
function askKey(text, keys) {
  say(text);
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(null); // nobody to ask
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

// Deleting a machine cannot be undone, so it takes typing four random
// digits and Enter, not one key. True when they were typed; Esc, Ctrl+C, a
// wrong code or no terminal: false.
function askCode() {
  const code = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  const thing = kind.fullNoun ?? kind.noun;
  say(`To confirm deleting this ${thing} type in the following four digits below, and press Enter (Esc keeps it).`, '31');
  process.stdout.write(`\r\n    ${code}\r\n\r\n  > `);
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(false);
    let typed = '';
    const done = (ok) => {
      process.stdin.off('data', on);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\r\n');
      if (!ok) say(`Not deleted.`);
      resolve(ok);
    };
    function on(d) {
      for (const k of d.toString('latin1')) {
        if (k === '\x1b' || k === '\x03' || k === '\x04') return done(false);
        if (k === '\r' || k === '\n') return done(typed === code);
        if ((k === '\x7f' || k === '\b') && typed) {
          typed = typed.slice(0, -1);
          process.stdout.write('\b \b');
        } else if (/[0-9]/.test(k) && typed.length < 4) {
          typed += k;
          process.stdout.write(k);
        }
      }
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', on);
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
