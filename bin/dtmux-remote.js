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
import { kindOf, MUX_DIR, transient, deleteMachine } from '../server/remote-kinds.js';
import { recordMachine, dropMachine } from '../server/machine-ledger.js';
import { TMUX_BIN } from '../server/tmux-control.js';
import { sshArgs, KNOWN_HOSTS, reconnectDelay } from '../server/remote-ssh.js';
import { ENDED_MARKER, DEFAULT_ATTACH } from '../server/remote-config.js';
import { shellQuote } from '../server/agent-resume.js';
import { GATHER, parseGather, agentsFrom, restoreScript, writeCommand, TAKE_LOST, parseLost } from '../server/remote-agents.js';

const [name, firstHost, ...flags] = process.argv.slice(2);
const flag = (f) => (flags.includes(f) ? flags[flags.indexOf(f) + 1] ?? null : null);
const KEEPALIVE_MS = 30 * 60000;
// How often the agents in the machine's tmux are written down there (see
// server/remote-agents.js): a kill loses at most this much of who ran.
const SNAPSHOT_MS = 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text, color = '36') => process.stdout.write(`\x1b[${color}m▸ ${text}\x1b[0m\r\n`);
const warn = (text) => say(text, '33');

let host = firstHost;
let remote;
let kind;
let mayCreate = flags.includes('--new');
let making = false;
// This helper made the machine: its tmux is new, not lost.
let madeHere = false;
let hungUp = false;
// The tab is gone: its terminal is too, so writes to it are dropped.
process.on('SIGHUP', () => {
  hungUp = true;
  if (!making) process.exit(129);
});
process.stdout.on('error', () => {});
// During controller and SSH probes a terminal interrupt must not kill the tab helper.
process.on('SIGINT', () => {});

function waitingForConnection(waiting) {
  tmux('set-option', '-p', '@dtmux_connecting', waiting ? '1' : '0');
}

async function interactive(read) {
  waitingForConnection(false);
  try {
    return await read();
  } finally {
    waitingForConnection(true);
  }
}

async function main() {
  waitingForConnection(true);
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
    warn(`${known} does not answer; asking the controller (${remote.controller.join(' ')}) ${kind.lookupWhat}…`);
  } else say(`${remote.label} ${kind.noun} ${host}: asking the controller (${remote.controller.join(' ')}) ${kind.lookupWhat}…`);
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
      const wait = 8000 + Math.round(4000 * Math.random()); // tabs that lost it together try again apart
      warn(`Lost touch with the controller (${e.message}); trying again in ${Math.round(wait / 1000)}s…`);
      await sleep(wait);
    }
  }
}

// Make or find the machine: { address, upSince, fresh } (fresh: just made),
// or null when you chose to close the tab instead of making a new one.
async function settle() {
  const found = await waiting(kind.lookup(remote, host, say), (secs) =>
    say(`Still waiting for the controller to answer (${secs}s; its first ssh login can take a while)…`, '2'));
  if (found.address) return found;
  if (found.making) {
    say(`${host} is being made; waiting for it…`);
    return found.making();
  }
  if (found.none && mayCreate) return make();
  warn(found.gone ?? `${host} is not there.`);
  const again = `Press Enter to make a new ${remote.label} ${kind.noun} (${kind.lifetime(remote)}), Esc to close this tab.`;
  const choice = await askKey(again, ['\r', '\n', '\x1b']);
  if (choice === null || choice === '\x1b') return null;
  host = kind.newHost(remote);
  adopt(host);
  mayCreate = true;
  return make();
}

// `promise`, calling `tell(seconds)` every 10s until it settles: a slow call
// shows that it is still going, and on what.
async function waiting(promise, tell) {
  const started = Date.now();
  const timer = setInterval(() => tell(Math.round((Date.now() - started) / 1000)), 10000);
  try {
    return await promise;
  } finally {
    clearInterval(timer);
  }
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
    madeHere = true;
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
  // Failures since ssh last got in, for how long to wait before the next try.
  let fails = 0;
  let booting = false;
  // When the machine's tmux started, as last seen. Joining again and finding
  // no tmux, or one started since, means the shells that ran there ended:
  // that is said, not covered up by a new empty session.
  let tmuxSince = null;
  let expectNew = fresh || madeHere;
  try {
    for (;;) {
      if (!booting && (tries || !probe)) say(`ssh ${user}@${address}${remote.jump ? ` via ${remote.jump}` : ''}  (${remote.label} ${kind.noun} ${host})`);
      // Asked first, over the same shared connection; could not ask: ssh is
      // not getting through, so it is not tried a second time.
      const since = await remoteTmuxStart(base);
      let code = 255;
      if (since !== null) {
        // No tmux there, and agents were written down as running in it: it was
        // killed under them. Offered back before a new, empty one starts.
        const lost = since === 0 && remote.attach === DEFAULT_ATTACH ? await takeLost(base) : null;
        if (lost) {
          const next = await offerLost(base, lost);
          if (next === 'menu') {
            const after = await ended(`The agents on ${remote.label} ${kind.noun} ${host} were not resumed (${lost.file} keeps them)`);
            if (after !== 'reconnect') return;
            tries = 0;
            continue;
          }
          expectNew = true; // asked already; the ssh below attaches this tab to that tmux
        }
        if (since === 0 ? !expectNew : tmuxSince !== null && since !== tmuxSince) {
          shellsEnded(since, tmuxSince);
          const question = `Press Enter to ${since ? 'join the tmux there now' : 'start a new tmux there'}, Ctrl+C for other choices.`;
          if (!(await interactive(() => ask(question)))) {
            const next = await ended(`The shells on ${remote.label} ${kind.noun} ${host} ended`);
            if (next !== 'reconnect') return;
            tries = 0;
            continue;
          }
        }
        expectNew = false;
        fails = 0;
        // Nothing was running at the check above, so this join starts the tmux.
        // Forget the previous start time. Keeping it would make the next
        // reconnect call this new tmux a restart and wait for Enter before joining.
        if (since) tmuxSince = since;
        else tmuxSince = null;
        // Once ssh is in (and its shared connection up), not alongside it.
        const first = kind.keepAlive ? setTimeout(touch, 10000) : null;
        const snapping = remote.attach === DEFAULT_ATTACH ? snapshotEvery(base) : null;
        // A tmux this join started: note when, to know it again next time.
        const learn = tmuxSince
          ? null
          : setTimeout(() => remoteTmuxStart(base).then((s) => s && (tmuxSince ??= s)), 5000);
        code = await new Promise((resolve) => {
          // The default remote tmux draws its screen on stdout. Until then a
          // control key from the page could be buffered for a shell nobody sees.
          const screen = remote.attach === DEFAULT_ATTACH;
          if (!screen) waitingForConnection(false); // custom commands may silently wait for input
          const child = spawn('ssh', ['-t', ...base, remote.attach], {
            stdio: ['inherit', screen ? 'pipe' : 'inherit', 'inherit'],
          });
          if (screen) {
            child.stdout.once('data', () => waitingForConnection(false));
            child.stdout.pipe(process.stdout, { end: false });
          }
          child.on('error', () => resolve(255));
          child.on('close', (c) => resolve(c ?? 255));
        });
        waitingForConnection(true);
        clearTimeout(first);
        clearTimeout(learn);
        snapping?.stop();
      }
      if (code !== 255) {
        // ssh came back on its own: the machine's tmux ended or was only
        // detached. Ctrl+D (or `exit`) in its last shell deletes the machine
        // and closes the tab: tmux exited cleanly (ssh exits 0) and left the
        // marker that only a last shell exiting by itself writes (see
        // ENDED_MARKER). Anything else, a killed tmux or shell among them
        // (out of memory, a tool's `tmux kill-server`), keeps the machine,
        // and you choose: deleting takes the files with it.
        const state = await remoteTmux(base);
        const what = `${remote.label} ${kind.noun} ${host}`;
        if (state === 'exited' && code === 0) {
          say(`The last shell on ${what} exited.`);
          if (await removeMachine('its last shell exited by itself (Ctrl+D or exit), so tmux ended cleanly')) return;
        }
        if (state === 'exited' || state === 'gone') expectNew = true; // joining again starts a new tmux, as it should
        const why =
          state === 'alive'
            ? `The session on ${what} was detached`
            : state === 'gone'
              ? `The tmux on ${what} ended without its last shell exiting: it was killed`
              : state === 'exited'
                ? `The tmux on ${what} ended`
                : `ssh to ${host} ended`;
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
      const wait = reconnectDelay(++fails);
      warn(`The connection dropped; connecting again in ${Math.round(wait / 1000)}s (Ctrl+C: other choices)…`);
      if (await interactive(() => interruptibleSleep(wait))) {
        const next = await ended(`Not connected to ${remote.label} ${kind.noun} ${host}`);
        if (next === 'reconnect') {
          tries = 0;
          fails = 0;
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
      const key = await interactive(() => askKey(`Enter: reconnect · d: delete the ${kind.noun} (and this tab)`, ['\r', '\n', 'd', 'D']));
      if (key === null) return 'close';
      if (key === '\r' || key === '\n') return 'reconnect';
      if ((await interactive(askCode)) && (await removeMachine(`you pressed d in the tab and typed the code (${why})`))) return 'deleted';
    }
  } finally {
    tmux('set-option', '-wu', '@dtmux_remote_state');
  }
}

// Delete this tab's machine, you having asked (`why`, for the log); true
// when it is gone. The tab closes when the helper exits after this.
async function removeMachine(why) {
  say(`Deleting ${remote.label} ${kind.noun} ${host}…`);
  try {
    await deleteMachine(remote, host, `tab: ${why}`);
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

// What became of the machine's tmux: 'alive' (a session detached, not
// ended), 'exited' (it ended because its last shell exited by itself: a
// marker from the last minute), 'gone' (it ended otherwise), or null when
// the machine could not be asked. The marker is used up either way.
function remoteTmux(base) {
  const ask =
    `tmux ls >/dev/null 2>&1 && echo alive || { f=${ENDED_MARKER}; ` +
    'if [ -f $f ] && [ $(( $(date +%s) - $(cat $f) )) -lt 60 ]; then echo exited; else echo gone; fi; rm -f $f; }';
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('ssh', [...base, ask], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(/alive|exited|gone/.exec(out)?.[0] ?? null));
  });
}

// When the machine's tmux server started (unix seconds), 0 when none runs
// there, null when the machine could not be asked.
function remoteTmuxStart(base) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('ssh', [...base, "tmux display-message -p '#{start_time}' 2>/dev/null || echo none"], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code === 255) return resolve(null);
      const m = /^(\d{9,11})\s*$/m.exec(out);
      resolve(m ? Number(m[1]) : /none/.test(out) ? 0 : null);
    });
  });
}

// Write down the agents in the machine's tmux now and then while attached
// (first once ssh is surely in): { stop }. A tmux that is not there (it was
// just killed) leaves what was written last alone.
function snapshotEvery(base) {
  let busy = false;
  const once = async () => {
    if (busy) return;
    busy = true;
    try {
      const out = await sshOut(base, `bash -c ${shellQuote(GATHER)}`);
      const seen = out === null ? null : parseGather(out);
      if (!seen || seen.notmux || seen.at === null) return;
      const agents = agentsFrom(seen);
      await sshOut(base, writeCommand(agents.length > 0), restoreScript(agents, seen.at));
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(once, 15000);
  const every = setInterval(once, SNAPSHOT_MS);
  return {
    stop() {
      clearTimeout(first);
      clearInterval(every);
    },
  };
}

// The agents written down as running in a tmux that is no longer there,
// moved aside so the next snapshot does not replace them: { file, count,
// report }, or null.
async function takeLost(base) {
  const out = await sshOut(base, TAKE_LOST);
  return out === null ? null : parseLost(out);
}

// Show what ran there and offer it back. Either answer starts a tmux, and the
// caller then attaches this tab to it: 'resumed', 'empty' (a new tmux
// without them), or 'menu' (Ctrl+C: reconnect or delete).
async function offerLost(base, lost) {
  const what = `${remote.label} ${kind.noun} ${host}`;
  const red = (text) => say(text, '1;31');
  red(`There is no tmux on ${what} any more: it was killed (out of memory, tmux kill-server) or the machine restarted.`);
  for (const line of lost.report.split('\n')) say(line, '33');
  const n = lost.count === 1 ? 'it' : `these ${lost.count}`;
  const offer =
    `Enter: a new tmux with ${n} resumed, and this tab attached to it · ` +
    'n: a new, empty tmux, and this tab attached · Ctrl+C: other choices';
  const key = await interactive(() => askKey(offer, ['\r', '\n', 'n', 'N', '\x03']));
  if (key === null || key === '\x03') return 'menu';
  if (key === 'n' || key === 'N') {
    say(`Starting an empty tmux and attaching this tab; ${lost.file} still resumes them: sh ${lost.file} run`);
    return 'empty';
  }
  const out = await sshOut(base, `sh ${lost.file} run 2>&1`);
  if (out === null) warn(`Could not resume them; on the ${kind.noun}: sh ${lost.file} run`);
  else for (const line of out.trimEnd().split('\n')) say(line);
  return 'resumed';
}

// Run `command` on the machine over the shared connection, `stdin` fed to it:
// its stdout, or null when ssh could not get through (or it took too long).
function sshOut(base, command, stdin = '') {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('ssh', ['-o', 'BatchMode=yes', ...base, command], { stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdout.on('data', (d) => (out += d));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve(code === 255 || signal ? null : out);
    });
  });
}

// The tmux on the machine is gone (`since` 0) or another one runs there
// (started at `since`; the one before at `before`): what ran in it ended.
function shellsEnded(since, before) {
  const what = `${remote.label} ${kind.noun} ${host}`;
  const at = (s) => new Date(s * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const red = (text) => say(text, '1;31');
  if (since) red(`The tmux on ${what} started again at ${at(since)} (the one before ran since ${at(before)}).`);
  else red(`There is no tmux on ${what} any more.`);
  red('The shells and coding agents that ran there have ended: the machine restarted or ran out of memory, or its tmux was killed.');
  red('An agent can be picked up again from its directory there: claude --resume, codex resume (and see ~/.dtmux/lost-*.sh there).');
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
  await askKey('Press Enter to close this tab.', ['\r', '\n']);
  process.exit(0);
}

main().catch(async (err) => {
  warn(err.message);
  await finish();
});
