#!/usr/bin/env node
// dtmux — Dima's terminal multiplexer: a browser terminal over its own tmux.
//
//   dtmux [start]     start the daemon unless it is already running
//   dtmux kill|stop   stop it gently, taking its tmux sessions with it
//   dtmux status      say whether it is running, and where
//   dtmux config      validate ~/.dtmux.yaml and print the effective config
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, ConfigError, CONFIG_PATH } from '../server/config.js';
import { PID_FILE, LOG_FILE, STATE_DIR } from '../server/paths.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const KEEP_ENV = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR', 'SSH_AUTH_SOCK', 'TMUX_BIN'];
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
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'daemon.js'), String(port)], {
    cwd: process.env.HOME || ROOT,
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

async function stop() {
  let target = recordedDaemon();
  if (!target) {
    // No usable pid file: fall back to whatever dtmux answers on the configured port.
    const { port } = config();
    const up = await probe(port);
    if (up?.app === 'dtmux') target = up;
  }
  if (!target) {
    console.log('dtmux is not running');
    return;
  }
  process.kill(target.pid, 'SIGTERM');
  for (let i = 0; i < 100; i++) {
    if (!isAlive(target.pid)) {
      console.log(`dtmux stopped (pid ${target.pid}); its tmux sessions are gone`);
      return;
    }
    await sleep(100);
  }
  die(`pid ${target.pid} is still running after 10s; see ${LOG_FILE}`);
}

async function status() {
  const running = recordedDaemon();
  if (running) console.log(`dtmux is running: http://${HOST}:${running.port}/  (pid ${running.pid})`);
  else {
    console.log('dtmux is not running');
    process.exitCode = 1;
  }
}

function showConfig() {
  const cfg = config();
  console.log(`# ${CONFIG_PATH}${fs.existsSync(CONFIG_PATH) ? '' : ' (missing; defaults)'}`);
  for (const [k, v] of Object.entries(cfg)) console.log(`${k}: ${v}`);
}

const USAGE = `usage: dtmux [start | kill | stop | status | config]

  start    start the daemon unless it is running (the default)
  kill     stop it gently; its tmux sessions end with it (alias: stop)
  status   is it running, and on which port
  config   validate ${CONFIG_PATH} and print the effective config`;

const cmd = process.argv[2] ?? 'start';
const commands = { start, kill: stop, stop, status, config: showConfig };
if (cmd === '-h' || cmd === '--help' || cmd === 'help') console.log(USAGE);
else if (!commands[cmd] || process.argv.length > 3) die(`unknown command "${process.argv.slice(2).join(' ')}"\n${USAGE}`, 2);
else await commands[cmd]();
