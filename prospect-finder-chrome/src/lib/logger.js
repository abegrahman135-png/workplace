const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let threshold = LEVELS.debug;

export function setLogLevel(level) {
  threshold = LEVELS[level] ?? LEVELS.debug;
}

function emit(level, mod, msg, data) {
  if (LEVELS[level] < threshold) return;
  const prefix = `[pf:${mod}] ${msg}`;
  const fn = level === 'error' ? console.error
           : level === 'warn'  ? console.warn
           : level === 'info'  ? console.info
           : console.debug;
  if (data === undefined) fn(prefix);
  else fn(prefix, data);
}

export const log = {
  debug: (m, s, d) => emit('debug', m, s, d),
  info:  (m, s, d) => emit('info',  m, s, d),
  warn:  (m, s, d) => emit('warn',  m, s, d),
  error: (m, s, d) => emit('error', m, s, d),
};
