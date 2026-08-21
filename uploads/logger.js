export const LOG_LEVEL = typeof chrome !== 'undefined' ? 'debug' : 'info';

const LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

function shouldLog(level) {
  const currentLevel = LEVELS[LOG_LEVEL] ?? LEVELS.debug;
  return LEVELS[level] >= currentLevel;
}

export function log(level, module, message, data = {}) {
  if (!shouldLog(level)) return;
  const prefix = `[${level.toUpperCase()}][${module}] ${message}`;
  
  if (Object.keys(data).length > 0) {
    if (level === 'error') console.error(prefix, data);
    else if (level === 'warn') console.warn(prefix, data);
    else if (level === 'info') console.info(prefix, data);
    else console.debug(prefix, data);
  } else {
    if (level === 'error') console.error(prefix);
    else if (level === 'warn') console.warn(prefix);
    else if (level === 'info') console.info(prefix);
    else console.debug(prefix);
  }
}

export function debug(module, msg, data = {}) { log('debug', module, msg, data); }
export function info(module, msg, data = {}) { log('info', module, msg, data); }
export function warn(module, msg, data = {}) { log('warn', module, msg, data); }
export function error(module, msg, data = {}) { log('error', module, msg, data); }
