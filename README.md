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

## Remote sessions

A tab can live on a remote machine instead of this one. Right-click (or
long-press) `+` for a new tab on one of the remotes in `~/.dtmux.yaml`; its
tabs wear its color. Nothing about a remote is built in: how to reach its
controller, the key and the machine's lifetime are all in the config. Two
kinds so far (see `server/remote-kinds.js`):

```yaml
remotes:
  lunanode:                     # the name tabs remember: [a-z0-9-]
    kind: lunanode-ctl          # a VM per tab, made by lunanode-ctl
    controller: [ssh, lunanode, lunanode-ctl]   # required: how to run the controller
    seed: ~/.ssh/lunanode.seed  # required: caller seed, fed on stdin, never in arguments
    plan: m.1s                  # optional: create --plan
    image: Ubuntu 24.04         # optional: create --image
    ipv4: false                 # optional: create --ipv4 (else IPv6 only)
    ttlSeconds: 86400           # optional: the VM is deleted this long after it is made
    hostPrefix: dtmux           # optional: new VMs are <hostPrefix>-<8 hex>
    user: ubuntu                # optional: ssh login
  hetzner:
    kind: devbox-ctl            # an account per tab on one host, made by devbox-ctl
    controller: [ssh, devbox, devbox-ctl]
    address: your.hetzner.dns.name       # required: where to ssh into an account
  # every kind, optional:
  #   label: LunaNode           # shown on the page (default: the name)
  #   color: "#c58af9"          # tab tint (default: purple for LunaNode, orange for devbox)
  #   identity: ~/.ssh/id_ed25519   # ssh -i
  #   jump: lunanode            # ssh through this host, e.g. to reach IPv6
  #   attach: …                 # what ssh runs there (default: the machine's tmux)
```

`remotes` is read on every use, so edits count without a restart.

- **A new tab makes a new machine.** LunaNode VMs cost money, so they are
  confirmed first. The tab's terminal shows the progress, then lands on the
  machine. A LunaNode create is managed (run id `dtmux-<host>`), so a dropped
  connection to the controller, or a restart in the middle, waits for that
  same operation rather than making a second VM. A devbox account
  (`devbox-user-NNNNNN`) takes seconds and is free. Every controller call is
  short and has a time limit, so a connection that dies silently is noticed
  and retried.
- **The shells run in the machine's own tmux** (session `dtmux`, status line
  off, mouse on; installed with apt if missing). The ssh connection can go
  away (the laptop sleeps or reboots, dtmux restarts, you Disconnect the
  tab) and everything there keeps running.
- **Rejoining is quick.** A tab remembers its machine's address, so
  reopening it goes straight to ssh; the controller is asked only when that
  address does not answer. ssh connections are shared and kept open for
  hours (ControlMaster), so rejoining reuses one instead of logging in again:
  under a second where a fresh login takes several.
- **Lifetimes.** LunaNode VMs are deleted `ttlSeconds` after they are made.
  devbox accounts are deleted after 24 hours with no change in their home,
  so a connected tab touches `~/.dtmux-alive` there every 30 minutes. A tab
  whose machine is gone says so and offers to make a new one.
- **Closing for good.** Right-click a tab: **Close** ends it with no dotted
  tab (it works on a stuck tab, from outside); **Delete the VM / account…**
  asks, then deletes the machine and closes the tab. Dotted remote tabs have
  Delete too.
- **When the session there ends** (its last shell exits, or its tmux is
  detached), the tab stays, since the machine still runs: it shows
  **Reconnect**, **Delete the VM… / account…** and **Close tab** (the
  terminal takes Enter, `d` and Ctrl+C for the same). The page hears of it
  at once through a tmux format subscription on the window option
  `@dtmux_remote_state`.
- **Uptime.** A tab's tooltip counts from when its machine was ready, not
  from when the tab opened.
- Host keys go to `~/.dtmux/known_hosts`, not your own: VM addresses are
  reused, and a new VM's old entry is dropped when it is made.

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
- **Reboots and crashes.** Every 30 s the daemon writes down what is open
  (`~/.dtmux/live-windows.json`: windows, directories, branches, remote VMs,
  and each coding agent's resume command from its command line). A stop that
  cannot list the windows itself (at a reboot tmux may be gone first) saves
  them from there, and a start after a crash or power loss recovers them
  from there. Either way they come back as dotted tabs. Programs and
  scrollback on this machine do not survive a reboot; remote tabs do, since
  their shells run in the VM's tmux.
- **Starting at login, stopping before logout** (macOS): `sh macos/install.sh`
  installs two LaunchAgents. `com.dima.dtmux` runs `dtmux start` once at
  login. `com.dima.dtmux.guard` runs DtmuxGuard.app (`macos/DtmuxGuard.swift`),
  an invisible app that macOS asks to quit before a logout, restart or
  shutdown. It holds that until `dtmux kill` has stopped gently (coding
  agents closed with Ctrl+C and their exact resume commands written down,
  windows saved), at most 25 s, so nothing is left to the moment when every
  process gets SIGTERM at once. If the logout is then cancelled, it starts
  dtmux again a minute later.

## Popups

A popup about a tab (the resume command an agent printed as it left, the
branch a reopened tab was put back on) shows on that tab only, and goes
away when you switch tabs. Popups about dtmux itself show whatever the tab.

## Text selection

The toggle left of `dtmux` switches how a drag in a terminal works.
**Smart**: programs that ask for the mouse (tmux, vim, coding agents) get the
clicks and drags. **Plain**: the page selects the text itself, instantly, for
Cmd+C, whatever the program wants; the wheel still goes to the program. In
plain mode Ctrl+C copies too while text is selected (and interrupts, as ever,
when nothing is). Plain
is the one for remote tabs, where the VM's tmux would otherwise do the
selecting, a round trip away. Option+drag selects text in either mode.

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
