/**
 * Structured JSON logging.
 *
 * One line of JSON per event so logs stay greppable and machine-parseable.
 * Every request gets an id that also surfaces on the user-facing error page,
 * which is what makes a vague "something went wrong" report actionable.
 */
import { config, LOG_LEVELS, type LogLevel } from './config.ts';

export type LogFields = Record<string, unknown>;

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Field names whose values must never reach the log, regardless of caller.
 * Belt-and-braces: call sites are careful, but a redaction pass means a
 * careless `log.info('...', user)` can't leak a password hash.
 */
const REDACTED_KEYS = new Set([
  'password',
  'newpassword',
  'password_hash',
  'passwordhash',
  'token',
  'csrf',
  'csrf_token',
  'csrftoken',
  'session',
  'sessionid',
  'session_id',
  'cookie',
  'authorization',
  'secret',
  // The normalisation below strips `-` and `_`, so `SERPAPI_KEY` arrives here as
  // `serpapikey` and `apikey` alone would not catch it. `key` is deliberately
  // broad: nothing in this app logs a field called `key` that is worth reading.
  'key',
  'apikey',
  'serpapikey',
]);

function redact(fields: LogFields): LogFields {
  const safe: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED_KEYS.has(key.toLowerCase().replace(/[-_]/g, ''))) {
      safe[key] = '[redacted]';
    } else if (value instanceof Error) {
      safe[key] = { name: value.name, message: value.message, stack: value.stack };
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that stamps `bound` onto every subsequent event. */
  child(bound: LogFields): Logger;
}

function emit(level: LogLevel, bound: LogFields, message: string, fields?: LogFields): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[config.logLevel]) return;

  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...redact({ ...bound, ...fields }),
  };

  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

function makeLogger(bound: LogFields): Logger {
  return {
    debug: (message, fields) => emit('debug', bound, message, fields),
    info: (message, fields) => emit('info', bound, message, fields),
    warn: (message, fields) => emit('warn', bound, message, fields),
    error: (message, fields) => emit('error', bound, message, fields),
    child: (extra) => makeLogger({ ...bound, ...extra }),
  };
}

export const log = makeLogger({});

export { LOG_LEVELS };
export type { LogLevel };
