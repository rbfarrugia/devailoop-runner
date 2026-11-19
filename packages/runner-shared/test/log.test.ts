import { describe, expect, it } from 'vitest';
import { createLogger, errorMessage, formatLogLine } from '../src/log';

function capture() {
  const lines: string[] = [];
  const sink = (level: string, line: string) => lines.push(`${level} ${line}`);
  return { lines, log: createLogger('worker', sink) };
}

describe('errorMessage', () => {
  it('reads the message of an Error and shows anything else as text', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
  });
});

describe('createLogger', () => {
  it('starts each line with the component and keeps the level', () => {
    const { lines, log } = capture();
    log.info('watching the queue');
    log.warn('slow');
    log.error('not starting');
    expect(lines).toEqual(['info worker: watching the queue', 'warn worker: slow', 'error worker: not starting']);
  });

  it('puts the error message on the first line and its stack frames after it', () => {
    const { lines, log } = capture();
    log.error('could not delete branch', new Error('no such ref'));
    const [first, ...frames] = lines[0]!.split('\n');
    expect(first).toBe('error worker: could not delete branch: no such ref');
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => frame.trimStart().startsWith('at '))).toBe(true);
  });

  it('shows a thrown value that is not an Error as text, without frames', () => {
    expect(formatLogLine('server', 'failed', 'denied')).toBe('server: failed: denied');
  });

  it('writes to the matching console method by default', () => {
    const calls: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = (line: string) => calls.push(`log ${line}`);
    console.warn = (line: string) => calls.push(`warn ${line}`);
    console.error = (line: string) => calls.push(`error ${line}`);
    try {
      const log = createLogger('runner');
      log.info('a');
      log.warn('b');
      log.error('c');
    } finally {
      Object.assign(console, original);
    }
    expect(calls).toEqual(['log runner: a', 'warn runner: b', 'error runner: c']);
  });
});
