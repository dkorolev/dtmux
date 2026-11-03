#!/usr/bin/env node
// Runs inside a dtmux tab that lives on a remote machine: makes or finds the
// machine, then ssh-es into it, and back in when the connection drops.
//
//   dtmux-remote.js <remote> <host> [--new]
//
// <remote> names an entry of `remotes:` in ~/.dtmux.yaml (see
// server/remote-config.js), <host> the VM. With --new the VM is created when
// it does not exist yet; without it (reopening a saved tab) a missing VM is
// reported and only created again when you say so, since VMs cost money.
//
// Creating is idempotent: the VM's run id is `dtmux-<host>`, so a tab that
// was closed or restarted in the middle of creating waits for that same
// operation instead of starting a second VM.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../server/config.js';
import { STATE_DIR } from '../server/paths.js';
import { shellQuote } from '../server/agent-resume.js';

const [name, firstHost, ...flags] = process.argv.slice(2);
const KNOWN_HOSTS = path.join(STATE_DIR, 'known_hosts');
const DONE = new Set(['succeeded', 'failed', 'cancelled', 'canceled', 'expired', 'aborted']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text, color = '36') => process.stdout.write(`\x1b[${color}m▸ ${text}\x1b[0m\r\n`);
const warn = (text) => say(text, '33');

let host = firstHost;
let remote;

async function main() {
  if (!name || !host) throw new Error('usage: dtmux-remote.js <remote> <host> [--new]');
  remote = loadConfig().remotes?.[name];
  if (!remote) throw new Error(`No remote "${name}" in ${process.env.DTMUX_CONFIG || '~/.dtmux.yaml'} (remotes: ...).`);
  // The controller is reached over the network, and creating takes minutes:
  // a dropped connection to it is retried, picking up where things are.
  for (;;) {
    try {
      const vm = await settle();
      if (vm) await connect(vm.address, vm.fresh);
      return;
    } catch (e) {
      if (!transient(e)) throw e;
      warn(`Lost touch with the controller (${e.message}); trying again in 10s…`);
      await sleep(10000);
    }
  }
}

let mayCreate = flags.includes('--new');
const transient = (e) => e.code === 255 || e.code === 75 || e.reply?.error?.retryable === true;
const recent = (op) => op && Date.now() - Date.parse(op.updated_at ?? op.created_at ?? 0) < 15 * 60000;

// Make or find the VM: { address, fresh } (fresh: just made), or null when
// you chose to close the tab instead of making a new one.
async function settle() {
  const op = await createOp();
  const address = await find(op);
  if (address) return { address, fresh: recent(op) };
  if (op && !DONE.has(op.state)) {
    say(`${host} is being made; waiting for it…`);
    return { address: await waitFor(op.operation_id), fresh: true };
  }
  if (!op && mayCreate) return { address: await create(), fresh: true };
  if (op?.state && op.state !== 'succeeded') warn(`Making ${host} ${op.state}: ${op.error?.message ?? 'no details'}`);
  else warn(`The VM ${host} is gone (VMs are deleted ${hours(remote.ttlSeconds)} after they are made).`);
  const again = `Press Enter to make a new ${remote.label} VM (${remote.plan}, deleted after ${hours(remote.ttlSeconds)}), Ctrl+C to close this tab.`;
  if (!(await ask(again))) return null;
  host = `${remote.hostPrefix}-${randomBytes(4).toString('hex')}`;
  adopt(host);
  mayCreate = true;
  return { address: await create(), fresh: true };
}

const hours = (s) => (s % 3600 ? `${Math.round(s / 60)} min` : `${s / 3600}h`);

// The controller, run with --json. `seed`: feed the caller seed on stdin.
// Its progress lines (stderr) are shown dimmed; resolves to `data`.
function ctl(args, { seed = false, quiet = false } = {}) {
  const [cmd, ...pre] = remote.controller;
  // Through ssh the words are joined and split again by the remote shell.
  const words = path.basename(cmd) === 'ssh' ? args.map(shellQuote) : args;
  const all = [...pre, '--json', ...(seed ? ['--ssh-seed-stdin'] : []), ...words];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, all, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => {
      if (!quiet) for (const line of String(d).split('\n').filter(Boolean)) say(line, '2');
    });
    child.stdin.on('error', () => {});
    if (seed) child.stdin.write(`${readSeed()}\n`);
    child.stdin.end();
    child.on('error', (e) => reject(new Error(`Could not run ${cmd}: ${e.message}`)));
    child.on('close', (code) => {
      let reply = null;
      try {
        reply = JSON.parse(out.trim().split('\n').pop());
      } catch {}
      if (reply?.ok) return resolve(reply.data);
      const e = new Error(reply?.error?.message ?? `${remote.controller.join(' ')} ${args[0]} failed (exit ${code})`);
      e.code = code;
      e.reply = reply;
      reject(e);
    });
  });
}

function readSeed() {
  let text;
  try {
    text = fs.readFileSync(remote.seed, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read the seed ${remote.seed}: ${e.code ?? e.message}`);
  }
  const line = text.split('\n')[0].trim();
  if (!/^ssh-seed-0x[0-9a-f]{64}$/.test(line)) throw new Error(`${remote.seed} does not hold an ssh-seed-0x… line.`);
  return line;
}

const runId = () => `dtmux-${host}`;

// The VM's address if it exists and runs, else null. LunaNode lists a VM
// under its provider name, so it is matched by the id its create gave.
async function find(op) {
  const made = op?.result ?? {};
  const data = await ctl(['list'], { quiet: true });
  const vm = (data?.vms ?? []).find(
    (v) => (made.vm_id && v.vm_id === made.vm_id) || v.name === host || (made.provider_name && v.name === made.provider_name),
  );
  if (!vm) return null;
  if (vm.state !== 'active') say(`${host} is ${vm.state}.`);
  return vm.ssh_address || null;
}

// The create operation of this VM's run, if there was one.
async function createOp() {
  const data = await ctl(['operation', 'list', '--run-id', runId()], { quiet: true });
  return (data?.operations ?? []).filter((o) => o.kind === 'create').pop() ?? null;
}

async function create() {
  say(`Making ${remote.label} VM ${host} (${remote.plan}, ${remote.image}, deleted after ${hours(remote.ttlSeconds)}); this takes a few minutes…`);
  const args = ['create', host, '--plan', remote.plan, '--image', remote.image];
  if (remote.ipv4) args.push('--ipv4');
  args.push('--run-id', runId(), '--request-id', 'create', '--ttl-seconds', String(remote.ttlSeconds));
  for (;;) {
    try {
      const receipt = await ctl(args, { seed: true });
      const address = deep(receipt, 'ssh_address');
      if (address) return address;
      const id = deep(receipt, 'operation_id');
      if (!id) throw new Error(`Unexpected reply from create: ${JSON.stringify(receipt).slice(0, 300)}`);
      return await waitFor(id);
    } catch (e) {
      if (e.code !== 75) throw e;
      say('The controller is busy; trying again in 10s…');
      await sleep(10000);
    }
  }
}

async function waitFor(id) {
  for (;;) {
    const op = await ctl(['operation', 'wait', id, '--timeout', '600']).catch((e) => {
      if (e.reply?.data) return e.reply.data;
      throw e;
    });
    const o = op?.operation ?? op;
    if (o?.state === 'succeeded') {
      const address = deep(o, 'ssh_address');
      if (address) return address;
      const again = await find(o);
      if (again) return again;
      throw new Error(`${host} was made but has no address to ssh to.`);
    }
    if (o?.state && DONE.has(o.state)) throw new Error(`Making ${host} ${o.state}: ${o.error?.message ?? 'no details'}`);
    say(`Still making ${host}…`);
  }
}

// A key anywhere in a JSON value.
function deep(v, key) {
  if (!v || typeof v !== 'object') return null;
  if (typeof v[key] === 'string' && v[key]) return v[key];
  for (const x of Object.values(v)) {
    const found = deep(x, key);
    if (found) return found;
  }
  return null;
}

// This tab now stands for another VM: tell dtmux (the window option it
// saves) and rename the tab.
function adopt(newHost) {
  const pane = process.env.TMUX_PANE;
  if (!pane) return;
  const tmux = process.env.TMUX_BIN || 'tmux';
  spawnSync(tmux, ['set-option', '-w', '-t', pane, '@dtmux_remote', `${name}/${newHost}`], { stdio: 'ignore' });
  spawnSync(tmux, ['rename-window', '-t', pane, newHost], { stdio: 'ignore' });
}

async function connect(address, fresh) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // VM addresses are reused: a new VM at an old address has a new host key.
  if (fresh) spawnSync('ssh-keygen', ['-R', address, '-f', KNOWN_HOSTS], { stdio: 'ignore' });
  const args = [
    '-t',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'ConnectTimeout=10',
    ...(remote.identity ? ['-o', 'IdentitiesOnly=yes', '-i', remote.identity] : []),
    `${remote.user}@${address}`,
    remote.attach,
  ];
  const started = Date.now();
  let tries = 0;
  for (;;) {
    say(`ssh ${remote.user}@${address}  (${remote.label} VM ${host})`);
    // Ctrl+C belongs to the remote side while ssh runs.
    const keep = () => {};
    process.on('SIGINT', keep);
    const code = await new Promise((resolve) => {
      const child = spawn('ssh', args, { stdio: 'inherit' });
      child.on('error', () => resolve(255));
      child.on('close', (c) => resolve(c ?? 255));
    });
    process.off('SIGINT', keep);
    if (code !== 255) return; // the remote shell ended: so does this tab
    tries++;
    // A new VM's sshd takes a moment to come up.
    if (fresh && Date.now() - started < 180000) {
      await sleep(3000);
      continue;
    }
    if (tries % 5 === 0 && !(await createOp().then(find).catch(() => address))) {
      warn(`The VM ${host} is gone.`);
      return finish();
    }
    warn('The connection dropped; connecting again in 5s (Ctrl+C closes this tab)…');
    await sleep(5000);
  }
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
