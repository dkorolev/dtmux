// The kinds of remote machine a dtmux tab can live on, each behind the same
// small interface, used by the tab's helper (bin/dtmux-remote.js) and by the
// daemon (deleting a machine from the tab menu):
//
//   noun                       what one machine is called ("VM", "account")
//   lifetime(remote)           how long one lives, as a phrase
//   newHost(remote)            the name a new tab starts with
//   user(remote, host)         the ssh login on it
//   lookup(remote, host)       -> { address, upSince, fresh }  it is there
//                                 { making: wait() }             being made
//                                 { none: true }                 never made
//                                 { gone: why }                  made, gone since
//   create(remote, host, say)  -> { host, address, upSince }
//   remove(remote, host)       delete it for good
//   namedByCreate              the host's name comes from create (else it is
//                              chosen first, and recorded before create)
//   keepAlive                  touch a file now and then while connected
//                              (machines that are deleted when idle)
//
// Controllers are run with a time limit on every call, and, when reached
// over ssh, through one shared, lasting ssh connection.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { shellQuote } from './agent-resume.js';

// ssh master connections. A short, fixed directory: a unix socket path has a
// ~104-byte limit, which a path under the state directory can exceed.
export const MUX_DIR = `/tmp/dtmux-mux-${process.getuid()}`;
export const mux = (persist) => ['-o', 'ControlMaster=auto', '-o', `ControlPath=${MUX_DIR}/%C`, '-o', `ControlPersist=${persist}`];

const CALL_MS = 90000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hours = (s) => (s % 3600 ? `${Math.round(s / 60)} min` : `${s / 3600}h`);
const hex = () => randomBytes(4).toString('hex');

// Run the controller: `json` adds --json and resolves to its `data`;
// otherwise resolves to stdout. `stdin`: a first line to feed it. Progress
// on stderr goes to `log`. A call that does not finish in time, or whose
// ssh connection fails, rejects with code 255 (worth retrying).
export function runCtl(remote, args, { json = false, stdin = null, log = null } = {}) {
  fs.mkdirSync(MUX_DIR, { recursive: true, mode: 0o700 });
  const [cmd, ...pre] = remote.controller;
  // Through ssh the words are joined and split again by the remote shell.
  const viaSsh = path.basename(cmd) === 'ssh';
  const words = viaSsh ? args.map(shellQuote) : args;
  const all = [...(viaSsh ? mux('30m') : []), ...pre, ...(json ? ['--json'] : []), ...words];
  const what = `${remote.controller.join(' ')} ${args[0]}`;
  return new Promise((resolve, reject) => {
    // Its own process group: a tab closing mid-call (SIGHUP to the tab's
    // processes) does not cut off a create whose result must be recorded.
    const child = spawn(cmd, all, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => {
      err += d;
      if (log) for (const line of String(d).split('\n').filter(Boolean)) log(line);
    });
    child.stdin.on('error', () => {});
    if (stdin) child.stdin.write(`${stdin}\n`);
    child.stdin.end();
    child.on('error', (e) => reject(Object.assign(new Error(`Could not run ${cmd}: ${e.message}`), { code: -1 })));
    let late = false;
    const limit = setTimeout(() => {
      late = true;
      child.kill('SIGKILL');
    }, CALL_MS);
    child.on('close', (code) => {
      clearTimeout(limit);
      if (late) return reject(Object.assign(new Error(`${what} gave no answer in ${CALL_MS / 1000}s`), { code: 255 }));
      if (!json) {
        if (code === 0) return resolve(out);
        return reject(Object.assign(new Error(err.trim().split('\n').pop() || `${what} failed (exit ${code})`), { code }));
      }
      let reply = null;
      try {
        reply = JSON.parse(out.trim().split('\n').pop());
      } catch {}
      if (reply?.ok) return resolve(reply.data);
      reject(Object.assign(new Error(reply?.error?.message ?? `${what} failed (exit ${code})`), { code, reply }));
    });
  });
}

export const transient = (e) => e.code === 255 || e.code === 75 || e.reply?.error?.retryable === true;

// --- LunaNode VMs, made by lunanode-ctl ------------------------------------
// A VM's run id is `dtmux-<host>`, which makes creating idempotent: a tab
// that was closed or restarted while its VM was being made finds that same
// operation instead of making a second VM.

const DONE = new Set(['succeeded', 'failed', 'cancelled', 'canceled', 'expired', 'aborted']);
const runId = (host) => `dtmux-${host}`;

function readSeed(remote) {
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

async function createOp(remote, host) {
  const data = await runCtl(remote, ['operation', 'list', '--run-id', runId(host)], { json: true });
  return (data?.operations ?? []).filter((o) => o.kind === 'create').pop() ?? null;
}

// LunaNode lists a VM under its provider name, so it is matched by the id
// its create gave.
async function findVm(remote, host, op) {
  const made = op?.result ?? {};
  const data = await runCtl(remote, ['list'], { json: true });
  return (
    (data?.vms ?? []).find(
      (v) => (made.vm_id && v.vm_id === made.vm_id) || v.name === host || (made.provider_name && v.name === made.provider_name),
    ) ?? null
  );
}
const addressOf = (vm, op) => vm?.ssh_address || op?.result?.addresses?.ipv6 || op?.result?.addresses?.ipv4 || null;
const upOf = (op) => (op?.state === 'succeeded' ? Math.floor(Date.parse(op.updated_at) / 1000) || null : null);

// Poll the operation until it is done: short calls, not one long `wait`.
async function waitOp(remote, host, id, say) {
  const started = Date.now();
  let told = 0;
  for (;;) {
    const op = await runCtl(remote, ['operation', 'get', id], { json: true });
    if (op?.state === 'succeeded') {
      const address = addressOf(await findVm(remote, host, op), op) ?? deep(op, 'ssh_address');
      if (!address) throw new Error(`${host} was made but has no address to ssh to.`);
      return { host, address, upSince: upOf(op), fresh: true };
    }
    if (op?.state && DONE.has(op.state)) throw new Error(`Making ${host} ${op.state}: ${op.error?.message ?? 'no details'}`);
    const mins = Math.floor((Date.now() - started) / 60000);
    if (mins > told) {
      told = mins;
      say?.(`Still making ${host} (${op?.state ?? 'pending'}, ${mins} min so far)…`);
    }
    await sleep(10000);
  }
}

const lunanode = {
  noun: 'VM',
  // What lookup asks the controller, for the line shown while it waits.
  lookupWhat: 'whether the VM is there and its address',
  lifetime: (r) => `deleted ${hours(r.ttlSeconds)} after it is made`,
  newHost: (r) => `${r.hostPrefix}-${hex()}`,
  user: (r) => r.user,
  namedByCreate: false,
  keepAlive: false,

  async lookup(remote, host, say) {
    const op = await createOp(remote, host);
    const vm = await findVm(remote, host, op);
    if (vm) {
      if (vm.state !== 'active') say?.(`${host} is ${vm.state}.`);
      const recent = op && Date.now() - Date.parse(op.updated_at ?? op.created_at ?? 0) < 15 * 60000;
      return { address: addressOf(vm, op), upSince: upOf(op), fresh: Boolean(recent) };
    }
    if (op && !DONE.has(op.state)) return { making: () => waitOp(remote, host, op.operation_id, say) };
    if (!op) return { none: true };
    if (op.state !== 'succeeded') return { gone: `Making ${host} ${op.state}: ${op.error?.message ?? 'no details'}` };
    return { gone: `The VM ${host} is gone (VMs are ${lunanode.lifetime(remote)}).` };
  },

  async create(remote, host, say) {
    say?.(`Making ${remote.label} VM ${host} (${remote.plan}, ${remote.image}, ${lunanode.lifetime(remote)}); this takes a few minutes…`);
    const args = ['--ssh-seed-stdin', 'create', host, '--plan', remote.plan, '--image', remote.image];
    if (remote.ipv4) args.push('--ipv4');
    args.push('--run-id', runId(host), '--request-id', 'create', '--ttl-seconds', String(remote.ttlSeconds));
    for (;;) {
      try {
        const receipt = await runCtl(remote, args, { json: true, stdin: readSeed(remote), log: (l) => say?.(l, '2') });
        const id = deep(receipt, 'operation_id');
        if (!id) throw new Error(`Unexpected reply from create: ${JSON.stringify(receipt).slice(0, 300)}`);
        return await waitOp(remote, host, id, say);
      } catch (e) {
        if (e.code !== 75) throw e;
        say?.('The controller is busy; trying again in 10s…');
        await sleep(10000);
      }
    }
  },

  async remove(remote, host) {
    const op = await createOp(remote, host).catch(() => null);
    const id = op?.result?.vm_id;
    await runCtl(remote, id ? ['remove', id, '--run-id', runId(host)] : ['remove', host], { json: true });
  },
};

// --- Accounts on a devbox host, made by devbox-ctl -------------------------
// One account (devbox-user-NNNNNN) per tab, on the controller's own host,
// logged into directly as that account. An account is deleted once nothing
// in its home changed for 24 hours, so a connected tab touches a file there
// now and then. A new tab starts as `new-<hex>` until its account exists.

const DEVBOX_NAME = /^devbox-user-\d+$/;

const devbox = {
  noun: 'account',
  fullNoun: 'devbox account', // where it must be unmistakable: deleting one
  lookupWhat: 'whether the account still exists',
  lifetime: () => 'deleted after 24 idle hours',
  newHost: () => `new-${hex()}`,
  user: (r, host) => host,
  namedByCreate: true,
  keepAlive: true,

  async lookup(remote, host) {
    if (!DEVBOX_NAME.test(host)) return { none: true };
    const list = JSON.parse(await runCtl(remote, ['list']));
    const acct = (Array.isArray(list) ? list : []).find((a) => a.name === host);
    if (!acct) return { gone: `The account ${host} is gone (accounts are ${devbox.lifetime()}).` };
    return { address: remote.address, upSince: null, fresh: false };
  },

  async create(remote, _host, say) {
    say?.(`Making a ${remote.label} account…`);
    const name = (await runCtl(remote, ['create'], { log: (l) => say?.(l, '2') })).trim().split('\n').pop();
    if (!DEVBOX_NAME.test(name ?? '')) throw new Error(`Unexpected reply from create: ${name}`);
    return { host: name, address: remote.address, upSince: Math.floor(Date.now() / 1000), fresh: false };
  },

  async remove(remote, host) {
    if (DEVBOX_NAME.test(host)) await runCtl(remote, ['delete', host]);
  },
};

export const KINDS = { 'lunanode-ctl': lunanode, 'devbox-ctl': devbox };
export const kindOf = (remote) => KINDS[remote.kind];
