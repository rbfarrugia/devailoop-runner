import { describe, expect, it } from 'vitest';
import { Frame, FrameReader, connectionOptions, encodeFrame } from '../src/protocol';

describe('frames', () => {
  it('come back whole however the bytes were split', () => {
    const bytes = Buffer.concat([
      encodeFrame(Frame.stdout, 'hello'),
      encodeFrame(Frame.stdinEnd),
      encodeFrame(Frame.stderr, 'é'),
    ]);
    const frames: [number, string][] = [];
    const reader = new FrameReader((type, payload) => frames.push([type, payload.toString('utf8')]));
    for (let i = 0; i < bytes.length; i++) reader.push(bytes.subarray(i, i + 1));
    expect(frames).toEqual([
      [Frame.stdout, 'hello'],
      [Frame.stdinEnd, ''],
      [Frame.stderr, 'é'],
    ]);
  });

  it('that claim to be enormous are refused', () => {
    const header = Buffer.alloc(5);
    header.writeUInt8(Frame.stdin, 0);
    header.writeUInt32BE(0xffffffff, 1);
    expect(() => new FrameReader(() => {}).push(header)).toThrow('too big');
  });
});

describe("the runner's address", () => {
  it('is host:port or a socket path', () => {
    expect(connectionOptions('runner:7070')).toEqual({ host: 'runner', port: 7070 });
    expect(connectionOptions('/run/devailoop/runner.sock')).toEqual({ path: '/run/devailoop/runner.sock' });
    expect(() => connectionOptions('runner')).toThrow('host:port');
  });
});
