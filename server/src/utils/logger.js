function write(level, event, context = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...context
  };
  const output = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  output(JSON.stringify(entry));
}

export const logger = {
  info: (event, context) => write("info", event, context),
  warn: (event, context) => write("warn", event, context),
  error: (event, context) => write("error", event, context)
};
