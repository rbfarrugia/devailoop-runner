/** What an error says, for a log line or message: its message, or the thrown value as text. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Writes entries for one component; each method looks `console` up when called. */
export interface Logger {
  info(message: string, error?: unknown): void;
  warn(message: string, error?: unknown): void;
  error(message: string, error?: unknown): void;
}

type Level = keyof Logger;

/** Where a line goes; the default is the matching `console` method. */
export type LogSink = (level: Level, line: string) => void;

function consoleSink(level: Level, line: string): void {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** The text of one entry: `component: message`, then `: <error message>` and the stack frames of an Error. */
export function formatLogLine(component: string, message: string, error?: unknown): string {
  const head = `${component}: ${message}`;
  if (error === undefined) return head;
  const line = `${head}: ${errorMessage(error)}`;
  if (!(error instanceof Error) || !error.stack) return line;
  const frames = error.stack.split('\n').filter((row) => row.trimStart().startsWith('at '));
  return frames.length > 0 ? `${line}\n${frames.join('\n')}` : line;
}

/**
 * A logger whose lines all start with the component's name, so logs can be searched and filtered.
 * Pass the caught error as the second argument rather than putting it in the message: every error is then
 * formatted the same way, with its stack. Do not log secrets, tokens or request bodies.
 */
export function createLogger(component: string, sink: LogSink = consoleSink): Logger {
  const write = (level: Level) => (message: string, error?: unknown) =>
    sink(level, formatLogLine(component, message, error));
  return { info: write('info'), warn: write('warn'), error: write('error') };
}
