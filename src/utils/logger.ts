const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogSource = "engine" | "bubble";
export type LogFields = Record<string, unknown>;

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
  errors?: unknown[];
}

export interface Logger {
  readonly fields: LogFields;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  with(fields: LogFields): Logger;
}

const configuredPriority = LOG_LEVELS.indexOf(
  Bun.env.LOG_LEVEL?.toUpperCase() as LogLevel,
);
const minPriority =
  configuredPriority === -1 ? LOG_LEVELS.indexOf("INFO") : configuredPriority;
const writeStderr = process.stderr.write.bind(process.stderr);

export const serializeError = (value: unknown): unknown => {
  if (!(value instanceof Error)) {
    return value;
  }
  const { name, message, stack, cause } = value;
  const serialized: SerializedError = { name, message, stack };
  if (cause !== undefined) {
    serialized.cause = serializeError(cause);
  }
  if (value instanceof AggregateError) {
    serialized.errors = value.errors.map(serializeError);
  }
  return serialized;
};

const serializeFields = (fields: LogFields): LogFields =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, serializeError(value)]),
  );

export const createLogger = (
  source: LogSource,
  baseFields: LogFields = {},
): Logger => {
  const write = (level: LogLevel, msg: string, fields: LogFields = {}) => {
    if (LOG_LEVELS.indexOf(level) < minPriority) {
      return;
    }
    const header = { time: new Date().toISOString(), level, msg, source };
    const line = (() => {
      try {
        return JSON.stringify({
          ...header,
          ...serializeFields(baseFields),
          ...serializeFields(fields),
        });
      } catch (err) {
        return JSON.stringify({
          ...header,
          logError: `Failed to serialize fields: ${err}`,
        });
      }
    })();
    writeStderr(`${line}\n`);
  };

  return {
    fields: baseFields,
    debug: (msg, fields) => write("DEBUG", msg, fields),
    info: (msg, fields) => write("INFO", msg, fields),
    warn: (msg, fields) => write("WARN", msg, fields),
    error: (msg, fields) => write("ERROR", msg, fields),
    with: (fields) => createLogger(source, { ...baseFields, ...fields }),
  };
};
