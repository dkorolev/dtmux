// Plain-shell mode (?mode=shell): one terminal attached to a shell in a PTY.
import { FitAddon } from '/vendor/addon-fit.mjs';
import { WebglAddon } from '/vendor/addon-webgl.mjs';
import { createTerminal, socketUrl } from './terminal-common.js';
import { attachImagePaste, fileToMessage, flashPastedImage } from './paste-image.js';

export function startShellMode({ container, toolbar, params }) {
  let ws = null;
  const send = (msg) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const openExternal = (url) => send({ t: 'open', url });

  const term = createTerminal({ openExternal });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  attachImagePaste(container, async (file) => {
    flashPastedImage(container, file);
    const msg = await fileToMessage(file).catch(() => null);
    if (msg) send(msg);
  });

  // ?renderer=dom forces the DOM renderer (for debugging rendering issues).
  let renderer = 'dom';
  if (params.get('renderer') !== 'dom') {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        renderer = 'dom (webgl context lost)';
        updateTitle();
      });
      term.loadAddon(webgl);
      renderer = 'webgl';
    } catch (e) {
      console.warn('WebGL renderer unavailable, using DOM renderer', e);
      renderer = 'dom (webgl unavailable)';
    }
  }
  // Hover the status label to see renderer and grid size.
  const commit = document.getElementById('status').dataset.commit;
  const updateTitle = () =>
    toolbar.setTitle(
      `plain shell · renderer: ${renderer} · ${term.cols}×${term.rows}${commit ? ` · ${commit}` : ''}`,
    );
  term.onResize(updateTitle);
  fit.fit();
  updateTitle();
  term.focus();

  function connect() {
    ws = new WebSocket(socketUrl({ mode: 'shell', cols: term.cols, rows: term.rows }));
    ws.onopen = () => toolbar.setStatus('connected', 'ok');
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'out') term.write(msg.d);
      else if (msg.t === 'paste-path' && msg.path) term.paste(msg.path);
      else if (msg.t === 'exit') {
        toolbar.setStatus(`shell exited (${msg.code})`, 'bad');
        term.write(`\r\n\x1b[90m[process exited with code ${msg.code}]\x1b[0m\r\n`);
      }
    };
    ws.onclose = () => {
      if (!toolbar.isBad()) toolbar.setStatus('disconnected', 'bad');
    };
    ws.onerror = () => toolbar.setStatus('error', 'bad');
  }

  term.onData((d) => send({ t: 'in', d }));
  term.onResize(({ cols, rows }) => send({ t: 'resize', cols, rows }));
  new ResizeObserver(() => fit.fit()).observe(container);

  toolbar.addButton(
    'New shell',
    () => {
      if (ws) ws.close();
      term.reset();
      toolbar.setStatus('connecting…');
      connect();
      term.focus();
    },
    { title: 'Kill the current shell and start a new one' },
  );

  connect();
  return { term };
}
