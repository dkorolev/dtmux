// The long-running dtmux process, started detached by `dtmux start`.
//
// On SIGTERM, SIGINT or the page's Restart button it shuts down gently: it saves
// every tmux window's name and directory (see saved-windows.js), closes browser
// connections, stops its own tmux server (`tmux -L dtmux kill-server`, which
// sends SIGHUP to the shells in its panes), removes its pid file and exits.
// The next start begins with fresh tmux sessions and offers the saved windows
// as dotted tabs. A restart does the same and then starts a new daemon on the
// same port, running the code as it is on disk now.
import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, HOST, DEFAULT_SESSION } from './app.js';
import { TMUX_BIN, TMUX_SOCKET, tmuxArgs } from './tmux-control.js';
import { PID_FILE, STATE_DIR, LOG_FILE } from './paths.js';
import { saveOnStop, ID_OPTION } from './saved-windows.js';

const port = Number(process.argv[2]);
const restarted = process.argv[3] === '--restarted';
if (!Number.isInteger(port)) {
  console.error('usage: daemon.js <port>   (run `dtmux start` instead)');
  process.exit(2);
}

process.title = 'dtmux';
const log = (msg) => console.log(`${new Date().toISOString()} [${process.pid}] ${msg}`);

let server, wss;
// After a restart the old daemon has just let go of the port; give the OS a
// moment if it has not caught up.
for (let tries = 0; ; tries++) {
  try {
    ({ server, wss } = await startServer({
      port,
      onStop: () => shutdown('Stop'),
      onRestart: () => shutdown('Restart button', { restart: true }),
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
function shutdown(signal, { restart = false } = {}) {
  if (stopping) return;
  stopping = true;
  log(`${signal}: stopping`);
  // Never hang on the way out.
  setTimeout(() => {
    log('shutdown took too long, exiting');
    process.exit(1);
  }, 8000).unref();

  // Stop listening first: a page reconnecting now must not reach this
  // daemon, which is about to take its tmux down (and, on a restart, must
  // reach the next one instead).
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeIdleConnections?.();
  for (const ws of wss.clients) ws.close(1001, restart ? 'dtmux restarting' : 'dtmux stopping');
  saveWindows(() => execFile(TMUX_BIN, tmuxArgs('kill-server'), (err, _out, stderr) => {
    // "no server running" just means no tmux session was ever opened.
    if (err && !/no server running|error connecting/i.test(stderr)) log(`tmux kill-server: ${stderr.trim() || err.message}`);
    else log(`tmux server "${TMUX_SOCKET}" stopped`);
    try {
      const cur = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
      if (cur.pid === process.pid) fs.unlinkSync(PID_FILE);
    } catch {}
    server.closeAllConnections?.();
    closed.then(() => {
      if (restart) startAgain();
      log('stopped');
      process.exit(0);
    });
  }));
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

const LIVE_FORMAT = [
  '#{session_name}',
  '#{window_index}',
  `#{${ID_OPTION}}`,
  '#{automatic-rename}',
  '#{pane_current_path}',
  '#{window_name}',
].join('\t');

// Every window of every session, written down before tmux goes away.
function saveWindows(done) {
  execFile(TMUX_BIN, tmuxArgs('list-windows', '-a', '-F', LIVE_FORMAT), (err, out, stderr) => {
    const live = [];
    if (err) {
      if (!/no server running|error connecting/i.test(stderr)) log(`list-windows: ${stderr.trim() || err.message}`);
    } else {
      for (const line of out.split('\n').filter(Boolean)) {
        const [session, index, id, auto, dir, ...name] = line.split('\t');
        live.push({ session, index: Number(index), id, autoName: auto === '1', dir, name: name.join('\t') });
      }
    }
    try {
      log(`saved ${saveOnStop(live)} window(s) for later (${live.length} were open)`);
    } catch (e) {
      log(`could not save windows: ${e.message}`);
    }
    done();
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => {}); // detached; a closing terminal is not a reason to stop
