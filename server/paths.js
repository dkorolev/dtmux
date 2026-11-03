// Where dtmux keeps its runtime state: the pid file and the daemon log.
import os from 'node:os';
import path from 'node:path';

export const STATE_DIR = process.env.DTMUX_STATE_DIR || path.join(os.homedir(), '.dtmux');
export const PID_FILE = path.join(STATE_DIR, 'dtmux.pid');
export const LOG_FILE = path.join(STATE_DIR, 'dtmux.log');
