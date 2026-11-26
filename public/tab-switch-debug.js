// Timings are local to the browser. The request ID matches the daemon's trace.
export function tabSwitchDebug(verbose) {
  const prefix = '[dtmux tab switch]';
  let current;

  function details(trace) {
    const ws = trace.socket;
    return {
      ...trace.details,
      elapsedMs: Math.round(performance.now() - trace.started),
      socketState: ws.readyState,
      socketBufferedBytes: ws.bufferedAmount,
      visibility: document.visibilityState,
    };
  }

  function warn(trace) {
    if (trace.warned) return;
    trace.warned = true;
    console.warn(prefix, 'still pending', details(trace));
  }

  function finish(outcome, extra = {}) {
    if (!current) return;
    const trace = current;
    current = null;
    clearTimeout(trace.slowTimer);
    clearTimeout(trace.expiryTimer);
    if (outcome === 'applied' && performance.now() - trace.started >= 500) warn(trace);
    if (outcome === 'timeout' || outcome === 'failed') console.warn(prefix, outcome, { ...details(trace), ...extra });
    else if (trace.warned) console.info(prefix, outcome, { ...details(trace), ...extra });
    else if (verbose) console.debug(prefix, outcome, { ...details(trace), ...extra });
  }

  return {
    event(stage, info) {
      if (verbose) console.debug(prefix, stage, info);
    },
    skipped(info) {
      console.warn(prefix, 'click skipped', info);
    },
    start(socket, window, previous, source) {
      finish('superseded');
      const id = crypto.randomUUID();
      const trace = {
        socket,
        started: performance.now(),
        details: { id, window, previous, source, stage: 'sent', queuedBytesAtSend: socket.bufferedAmount },
      };
      current = trace;
      if (verbose) console.debug(prefix, 'sent', details(trace));
      trace.slowTimer = setTimeout(() => warn(trace), 500);
      trace.expiryTimer = setTimeout(() => finish('timeout'), 10_000);
      return { id, verbose };
    },
    progress(message) {
      if (message.id !== current?.details.id) return;
      Object.assign(current.details, { stage: message.stage, daemon: message });
      if (message.error) finish('failed');
      else if (verbose) console.debug(prefix, message.stage, details(current));
    },
    applied(diagnostic, active, receivedAt) {
      if (!current) return;
      if (active === current.details.window && current.details.firstActiveMs === undefined) {
        current.details.firstActiveMs = Math.round(performance.now() - current.started);
      }
      if (diagnostic?.id !== current.details.id) return;
      finish(active === current.details.window ? 'applied' : 'failed', {
        active,
        stateApplyMs: Math.round(performance.now() - receivedAt),
        daemon: diagnostic,
      });
    },
    disconnected() {
      finish('disconnected');
    },
  };
}
