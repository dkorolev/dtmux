// HTTP + WebSocket server. Serves the browser client and bridges each browser
// connection either to a tmux session in control mode (the default) or to a
// plain shell in a PTY (?mode=shell).
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { attachTmuxSession } from './tmux-session.js';
import { attachShellSession } from './pty-session.js';
import { takeSaved } from './saved-windows.js';
import { TMUX_SOCKET } from './tmux-control.js';
import { startCommand } from './locate.js';
import { VENDOR, readRepoFile, repoFileExists, pageFingerprint, bakedCommit, gitCommit } from './assets.js';

// The command the page shows for starting the daemon again once it is gone.
const START_CMD = startCommand();
export const HOST = '127.0.0.1';
export const DEFAULT_SESSION = process.env.DTMUX_SESSION || 'dtmux';
export const HEALTH_PATH = '/dtmux/health';
// Close code for a page whose session another page took (see tmux-mode.js).
export const TAKEN_CODE = 4001;

const LOCAL_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;
const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

// Only connections from this machine, addressed to this machine (not a DNS
// rebinding domain pointing at 127.0.0.1), and on WebSockets only from a page
// served by this origin.
export function isLocalRequest(req, { requireOrigin = false } = {}) {
  const addr = req.socket?.remoteAddress;
  if (!isLoopback(addr)) return false;
  const host = req.headers?.host;
  if (typeof host !== 'string' || !LOCAL_HOST.test(host)) return false;
  const origin = req.headers?.origin;
  if (origin === undefined) return !requireOrigin;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

// First seven hex digits of HEAD, plus "-dirty" when the worktree has
// uncommitted changes. Read per page and per connection so a refresh shows
// the repo as it is now. The binary has no worktree; it shows the commit it
// was built from.
function readCommit() {
  return bakedCommit() ?? gitCommit();
}

// A fingerprint of the files the page runs (public/). A page that was loaded
// from other files reloads itself when it (re)connects, so a soft restart,
// or any reconnect, brings the browser side up to date as well.
const readBuild = pageFingerprint;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};

// Our page and modules from public/, plus the xterm.js bundles. A key
// relative to the checkout (or the binary's embedded copy of it), or null.
function resolveStatic(pathname) {
  if (pathname.startsWith('/vendor/')) {
    const rel = VENDOR[pathname.slice('/vendor/'.length)];
    return rel && repoFileExists(rel) ? rel : null;
  }
  const raw = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (raw.includes('\0')) return null;
  const norm = path.posix.normalize(raw);
  if (norm.startsWith('../') || norm === '..' || path.posix.isAbsolute(norm)) return null;
  const rel = `public/${norm}`;
  return repoFileExists(rel) ? rel : null;
}

// Resolves with the listening server once it is bound to `port`.
// `onStop` runs when a page asks the daemon to stop, `onRestart` when it asks
// for a full restart, `onSoftRestart` for a soft one (tmux keeps running).
export function startServer({ port, onStop = () => {}, onRestart = () => {}, onSoftRestart = () => {} }) {
  const server = http.createServer((req, res) => {
    if (!isLocalRequest(req)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = url;
    if (pathname === '/dtmux/forget-saved') {
      if (req.method !== 'POST' || req.headers['x-dtmux-cli'] !== '1' || req.headers.origin !== undefined) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const session = url.searchParams.get('session') || DEFAULT_SESSION;
      const id = url.searchParams.get('id');
      if (!/^[\w.-]{1,64}$/.test(session) || !id) {
        res.writeHead(400).end('invalid session or tab ID');
        return;
      }
      res.writeHead(takeSaved(session, id) ? 204 : 404).end();
      return;
    }
    if (pathname === HEALTH_PATH) {
      // The CLI uses this to tell a running dtmux from anything else on the port.
      const body = { app: 'dtmux', pid: process.pid, port, tmuxSocket: TMUX_SOCKET, session: DEFAULT_SESSION };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
      return;
    }
    const file = resolveStatic(pathname);
    if (!file) {
      res.writeHead(404).end('not found');
      return;
    }
    let data;
    try {
      data = readRepoFile(file);
    } catch (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500).end(err.code === 'ENOENT' ? 'not found' : err.message);
      return;
    }
    const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
    if (path.basename(file) === 'index.html') {
      data = Buffer.from(
        String(data)
          .replaceAll('__XTERMJS_COMMIT__', readCommit())
          .replaceAll('__DTMUX_BUILD__', readBuild())
          .replaceAll('__DTMUX_START_CMD__', START_CMD),
      );
    }
    // no-store: a refresh must run the files just read, not a module the
    // browser kept from before this process knew the commit.
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
  server.on('connection', (socket) => {
    if (!isLoopback(socket.remoteAddress)) socket.destroy();
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  const owners = new Map(); // session -> the page's socket that has it
  wss.on('connection', (ws, req) => {
    // Local, same-origin only: refuse non-loopback sockets, DNS-rebound Host
    // headers, missing/null Origins, and handshakes coming from other sites.
    if (!isLocalRequest(req, { requireOrigin: true })) {
      ws.close(1008, 'bad origin');
      return;
    }
    const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const cols = Math.max(2, Math.trunc(Number(params.get('cols'))) || 80);
    const rows = Math.max(2, Math.trunc(Number(params.get('rows'))) || 24);
    if (params.get('mode') === 'shell') {
      attachShellSession(ws, { cols, rows });
      return;
    }
    const session = params.get('session') || DEFAULT_SESSION;
    if (!/^[\w.-]{1,64}$/.test(session)) {
      ws.close(1008, 'bad session name');
      return;
    }
    // One page per session: the newest takes it, the one before steps aside
    // (it shows a button that takes the session back). Two pages at once
    // would each keep their own tab order and push it into tmux in turn.
    const before = owners.get(session);
    if (before && before.readyState <= 1) {
      try {
        before.send(JSON.stringify({ t: 'taken' }));
      } catch {}
      before.close(TAKEN_CODE, 'open in another page');
    }
    owners.set(session, ws);
    ws.on('close', () => {
      if (owners.get(session) === ws) owners.delete(session);
    });
    attachTmuxSession(ws, { session, cols, rows, commit: readCommit(), build: readBuild(), onStop, onRestart, onSoftRestart });
  });

  return new Promise((resolve, reject) => {
    // The WebSocket server re-emits the HTTP server's listen error; that is
    // this promise's rejection, not a crash.
    const fail = (err) => {
      wss.close();
      reject(err);
    };
    wss.once('error', () => {});
    server.once('error', fail);
    server.listen(port, HOST, () => {
      server.off('error', fail);
      resolve({ server, wss });
    });
  });
}
