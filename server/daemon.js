// The long-running dtmux process, started detached by `dtmux start`.
//
// On SIGTERM, SIGINT or the page's Restart button it shuts down gently: it saves
// every tmux window's name and directory (see saved-windows.js), closes browser
// connections, stops its own tmux server (`tmux -L dtmux kill-server`, which
// sends SIGHUP to the shells in its panes), removes its pid file and exits.
// The next start begins with fresh tmux sessions and offers the saved windows
// as dotted tabs. A restart does the same and then starts a new daemon on the
// same port, running the code as it is on disk now. A soft restart starts the
// new daemon without touching tmux: sessions, windows and shells keep running
// and pages reattach to them.
//
// Every 30 s it also writes down what is open (live-snapshot.js), so that a
// stop that could not save (a crash, power loss, tmux gone first at a
// reboot) still brings the windows back as dotted tabs on the next start.
import fs from 'node:fs';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, HOST, DEFAULT_SESSION } from './app.js';
import { TMUX_BIN, TMUX_SOCKET, tmuxArgs } from './tmux-control.js';
import { PID_FILE, STATE_DIR, LOG_FILE, HANDOVER_FILE } from './paths.js';
import { exportKitty, importKitty } from './kitty-tracker.js';
import { saveOnStop } from './saved-windows.js';
import { closeAgents } from './agent-close.js';
import { LIVE_FORMAT, parseLive, writeSnapshot, readSnapshot, dropSnapshot } from './live-snapshot.js';
import { listPanes, agentsByPane } from './window-panes.js';
import { sweepMachines, SWEEP_MS } from './machine-sweep.js';

const port = Number(process.argv[2]);
const restarted = process.argv[3] === '--restarted';
if (!Number.isInteger(port)) {
  console.error('usage: daemon.js <port>   (run `dtmux start` instead)');
  process.exit(2);
}

// Bump only for a change a newer daemon could not read. Readers take the
// sections they know and skip the rest, so adding a section needs no bump;
// an unknown version is ignored, which costs only what it would have carried.
const HANDOVER_VERSION = 1;

process.title = 'dtmux';
const log = (msg) => console.log(`${new Date().toISOString()} [${process.pid}] ${msg}`);

takeHandOver();
recoverSnapshot();

let server, wss;
// After a restart the old daemon has just let go of the port; give the OS a
// moment if it has not caught up.
for (let tries = 0; ; tries++) {
  try {
    ({ server, wss } = await startServer({
      port,
      onStop: () => shutdown('Stop'),
      onRestart: () => shutdown('Restart button', { restart: true }),
      onSoftRestart: () => shutdown('Soft restart button', { restart: true, soft: true }),
    }));
    break;
  } catch (err) {
    if (restarted && err.code === 'EADDRINUSE' && tries < 50) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    log(`cannot listen on ${HOST}:${port}: ${err.message}`);
    process.exit(1);
  }
}
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port }) + '\n');
log(`listening on http://${HOST}:${port}/  (tmux -L ${TMUX_SOCKET}, session "${DEFAULT_SESSION}")`);

let stopping = false;
function shutdown(signal, { restart = false, soft = false } = {}) {
  if (stopping) return;
  stopping = true;
  log(`${signal}: stopping`);
  // Never hang on the way out.
  setTimeout(() => {
    log('shutdown took too long, exiting');
    process.exit(1);
  }, 15000).unref(); // closing coding agents takes up to ~6 s of it

  // Stop listening first: a page reconnecting now must not reach this
  // daemon, which is about to take its tmux down (and, on a restart, must
  // reach the next one instead).
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeIdleConnections?.();
  for (const ws of wss.clients) ws.close(1001, restart ? 'dtmux restarting' : 'dtmux stopping');
  if (soft) {
    // tmux stays up; only this process goes. Pages' tmux clients detach
    // as their sockets close.
    handOver(() => {
      removePidFile();
      server.closeAllConnections?.();
      closed.then(() => {
        startAgain();
        log('stopped (soft restart: tmux left running)');
        process.exit(0);
      });
    });
    return;
  }
  saveWindows(() => execFile(TMUX_BIN, tmuxArgs('kill-server'), (err, _out, stderr) => {
    // "no server running" just means no tmux session was ever opened.
    if (err && !/no server running|error connecting/i.test(stderr)) log(`tmux kill-server: ${stderr.trim() || err.message}`);
    else log(`tmux server "${TMUX_SOCKET}" stopped`);
    removePidFile();
    server.closeAllConnections?.();
    closed.then(() => {
      if (restart) startAgain();
      log('stopped');
      process.exit(0);
    });
  }));
}

function removePidFile() {
  try {
    const cur = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    if (cur.pid === process.pid) fs.unlinkSync(PID_FILE);
  } catch {}
}

// What a soft restart passes on: the panes' kitty keyboard flags, which tmux
// cannot report. Tied to the tmux server's pid, since pane ids start over
// with a new server.
function handOver(done) {
  execFile(TMUX_BIN, tmuxArgs('display', '-p', '#{pid}'), (err, out) => {
    try {
      if (!err) fs.writeFileSync(HANDOVER_FILE, JSON.stringify({ version: HANDOVER_VERSION, tmuxPid: out.trim(), kitty: exportKitty() }) + '\n');
    } catch (e) {
      log(`could not write the hand-over: ${e.message}`);
    }
    done();
  });
}

// Before any page connects, so the first snapshots already carry the flags.
function takeHandOver() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(HANDOVER_FILE, 'utf8'));
    fs.unlinkSync(HANDOVER_FILE);
  } catch {
    return;
  }
  let tmuxPid = '';
  try {
    tmuxPid = execFileSync(TMUX_BIN, tmuxArgs('display', '-p', '#{pid}'), { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {}
  if (!tmuxPid || tmuxPid !== data?.tmuxPid) return; // tmux restarted since: the pane ids mean other panes now
  if ((data.version ?? 1) !== HANDOVER_VERSION) {
    log(`ignoring a hand-over of version ${data.version}`);
    return;
  }
  importKitty(data.kitty);
  log(`picked up kitty keyboard state for ${data.kitty?.length ?? 0} pane(s) from the previous daemon`);
}

// The next daemon: same port, same environment, its output to the log.
function startAgain() {
  try {
    const out = fs.openSync(LOG_FILE, 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), String(port), '--restarted'], {
      cwd: process.cwd(),
      detached: true,
      stdio: ['ignore', out, out],
      env: process.env,
    });
    child.unref();
    log(`restarting as pid ${child.pid}`);
  } catch (err) {
    log(`could not start again: ${err.message}`);
  }
}

// Every window of every session, written down before tmux goes away: its
// directory and git branch, and, for a coding agent, how to resume it. The
// agents are closed first so they print their resume lines (agent-close.js).
async function saveWindows(done) {
  const sessions = await new Promise((resolve) =>
    execFile(TMUX_BIN, tmuxArgs('list-sessions', '-F', '#{session_name}'), (err, out) =>
      resolve(err ? [] : out.split('\n').filter(Boolean)),
    ),
  );
  const found = (await Promise.all(sessions.map((s) => closeAgents(s, { log }).catch(() => [])))).flat();
  const agents = agentsByPane(found); // pane id -> the agent to resume there
  if (agents.size) log(`closed ${agents.size} coding agent(s) to resume later`);
  const windows = await listPanes(TMUX_BIN, tmuxArgs);
  execFile(TMUX_BIN, tmuxArgs('list-windows', '-a', '-F', LIVE_FORMAT), (err, out, stderr) => {
    let live = [];
    if (err) {
      if (!/no server running|error connecting/i.test(stderr)) log(`list-windows: ${stderr.trim() || err.message}`);
      // tmux went first (at shutdown everything is told to stop at once):
      // what was open a moment ago will do.
      const snap = readSnapshot();
      if (snap?.live.length) {
        live = snap.live;
        log(`tmux is gone; saving the ${live.length} window(s) open at ${snap.at}`);
      }
    } else live = parseLive(out, agents, windows);
    try {
      log(`saved ${saveOnStop(live)} window(s) for later (${live.length} were open)`);
      dropSnapshot();
    } catch (e) {
      log(`could not save windows: ${e.message}`);
    }
    done();
  });
}

// After a stop that saved nothing (a crash, power loss): if the tmux server
// the snapshot describes is gone, its windows become dotted tabs.
function recoverSnapshot() {
  const snap = readSnapshot();
  if (!snap) return;
  let pid = '';
  try {
    pid = execFileSync(TMUX_BIN, tmuxArgs('display', '-p', '#{pid}'), { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {}
  if (pid && pid === snap.tmuxPid) return; // still running (a soft restart): nothing was lost
  try {
    log(`dtmux did not stop cleanly; ${saveOnStop(snap.live)} window(s) saved from the snapshot of ${snap.at}`);
    dropSnapshot();
  } catch (e) {
    log(`could not recover the snapshot: ${e.message}`);
  }
}

// Keep the snapshot fresh while running.
const SNAPSHOT_MS = 30000;
let snapshotBusy = false;
setInterval(async () => {
  if (stopping || snapshotBusy) return;
  snapshotBusy = true;
  try {
    await writeSnapshot();
  } catch (e) {
    log(`snapshot: ${e.message}`);
  }
  snapshotBusy = false;
}, SNAPSHOT_MS).unref();

// Delete remote machines no tab stands for any more (see machine-sweep.js).
let sweepBusy = false;
setInterval(async () => {
  if (stopping || sweepBusy) return;
  sweepBusy = true;
  try {
    await sweepMachines(log);
  } catch (e) {
    log(`machine sweep: ${e.message}`);
  }
  sweepBusy = false;
}, SWEEP_MS).unref();

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => {}); // detached; a closing terminal is not a reason to stop
// `dtmux restart`: a soft restart, tmux left running.
process.on('SIGUSR2', () => shutdown('SIGUSR2', { restart: true, soft: true }));
