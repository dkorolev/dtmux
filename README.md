# dtmux

Dima's terminal multiplexer: the xterm.js browser terminal over tmux control
mode, run as a background daemon with its own tmux server.

```
npm install
bin/dtmux.js            # start the daemon (no-op if it is already running)
bin/dtmux.js restart    # run the code on disk now; tmux and every shell keep running
bin/dtmux.js restart --full   # save the windows as dotted tabs, end tmux, start again
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
  pid file and exits. Restart › Full restart does that and then starts a new
  daemon on the same port, running the code as it is on disk; open pages
  reconnect by themselves.
- Restart › Soft restart starts the new daemon without touching tmux: every
  session, window and shell keeps running, and open pages reattach with
  their terminals still on screen. The panes' kitty keyboard state (which
  keeps Shift+Enter working in Claude Code) is handed to the new daemon in
  `~/.dtmux/handover.json`, used only if the tmux server is still the same.

### A soft restart is always enough

Any change to dtmux itself (server, page, dependencies) is picked up by a
soft restart; a full restart is only for tmux itself (a new tmux binary, or
a fresh tmux server environment). Three things keep it that way:

- The page reloads itself when it reconnects to a daemon serving different
  page files (`build`, a fingerprint of `public/`, in `hello` and `idle`).
  Nothing is lost: everything lives in tmux, the tab order in localStorage.
- `dtmux restart` works whatever the running daemon's code. It sends
  SIGUSR2, which asks for a soft restart; a daemon from before soft
  restarts dies of it instead, and one that does not hand over in 5 s is
  killed. Either way only the daemon goes, since tmux is its own process,
  and a fresh daemon attaches to it.
- The hand-over file is versioned. A newer daemon takes the sections it
  knows; one it cannot read is skipped, costing only Shift+Enter state.

Keep these working when changing dtmux: never let the page depend on
in-memory daemon state that is not in tmux, on disk, or in the hand-over.
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
- Right-click a tab for its menu. On a live tab, Disconnect saves the window
  (name, directory, id) and closes it, so it turns dotted in place; tapping
  it starts it again. Disconnecting the last window leaves the page showing
  the dotted tabs, with nothing running. On a dotted tab, Reopen starts it
  and Forget removes it for good.
- Coding agents come back where they were. When a window with Claude Code,
  Codex or the Cursor agent closes (Disconnect, Full restart, `dtmux kill`),
  dtmux first asks the agent to quit (Ctrl+C until it leaves) and catches
  the resume line it prints, then saves it with the window's directory and
  git branch. Tapping the dotted tab opens the window there, switches the
  checkout back to that branch if nothing can be hurt (no uncommitted
  changes, no other window in that checkout; otherwise it says why not),
  and types the resume command. Launch flags carry over, the
  no-questions-asked ones included (`--dangerously-skip-permissions`,
  `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `--force`, model,
  sandbox and approval modes): what the agent's own line leaves out is added
  from the command it was started with. The dotted tab's tooltip shows the
  exact command.
- Hovering a tab shows each pane's directory, how long it has been open, and
  what runs there, coding agents by name.
- While the daemon is away, the page reconnects by itself three times a second
  and shows the command that starts it again.
- When Claude, Codex or the Cursor agent prints its resume command, a bubble
  shows the command with the directory and git state; clicking it copies the
  command.
- State lives in `~/.dtmux/`: `dtmux.pid`, `dtmux.log`,
  `saved-windows.json`, and briefly `handover.json` during a soft restart.

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
