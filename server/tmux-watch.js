// Custom SSH destinations are separate from dtmux-managed machines.
export const WATCH_OPTION = '@dtmux_watch';
export const WATCH_FORMAT = `#{${WATCH_OPTION}}`;

export function watchTarget(host, session) {
  if (typeof host !== 'string' || host.length > 253 || !/^(?:[\w][\w.-]*@)?[a-z0-9][a-z0-9_.-]*$/i.test(host)) return null;
  if (typeof session !== 'string' || !/^[\w-]{1,128}$/.test(session)) return null;
  return { host, session };
}

export const watchValue = ({ host, session }) => `${host}/${session}`;

export function parseWatch(value) {
  const [host, session, extra] = String(value ?? '').split('/');
  return extra === undefined ? watchTarget(host, session) : null;
}

// Accept a target or the conventional SSH command used to attach to tmux.
// The pasted command is parsed as data. Only the validated target is kept.
const unquote = (word) => word.replace(/^(['"])(.*)\1$/, '$2');

export function parseWatchInput(input) {
  if (typeof input !== 'string' || input.length > 1024 || /[\r\n]/.test(input)) return null;
  const text = input.trim();
  const direct = parseWatch(text);
  if (direct) return direct;

  const ssh = /^ssh(?:\s+-t{1,2})*\s+(?:--\s+)?(\S+)\s+(.+)$/.exec(text);
  if (!ssh) {
    const pair = /^(\S+)\s+(\S+)$/.exec(text);
    return pair ? watchTarget(pair[1], pair[2]) : null;
  }

  const attach = /^tmux\s+(?:attach(?:-session)?|a)\s+(.+)$/.exec(unquote(ssh[2]).trim());
  if (!attach) return null;

  const args = attach[1].trim().split(/\s+/);
  let session;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '-r' || flag === '-E') continue;
    if (flag === '-f' && /^(?:read-only|ignore-size)(?:,(?:read-only|ignore-size))?$/.test(args[i + 1])) {
      i++;
      continue;
    }
    if ((flag === '-t' || flag === '-rt') && session === undefined && args[i + 1]) {
      session = unquote(args[++i]).replace(/^=/, '');
      continue;
    }
    return null;
  }
  return watchTarget(unquote(ssh[1]), session);
}

export function watchCommand({ host, session }) {
  // SSH escape commands are disabled. tmux's observer also ignores terminal size.
  const attach = `tmux attach-session -E -f read-only,ignore-size -t "=${session}"`;
  return `exec ssh -tt -e none -o BatchMode=yes -o ClearAllForwardings=yes -o ForwardAgent=no -o ForwardX11=no -- ${host} '${attach}'`;
}
