#!/usr/bin/env node
// dtmux — Dima's terminal multiplexer: a browser terminal over its own tmux.
//
//   dtmux [start]     start the daemon unless it is already running
//   dtmux kill|stop   stop it gently, taking its tmux sessions with it
//   dtmux restart     run the code on disk now, tmux and its shells untouched
//                     (--full: save the windows and end tmux too)
//   dtmux status      say whether it is running, and where
//   dtmux config      validate ~/.dtmux.yaml and print the effective config
import fs from 'node:fs';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { isSea } from 'node:sea';
import { stringify } from 'yaml';
import { loadConfig, ConfigError, CONFIG_PATH } from '../server/config.js';
import { PID_FILE, LOG_FILE, STATE_DIR } from '../server/paths.js';
import { daemonSpawn, repoRoot } from '../server/locate.js';
const HOST = '127.0.0.1';
const HEALTH_PATH = '/dtmux/health';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function die(msg, code = 1) {
  console.error(`dtmux: ${msg}`);
  process.exit(code);
}

function config() {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) die(err.message, 2);
    throw err;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// The daemon recorded in the pid file, if that process is still alive and is
// really dtmux (pids get reused).
function recordedDaemon() {
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
  } catch {
    return null;
  }
  if (!Number.isInteger(rec?.pid) || !isAlive(rec.pid)) return null;
  try {
    const cmd = execFileSync('ps', ['-p', String(rec.pid), '-o', 'command='], { encoding: 'utf8' });
    if (!/dtmux|server\/daemon\.js/.test(cmd)) return null;
  } catch {
    return null;
  }
  return rec;
}

// What answers on `port`: { app: 'dtmux', pid, ... }, { app: null } for
// something else, or null when nothing is listening.
async function probe(port) {
  try {
    const res = await fetch(`http://${HOST}:${port}${HEALTH_PATH}`, { signal: AbortSignal.timeout(1500) });
    const body = res.ok ? await res.json().catch(() => null) : null;
    return body?.app === 'dtmux' ? body : { app: null };
  } catch (err) {
    if (err?.cause?.code === 'ECONNREFUSED') return null;
    return { app: null };
  }
}

// The daemon's tmux server hands its environment to every shell it opens, so
// start it from a clean one, as launchd would, not from wherever `dtmux` ran.
// Inherited variables change how shells behave: zsh, for one, picks vi
// keybindings at startup when EDITOR mentions vi, and then Backspace cannot
// delete text the line had before you entered insert mode.
const KEEP_ENV = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR', 'SSH_AUTH_SOCK'];
function daemonEnv() {
  const env = { LANG: 'en_US.UTF-8' }; // tmux mangles non-ASCII text without a UTF-8 locale
  for (const [k, v] of Object.entries(process.env)) {
    if (KEEP_ENV.includes(k) || k.startsWith('DTMUX_') || k === 'LANG' || k.startsWith('LC_')) env[k] = v;
  }
  return env;
}

async function start() {
  const { port } = config();
  const running = recordedDaemon();
  if (running) {
    if (running.port === port) {
      console.log(`dtmux is already running: http://${HOST}:${port}/  (pid ${running.pid})`);
    } else {
      console.log(
        `dtmux is already running on port ${running.port} (pid ${running.pid}), ` +
          `but ${CONFIG_PATH} now says ${port}. Run \`dtmux kill && dtmux\` to move it.`,
      );
    }
    return;
  }
  const other = await probe(port);
  if (other?.app === 'dtmux') {
    console.log(`dtmux is already running: http://${HOST}:${port}/  (pid ${other.pid})`);
    return;
  }
  if (other) die(`port ${port} is taken by something else; set another port in ${CONFIG_PATH}`);

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const out = fs.openSync(LOG_FILE, 'a');
  const [exec, args] = daemonSpawn(port);
  const child = spawn(exec, args, {
    cwd: process.env.HOME || (isSea() ? os.homedir() : repoRoot()),
    detached: true,
    stdio: ['ignore', out, out],
    env: daemonEnv(),
  });
  child.unref();

  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const up = await probe(port);
    if (up?.app === 'dtmux') {
      console.log(`dtmux started: http://${HOST}:${port}/  (pid ${up.pid}, log ${LOG_FILE})`);
      return;
    }
    if (child.exitCode !== null) break;
  }
  die(`the daemon did not come up; see ${LOG_FILE}`);
}

// The running daemon: from the pid file, else whatever dtmux answers on the
// configured port.
async function runningDaemon() {
  let target = recordedDaemon();
  if (!target) {
    // No usable pid file: fall back to whatever dtmux answers on the configured port.
    const { port } = config();
    const up = await probe(port);
    if (up?.app === 'dtmux') target = up;
  }
  return target;
}

async function stop() {
  const target = await runningDaemon();
  if (!target) {
    console.log('dtmux is not running');
    return;
  }
  process.kill(target.pid, 'SIGTERM');
  for (let i = 0; i < 200; i++) {
    if (!isAlive(target.pid)) {
      console.log(`dtmux stopped (pid ${target.pid}); its tmux sessions are gone`);
      return;
    }
    await sleep(100);
  }
  die(`pid ${target.pid} is still running after 20s; see ${LOG_FILE}`);
}

// Soft restart from outside, so it works whatever code the running daemon
// has. SIGUSR2 asks it to hand over and start its successor. A daemon from
// before soft restarts dies of SIGUSR2 instead, and one that hangs is killed:
// either way only the daemon goes. tmux runs as its own process and keeps
// every session, and a fresh daemon attaches to it.
async function restart(full) {
  const target = await runningDaemon();
  if (!target) {
    console.log('dtmux is not running; starting it');
    return start();
  }
  if (full) {
    await stop();
    return start();
  }
  const port = target.port ?? config().port;
  process.kill(target.pid, 'SIGUSR2');
  for (let i = 0; i < 50 && isAlive(target.pid); i++) await sleep(100);
  if (isAlive(target.pid)) {
    console.log(`pid ${target.pid} did not hand over in 5s; stopping only it (tmux keeps running)`);
    process.kill(target.pid, 'SIGKILL');
    for (let i = 0; i < 20 && isAlive(target.pid); i++) await sleep(100);
  }
  // Its successor, if it started one.
  for (let i = 0; i < 30; i++) {
    const up = await probe(port);
    if (up?.app === 'dtmux' && up.pid !== target.pid) {
      console.log(`dtmux restarted: http://${HOST}:${port}/  (pid ${up.pid}; tmux kept running)`);
      return;
    }
    await sleep(100);
  }
  await start();
}

async function status() {
  const running = recordedDaemon();
  if (running) console.log(`dtmux is running: http://${HOST}:${running.port}/  (pid ${running.pid})`);
  else {
    console.log('dtmux is not running');
    process.exitCode = 1;
  }
}

async function forgetSaved(id, session) {
  const running = recordedDaemon();
  if (!running) die('dtmux is not running');
  const url = new URL(`http://${HOST}:${running.port}/dtmux/forget-saved`);
  url.searchParams.set('id', id);
  if (session) url.searchParams.set('session', session);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-dtmux-cli': '1' },
    signal: AbortSignal.timeout(3000),
  });
  if (res.status !== 204) die(`could not forget saved tab ${id} (HTTP ${res.status})`);
  console.log(`Forgot saved tab ${id}`);
}

function showConfig() {
  const cfg = config();
  console.log(`# ${CONFIG_PATH}${fs.existsSync(CONFIG_PATH) ? '' : ' (missing; defaults)'}`);
  process.stdout.write(stringify(cfg));
}

const restartLine = isSea()
  ? 'start this binary again; tmux, its windows and shells keep running'
  : 'run the code on disk now; tmux, its windows and shells keep running';
const USAGE = `usage: dtmux [start | restart [--full] | kill | stop | status | config]

  start    start the daemon unless it is running (the default)
  restart  ${restartLine}
           (--full: save the windows as dotted tabs and end tmux as well)
  kill     stop it gently; its tmux sessions end with it (alias: stop)
  status   is it running, and on which port
  forget-saved <id> [session]  remove a saved tab without taking over the browser session
  config   validate ${CONFIG_PATH} and print the effective config`;

// Not top-level await: the single binary's bundle is CommonJS.
async function cli() {
  const cmd = process.argv[2] ?? 'start';
  const commands = { start, kill: stop, stop, status, config: showConfig };
  const args = process.argv.slice(3);
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') console.log(USAGE);
  else if (cmd === 'restart' && (args.length === 0 || (args.length === 1 && args[0] === '--full'))) await restart(args[0] === '--full');
  else if (cmd === 'forget-saved' && (args.length === 1 || args.length === 2)) await forgetSaved(...args);
  else if (!commands[cmd] || args.length) die(`unknown command "${process.argv.slice(2).join(' ')}"\n${USAGE}`, 2);
  else await commands[cmd]();
}

cli().catch((err) => {
  console.error(err);
  process.exit(1);
});
