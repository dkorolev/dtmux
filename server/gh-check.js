// A clean place to try a GitHub token: a tiny container with only `gh` in
// it, so what the check sees is the token alone, not this Mac's gh config,
// keyring or git settings. Before dtmux hands your token to a remote machine
// (gh-remote.js), it asks this container who the token is and what it may do.
//
// The runtime, first one that works: Apple's `container` (on a Mac), then
// podman, then docker. The image (dtmux-gh-check) is built once, on first
// need or from Settings (Rebuild); every step of the build is reported
// (`events` 'change'), so the page can show it building.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { STATE_DIR } from './paths.js';

export const IMAGE = 'dtmux-gh-check:latest';
const CONTAINERFILE = 'FROM alpine:3.24\nRUN apk add --no-cache github-cli\n';

// [name shown, command, args that succeed only when it can run containers]
const RUNTIMES = [
  ...(process.platform === 'darwin' ? [['Apple container', 'container', ['system', 'status']]] : []),
  ['podman', 'podman', ['info', '--format', '{{.Host.Arch}}']],
  ['docker', 'docker', ['info', '--format', '{{.Architecture}}']],
];

export const events = new EventEmitter();
// state: 'unknown' | 'no-runtime' | 'missing' | 'building' | 'ready' | 'failed'
let status = { state: 'unknown', runtime: null, runtimes: [], log: [], at: null, error: null };
let building = null;

export const containerStatus = () => status;
const set = (patch) => {
  status = { ...status, ...patch };
  events.emit('change', status);
};

function run(cmd, args, { stdin = null, timeoutMs = 30000, onLine = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: 127, out: '', err: e.message });
    }
    let out = '';
    let err = '';
    let partial = '';
    const line = (d) => {
      if (!onLine) return;
      const text = partial + d.toString('utf8');
      const lines = text.split(/\r?\n|\r/);
      partial = lines.pop();
      for (const l of lines) if (l.trim()) onLine(l);
    };
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => ((out += d), line(d)));
    child.stderr.on('data', (d) => ((err += d), line(d)));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, out, err: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (partial.trim()) onLine?.(partial);
      resolve({ code: code ?? 1, out, err });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');
  });
}

// The first runtime, in priority order, that can run containers now; also
// what each one said, for Settings.
async function findRuntime() {
  const seen = [];
  let chosen = null;
  for (const [label, cmd, probe] of RUNTIMES) {
    const r = await run(cmd, probe, { timeoutMs: 15000 });
    const ok = r.code === 0;
    seen.push({ label, cmd, ok, why: ok ? null : runtimeWhy(r.code, r.err, r.out) });
    if (ok && !chosen) chosen = { label, cmd };
  }
  return { chosen, seen };
}

// What Settings shows when a runtime did not answer. A socket path is not a
// reason: the runtime is missing, or it is not running.
export function runtimeWhy(code, err, out) {
  if (code === 127) return 'not installed';
  const text = `${err || ''}\n${out || ''}`;
  if (/unable to connect|cannot connect|connection refused|no such file|socket|not running|machine/i.test(text)) return 'not running';
  const sentence = (text.trim().split('\n').find(Boolean) || '').split(/[.:]/)[0].replace(/\s+/g, ' ').trim();
  if (!sentence) return `exit ${code}`;
  return sentence.length > 48 ? `${sentence.slice(0, 45)}…` : sentence;
}

const imageExists = async (cmd) => (await run(cmd, ['image', 'inspect', IMAGE], { timeoutMs: 15000 })).code === 0;

// Look at the runtimes and the image; build it if it is not there (`build`),
// or always (`rebuild`). Resolves when it is ready or it failed.
export async function ensureImage({ build = true, rebuild = false } = {}) {
  if (building) return building;
  building = (async () => {
    const { chosen, seen } = await findRuntime();
    if (!chosen) {
      set({ state: 'no-runtime', runtime: null, runtimes: seen, error: 'No container runtime is running: start Apple container (container system start), podman (podman machine start) or docker.' });
      return status;
    }
    set({ runtime: chosen.label, runtimes: seen });
    if (!rebuild && (await imageExists(chosen.cmd))) {
      set({ state: 'ready', error: null });
      return status;
    }
    if (!build) {
      set({ state: 'missing', error: null });
      return status;
    }
    const dir = path.join(STATE_DIR, 'gh-check');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Containerfile'), CONTAINERFILE);
    set({ state: 'building', log: [`building ${IMAGE} with ${chosen.label}…`], error: null, at: Date.now() });
    const log = [...status.log];
    const onLine = (l) => {
      log.push(l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(0, 300));
      if (log.length > 200) log.splice(0, log.length - 200);
      set({ log: [...log] });
    };
    // A rebuild starts over (a newer gh), not from the build cache.
    const args = [
      'build',
      ...(chosen.cmd === 'container' ? ['--progress', 'plain'] : []),
      ...(rebuild ? ['--no-cache'] : []),
      '-t', IMAGE, '-f', path.join(dir, 'Containerfile'), dir,
    ];
    const r = await run(chosen.cmd, args, { timeoutMs: 10 * 60000, onLine });
    if (r.code === 0 && (await imageExists(chosen.cmd))) set({ state: 'ready', at: Date.now(), error: null });
    else set({ state: 'failed', at: Date.now(), error: `${chosen.label} build failed (exit ${r.code})` });
    return status;
  })().finally(() => (building = null));
  return building;
}

// Who `token` is, seen from the clean container: { ok, login, scopes, error }.
// The token goes in on stdin, never in a command line.
export async function checkToken(token) {
  const st = await ensureImage();
  if (st.state !== 'ready') return { ok: false, error: st.error ?? `the check image is ${st.state}` };
  const cmd = RUNTIMES.find(([label]) => label === st.runtime)[1];
  const script = 'IFS= read -r GH_TOKEN; export GH_TOKEN; gh api -i user';
  const r = await run(cmd, ['run', '--rm', '-i', IMAGE, 'sh', '-c', script], { stdin: `${token}\n`, timeoutMs: 60000 });
  const text = r.out.replace(/\r/g, '');
  const scopes = /^x-oauth-scopes:\s*(.*)$/im.exec(text)?.[1].split(',').map((s) => s.trim()).filter(Boolean) ?? null;
  const body = text.slice(text.indexOf('\n\n') + 2);
  let login = null;
  try {
    login = JSON.parse(body).login ?? null;
  } catch {}
  if (r.code !== 0 || !login) return { ok: false, error: (r.err || r.out).trim().split('\n').pop()?.slice(0, 300) || `exit ${r.code}` };
  return { ok: true, login, scopes };
}
