type LogLevel = "off" | "error" | "warn" | "info" | "debug";

const LOG_RANKS: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const ANSI_RESET = "\x1b[0m";
const LEVEL_COLORS: Record<LogLevel, string> = {
  off: "",
  debug: "\x1b[38;5;245m", // gray
  info: "",
  warn: "\x1b[38;5;214m", // orange
  error: "\x1b[38;5;196m", // red
};

export interface Logger {
  debug(format: string, ...args: unknown[]);
  info(format: string, ...args: unknown[]);
  warn(format: string, ...args: unknown[]);
  error(format: string, ...args: unknown[]);
}

function shouldLog(messageLevel: LogLevel, loggerLevel: LogLevel) {
  if (!Object.hasOwn(LOG_RANKS, messageLevel)) {
    throw new Error(`Invalid log level: ${String(messageLevel)}`);
  }
  if (!Object.hasOwn(LOG_RANKS, loggerLevel)) {
    throw new Error(`Invalid logger level: ${String(loggerLevel)}`);
  }

  return LOG_RANKS[messageLevel] <= LOG_RANKS[loggerLevel];
}

function noop(format: string, ...args: unknown[]) {}

function makeColoredMethod(
  fn: (...args: unknown[]) => void,
  level: LogLevel,
  useColor: boolean,
): (format: string, ...args: unknown[]) => void {
  if (!useColor) return fn.bind(console);
  return (format: string, ...args: unknown[]) =>
    fn(`${LEVEL_COLORS[level]}[${level}] ${format}${ANSI_RESET}`, ...args);
}

export function getConsoleLogger(loggerLevel: LogLevel, useColor = false): Logger {
  return {
    debug: shouldLog("debug", loggerLevel)
      ? makeColoredMethod(console.debug, "debug", useColor)
      : noop,
    info: shouldLog("info", loggerLevel) ? makeColoredMethod(console.info, "info", useColor) : noop,
    warn: shouldLog("warn", loggerLevel) ? makeColoredMethod(console.warn, "warn", useColor) : noop,
    error: shouldLog("error", loggerLevel)
      ? makeColoredMethod(console.error, "error", useColor)
      : noop,
  };
}

export function getDefaultLogger(): Logger {
  const level = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  if (!Object.hasOwn(LOG_RANKS, level)) {
    throw new Error(`Unknown log level in LOG_LEVEL env var: ${level}`);
  }
  const useColor = process.stderr.isTTY === true && !process.env.NO_COLOR;
  return getConsoleLogger(level as LogLevel, useColor);
}
