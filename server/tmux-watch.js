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

// Why an input was refused, in plain text that reads well and can be pasted
// elsewhere as is: what was entered, what is wrong, what is accepted.
export function watchInputProblem(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  const remote = /^ssh(?:\s+-t{1,2})*\s+(?:--\s+)?\S+\s+(.+)$/.exec(text)?.[1];
  const inner = remote === undefined ? '' : unquote(remote.trim()).trim();
  let why;
  if (!text) why = 'Nothing was entered.';
  else if (text.length > 1024 || /[\r\n]/.test(text)) why = 'The input must be one line of at most 1024 characters.';
  else if (/^ssh(?:\s|$)/.test(text) && remote === undefined)
    why = 'The SSH command has no remote part. dtmux needs the tmux session to attach to.';
  else if (remote !== undefined && !/^tmux\s+(?:attach(?:-session)?|a)\b/.test(inner))
    why = 'dtmux only watches an existing tmux session, read-only. It does not run other remote commands, such as scripts.';
  else if (remote !== undefined)
    why =
      'The tmux attach is not one dtmux accepts. Its flags may only be -t SESSION, -r, -E and -f read-only,ignore-size; nothing may follow it (no ;, &&, $(...)); the session name may use only letters, digits, "_" and "-".';
  else why = 'This is neither an SSH command nor host/session. The session name may use only letters, digits, "_" and "-".';
  // Written so that pasting it to a coding agent gets back a command dtmux takes.
  return [
    'dtmux (a tmux web UI) can watch a remote tmux session read-only over SSH, but it refused this input:',
    '',
    `  ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`,
    '',
    `Why: ${why}`,
    '',
    'To use SSH tmux watching via dtmux, please provide a single-line command in exactly this form:',
    '',
    "  ssh -t HOST 'tmux attach -r -t SESSION'",
    '',
    'where HOST is the SSH host (non-interactive SSH must work) and SESSION is an existing tmux session on it (letters, digits, _ and - only).',
    'HOST/SESSION or "HOST SESSION" also work. dtmux does not run any other remote command.',
    '',
    'If the input above runs a script or another command, first start it in a new detached tmux session on HOST, e.g.:',
    '',
    "  ssh HOST \"tmux new-session -d -s SESSION '<the command>'\"",
    '',
    'then reply with the ssh ... tmux attach -r -t SESSION command to paste into dtmux.',
  ].join('\n');
}
