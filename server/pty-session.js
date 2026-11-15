// Bridges one browser connection to a plain shell in a PTY (no tmux).
import os from 'node:os';
import pty from 'node-pty';
import { openExternal } from './open-external.js';
import { savePastedImage, pasteDir } from './paste-image.js';

const SHELL = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash');

export function attachShellSession(ws, { cols, rows }) {
  let term;
  try {
    term = pty.spawn(SHELL, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: os.homedir(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        // Claude Code enables the kitty keyboard protocol only for terminals it
        // recognizes. Claim one, since xterm.js implements it, so Shift+Enter works.
        TERM_PROGRAM: 'kitty',
      },
    });
  } catch (err) {
    console.error('pty spawn failed:', err.message);
    ws.send(JSON.stringify({ t: 'out', d: `\r\n\x1b[31mfailed to start shell: ${err.message}\x1b[0m\r\n` }));
    ws.close(1011, 'pty spawn failed');
    return;
  }

  term.onData((data) => ws.send(JSON.stringify({ t: 'out', d: data })));
  term.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ t: 'exit', code: exitCode }));
      ws.close();
    }
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'in':
        term.write(msg.d);
        break;
      case 'resize':
        if (msg.cols > 0 && msg.rows > 0) term.resize(msg.cols, msg.rows);
        break;
      case 'open':
        openExternal(msg.url);
        break;
      case 'paste-image':
        if (typeof msg.data !== 'string' || msg.data.length === 0 || msg.data.length > 16_000_000) break;
        try {
          const path = savePastedImage(Buffer.from(msg.data, 'base64'), pasteDir());
          ws.send(JSON.stringify({ t: 'paste-path', path }));
        } catch {
          // Not an image: the shell keeps its text paste.
        }
        break;
    }
  });
  ws.on('close', () => term.kill());
}
