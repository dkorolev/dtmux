// Entry point: sets up the toolbar and starts the terminal mode.
//   /                  tmux control mode, session "dtmux" (server default)
//   /?session=NAME     tmux control mode, another session
//   /?mode=shell       a plain shell without tmux
import { startTmuxMode } from './tmux-mode.js';
import { startShellMode } from './shell-mode.js';
import { bindTabStripWheel } from './tmux-util.js';

const statusEl = document.getElementById('status');
const indicatorEl = document.getElementById('indicator');

// --- Toolbar extension point --------------------------------------------
// toolbar.addButton('Label', () => {...}) adds a control up top.
export const toolbar = {
  tabs: document.getElementById('tabs'),
  setStatus(text, cls = '') {
    statusEl.textContent = text;
    statusEl.className = `status ${cls}`;
  },
  setTitle(text) {
    statusEl.title = text;
  },
  isBad() {
    return statusEl.classList.contains('bad');
  },
  // Shows a short label, such as an armed tmux prefix; '' hides it.
  setIndicator(text) {
    indicatorEl.textContent = text;
    indicatorEl.hidden = !text;
  },
  addButton(label, onClick, { side = 'right', title } = {}) {
    const btn = document.createElement('button');
    btn.textContent = label;
    if (title) btn.title = title;
    btn.addEventListener('click', onClick);
    document.getElementById(`toolbar-${side}`).appendChild(btn);
    return btn;
  },
};

bindTabStripWheel(toolbar.tabs);

const params = new URLSearchParams(location.search);
const container = document.getElementById('terminal');
const start = params.get('mode') === 'shell' ? startShellMode : startTmuxMode;
window.app = start({ container, toolbar, params }); // handy for debugging
