import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, alert: 50 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, scope, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(fields && Object.keys(fields).length ? fields : {}),
  };
  const out = level === 'error' || level === 'alert' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

export function createLogger(scope) {
  return {
    debug: (msg, fields) => emit('debug', scope, msg, fields),
    info: (msg, fields) => emit('info', scope, msg, fields),
    warn: (msg, fields) => emit('warn', scope, msg, fields),
    error: (msg, fields) => emit('error', scope, msg, fields),
    alert: (msg, fields) => emit('alert', scope, msg, fields),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const logger = createLogger('botapprove');
