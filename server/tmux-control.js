// A tmux control-mode client (`tmux -C`), speaking the line protocol over pipes.
//
// tmux writes one notification per line (`%output`, `%layout-change`, ...).
// Replies to our commands arrive wrapped in `%begin ... %end` (or `%error`)
// blocks, in the order the commands were sent. A block's third field is 1 when
// the command came from this client and 0 when tmux ran it on its own (for
// example a key binding), so only flag-1 blocks are matched to callbacks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

// dtmux's own copy of tmux, when macos/install.sh made one. macOS treats a
// tmux server as a program of its own when it asks for privacy permissions
// ("tmux would like to access data from other apps"), so with a copy of
// its own, what you allow dtmux's tmux is allowed to dtmux alone, not to
// every tmux. DTMUX_TMUX_BIN overrides it. (Not TMUX_BIN: an older login
// setup put that in dtmux's environment, from where it reached every shell
// in its tabs, and so every `dtmux` typed there.)
export const OWN_TMUX = path.join(os.homedir(), 'Library', 'Application Support', 'dtmux', 'dtmux-tmux');
export const TMUX_BIN = process.env.DTMUX_TMUX_BIN || (fs.existsSync(OWN_TMUX) ? OWN_TMUX : 'tmux');

// dtmux runs its own tmux server (`tmux -L <socket>`), apart from any tmux the
// user runs by hand, so stopping dtmux can take down exactly its sessions.
export const TMUX_SOCKET = process.env.DTMUX_TMUX_SOCKET || 'dtmux';
export const tmuxArgs = (...args) => ['-L', TMUX_SOCKET, ...args];

// %output data escapes bytes below 0x20 and the backslash as `\ooo` octal.
// Everything else, including UTF-8, arrives as raw bytes.
export function decodeOutput(buf, start) {
  const out = Buffer.allocUnsafe(buf.length - start);
  let j = 0;
  for (let i = start; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x5c && i + 3 < buf.length && isOctal(buf[i + 1]) && isOctal(buf[i + 2]) && isOctal(buf[i + 3])) {
      out[j++] = ((buf[i + 1] - 48) << 6) | ((buf[i + 2] - 48) << 3) | (buf[i + 3] - 48);
      i += 3;
    } else {
      out[j++] = b;
    }
  }
  return out.subarray(0, j);
}
const isOctal = (b) => b >= 48 && b <= 55;

// Quote a string as one tmux command argument.
export function quote(s) {
  return '"' + String(s).replace(/[\\"$]/g, '\\$&') + '"';
}

export class TmuxControl extends EventEmitter {
  // Attach to `session`, creating it at cols x rows if it does not exist, its
  // first window in `cwd` and, when given, named `windowName` and running
  // `command` (a shell command) instead of a shell.
  constructor({ session, cols, rows, cwd, windowName, command }) {
    super();
    const env = { ...process.env, TERM: 'xterm-256color' };
    delete env.TMUX; // we may ourselves be running inside tmux
    delete env.TMUX_PANE;
    this.proc = spawn(
      TMUX_BIN,
      tmuxArgs('-C', 'new-session', '-A', '-s', session, '-x', String(cols), '-y', String(rows), '-c', cwd, ...(windowName ? ['-n', windowName] : []), ...(command ? [command] : [])),
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this._buf = Buffer.alloc(0);
    this._block = null;
    this._pending = []; // one { batch, cb } per command, or { mark, ... } for runLine
    this._marks = 0;
    this.closed = false;
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.on('data', (d) => this.emit('stderr', d.toString()));
    this.proc.stdin.on('error', () => {});
    this.proc.on('error', (err) => this._finish(err.message));
    this.proc.on('exit', (code, signal) => this._finish(`tmux exited (${signal ?? code})`));
  }

  get pendingCommands() {
    return this._pending.length;
  }

  // Run one command. `cb(err, lines)` runs synchronously when its reply block
  // ends, before any later protocol line is processed. Callers rely on that
  // to switch pane output on at exactly the right point in the stream.
  run(cmd, cb = () => {}) {
    this.runList([cmd], ([r]) => cb(r.err, r.lines));
  }

  // Run commands as one command list. tmux executes a list without reading
  // pane output in between, so the list acts as one atomic step.
  runList(cmds, cb = () => {}) {
    if (this.closed) {
      cb(cmds.map(() => ({ err: new Error('tmux control client closed'), lines: [] })));
      return;
    }
    const results = new Array(cmds.length);
    let left = cmds.length;
    cmds.forEach((_, i) =>
      this._pending.push({
        batch: results,
        cb: (err, lines) => {
          results[i] = { err, lines };
          if (--left === 0) cb(results);
        },
      }),
    );
    this.proc.stdin.write(cmds.join(' ; ') + '\n');
  }

  // Run a command line we did not write, such as a key binding's, which may
  // hold any number of commands. tmux answers each one separately, so the
  // replies are collected up to a marker sent on a line of its own (which
  // runs even when the first line does not parse). `cb(err, lines)` gets the
  // first error and every output line.
  runLine(line, cb = () => {}) {
    if (this.closed) {
      cb(new Error('tmux control client closed'), []);
      return;
    }
    const mark = `dtmux-mark-${++this._marks}`;
    this._pending.push({ mark, err: null, lines: [], cb });
    // An empty line would detach this client.
    this.proc.stdin.write(`${line.trim() ? `${line}\n` : ''}display -p ${mark}\n`);
  }

  // Promise form of run(), for callers that do not need synchronous ordering.
  command(cmd) {
    return new Promise((resolve, reject) => this.run(cmd, (err, lines) => (err ? reject(err) : resolve(lines))));
  }

  // Detach. Closing stdin makes the control client exit; the session lives on.
  close() {
    if (this.closed) return;
    this.proc.stdin.end();
    setTimeout(() => this.proc.kill(), 2000).unref();
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    let start = 0;
    let nl;
    while ((nl = this._buf.indexOf(10, start)) !== -1) {
      this._onLine(this._buf.subarray(start, nl));
      start = nl + 1;
    }
    this._buf = this._buf.subarray(start);
  }

  _onLine(line) {
    if (this._block) {
      const head = line.toString('latin1', 0, Math.min(line.length, 64));
      if (head === `%end ${this._block.id}` || head === `%error ${this._block.id}`) {
        const { flags, lines } = this._block;
        this._block = null;
        const p = flags === '1' && this._pending[0];
        if (!p) return;
        const err = head.startsWith('%error') ? new Error(lines.join('\n') || 'tmux error') : null;
        if (!p.mark) {
          this._pending.shift();
          // tmux discards the rest of a command list on error. Remove those
          // entries before any callback can enqueue another command.
          const skipped = [];
          if (err) {
            while (this._pending[0]?.batch === p.batch) skipped.push(this._pending.shift());
          }
          p.cb(err, lines);
          for (const entry of skipped) entry.cb(err, []);
        } else if (!err && lines.length === 1 && lines[0] === p.mark) {
          this._pending.shift();
          p.cb(p.err, p.lines);
        } else {
          p.err ??= err;
          p.lines.push(...lines);
        }
      } else {
        this._block.lines.push(line.toString('utf8'));
      }
      return;
    }
    if (line[0] !== 0x25 /* % */) return;
    const sp = line.indexOf(32);
    const name = line.toString('latin1', 1, sp === -1 ? line.length : sp);
    if (name === 'output') {
      const sp2 = line.indexOf(32, sp + 1);
      if (sp2 === -1) return;
      this.emit('output', line.toString('latin1', sp + 1, sp2), decodeOutput(line, sp2 + 1));
      return;
    }
    const rest = sp === -1 ? '' : line.toString('utf8', sp + 1);
    if (name === 'begin') {
      this._block = { id: rest, flags: rest.split(' ')[2], lines: [] };
    } else if (name === 'exit') {
      this._finish(rest || 'detached');
    } else {
      this.emit('notify', name, rest);
    }
  }

  _finish(reason) {
    if (this.closed) return;
    this.closed = true;
    const err = new Error(reason);
    for (const p of this._pending.splice(0)) p.cb(err, []);
    this.emit('exit', reason);
  }
}
