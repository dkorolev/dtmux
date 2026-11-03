# dtmux

Dima's terminal multiplexer: the xterm.js browser terminal over tmux control
mode, run as a background daemon with its own tmux server.

```
npm install
bin/dtmux.js            # start the daemon (no-op if it is already running)
bin/dtmux.js kill       # stop it gently; its tmux sessions end with it
bin/dtmux.js status
bin/dtmux.js config     # validate ~/.dtmux.yaml, print the effective config
```

`npm link` puts `dtmux` on your PATH.

Then open http://127.0.0.1:7778/. `?session=NAME` opens another tmux session
and `?mode=shell` opens a plain shell, as before.

## Config: `~/.dtmux.yaml`

```yaml
port: 7778   # integer, 1..65535; the default
```

A missing or empty file means the defaults. Anything else must match the
schema exactly: unknown keys, wrong types, out-of-range values, duplicate
keys and YAML syntax errors all stop `dtmux` with every problem listed (exit
code 2). If you change the port while dtmux runs, `dtmux` tells you so;
`dtmux kill && dtmux` moves it.

## Lifecycle

- dtmux talks to its own tmux server (`tmux -L dtmux`), separate from any tmux
  you run by hand. It still reads your `~/.tmux.conf`. To look at its sessions
  from a shell, run `tmux -L dtmux ls`.
- `dtmux kill`, a plain `kill <pid>` (SIGTERM, or SIGINT), or the Restart
  button in the page first saves every tmux window of every session (name,
  directory, tab order, and a long unique id kept in the window option
  `@dtmux_id`), then closes the browser connections, runs
  `tmux -L dtmux kill-server` (the shells in its panes get SIGHUP), removes the
  pid file and exits. The Restart button then starts a new daemon on the same
  port, running the code as it is on disk; open pages reconnect by themselves.
- The next `dtmux` reopens nothing by itself. The saved windows show up as
  dotted tabs. Clicking one opens a new window with that name, in that
  directory. While saved windows exist and the session does not, opening the
  page does not create an empty session either: it shows the dotted tabs and
  a "Start new session" button, and the first dotted tab you click becomes the
  session's first window. Saved windows you never reopen stay saved
  across later restarts. A live window that looks exactly like a saved one
  (same name, directory and naming) takes its place, so the shell tmux opens
  to start a session does not pile up copies.
- Tabs, dotted ones included, can be dragged to reorder them. The order is
  remembered in the browser, and tmux renumbers its windows to match, so
  prefix + digit follows the tabs. A tapped dotted tab opens in its own slot,
  and tabs stay put while the page reconnects or dtmux restarts.
- While the daemon is away, the page reconnects by itself three times a second
  and shows the command that starts it again.
- When Claude, Codex or the Cursor agent prints its resume command, a bubble
  shows the command with the directory and git state; clicking it copies the
  command.
- State lives in `~/.dtmux/`: `dtmux.pid`, `dtmux.log` and
  `saved-windows.json`.

Environment overrides, mostly for testing: `DTMUX_CONFIG`, `DTMUX_STATE_DIR`,
`DTMUX_TMUX_SOCKET`, `DTMUX_SESSION` (default session name, `dtmux`),
`TMUX_BIN`.

## Layout

| Path                       | Role                                                 |
| -------------------------- | ---------------------------------------------------- |
| `bin/dtmux.js`             | CLI: start, kill, status, config                     |
| `server/daemon.js`         | the detached process; gentle shutdown on SIGTERM     |
| `server/config.js`         | `~/.dtmux.yaml` loading and strict schema            |
| `server/saved-windows.js`  | windows saved on stop, offered back as dotted tabs   |
| `server/app.js`            | HTTP, static files, WebSocket routing, health check  |
| `server/tmux-control.js`   | tmux control-mode protocol client                    |
| `server/tmux-session.js`   | bridges one browser connection to a tmux session     |
| `server/kitty-tracker.js`  | remembers kitty keyboard flags per pane for reattach |
| `server/tmux-bindings.js`  | spots bindings that open tmux prompts, fills them in |
| `server/pty-session.js`    | plain-shell mode                                     |
| `public/`                  | the browser client                                   |

`npm test` runs the unit tests.
