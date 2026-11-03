// HTTP + WebSocket server. Serves the browser client and bridges each browser
// connection either to a tmux session in control mode (the default) or to a
// plain shell in a PTY (?mode=shell).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { attachTmuxSession } from './tmux-session.js';
import { attachShellSession } from './pty-session.js';
import { TMUX_SOCKET } from './tmux-control.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The command the page shows for starting the daemon again once it is gone.
const START_CMD = (() => {
  const bin = path.join(ROOT, 'bin', 'dtmux.js');
  const shell = /^[\w\/.-]+$/.test(bin) ? bin : `'${bin.replaceAll("'", `'\\''`)}'`;
  return shell.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
})();
const PUBLIC = path.join(ROOT, 'public');
export const HOST = '127.0.0.1';
export const DEFAULT_SESSION = process.env.DTMUX_SESSION || 'dtmux';
export const HEALTH_PATH = '/dtmux/health';

// First seven hex digits of HEAD, plus "-dirty" when the worktree has
// uncommitted changes. Read per page and per connection so a refresh shows
// the repo as it is now.
function readCommit() {
  const opts = { cwd: ROOT, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], opts).trim().slice(0, 7);
    if (!/^[0-9a-f]{7}$/.test(hash)) return '';
    const dirty = execFileSync('git', ['status', '--porcelain'], opts).trim() ? '-dirty' : '';
    return hash + dirty;
  } catch {
    return '';
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};
const VENDOR = {
  'xterm.mjs': 'node_modules/@xterm/xterm/lib/xterm.mjs',
  'xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  'addon-fit.mjs': 'node_modules/@xterm/addon-fit/lib/addon-fit.mjs',
  'addon-web-links.mjs': 'node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs',
  'addon-webgl.mjs': 'node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs',
};

// Our page and modules from public/, plus the xterm.js bundles from node_modules.
function resolveStatic(pathname) {
  if (pathname.startsWith('/vendor/')) {
    const file = VENDOR[pathname.slice('/vendor/'.length)];
    return file && path.join(ROOT, file);
  }
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  return file.startsWith(PUBLIC + path.sep) ? file : null;
}

// Resolves with the listening server once it is bound to `port`.
// `onStop` runs when a page asks the daemon to stop (the Stop button).
export function startServer({ port, onStop = () => {} }) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
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
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(err.code === 'ENOENT' ? 404 : 500).end(err.code === 'ENOENT' ? 'not found' : err.message);
        return;
      }
      const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
      if (path.basename(file) === 'index.html') {
        data = Buffer.from(
          String(data).replaceAll('__XTERMJS_COMMIT__', readCommit()).replaceAll('__DTMUX_START_CMD__', START_CMD),
        );
      }
      // no-store: a refresh must run the files just read, not a module the
      // browser kept from before this process knew the commit.
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    // Same-origin only: refuse handshakes coming from other sites.
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) {
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
    attachTmuxSession(ws, { session, cols, rows, commit: readCommit(), onStop });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => resolve({ server, wss }));
  });
}
