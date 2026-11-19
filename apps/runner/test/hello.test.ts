import { type AddressInfo, type Server, createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { helloInContainer } from '../src/client';
import { Frame, RUNNER_PROTOCOL_VERSION, encodeFrame } from '../src/protocol';
import { type Docker, createRunner } from '../src/server';

let server: Server | undefined;
afterEach(() => {
  server?.close();
  delete process.env.DEVAILOOP_VERSION;
});

const docker: Docker = {
  spawn() {
    throw new Error('nothing is started here');
  },
  async exec() {
    return { code: 1, stdout: '', stderr: 'unexpected' };
  },
};

async function listen(make: () => Server): Promise<string> {
  server = make();
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe('hello', () => {
  it('is answered with the protocol version and the image’s published version', async () => {
    process.env.DEVAILOOP_VERSION = '0.2.0';
    const address = await listen(() =>
      createRunner({
        docker,
        image: 'base',
        dataVolume: 'vol',
        log: () => {},
        exportBase: async () => ({ id: 'x', dir: '/', digest: 'sha256:x' }),
      }),
    );
    expect(await helloInContainer(address)).toEqual({
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      runnerVersion: '0.2.0',
    });
  });

  it('is told as dev when the image carries no version', async () => {
    delete process.env.DEVAILOOP_VERSION;
    const address = await listen(() =>
      createRunner({
        docker,
        image: 'base',
        dataVolume: 'vol',
        log: () => {},
        exportBase: async () => ({ id: 'x', dir: '/', digest: 'sha256:x' }),
      }),
    );
    expect(await helloInContainer(address)).toMatchObject({ runnerVersion: 'dev' });
  });

  it('is unsupported by a runner that predates it, which refuses any request it does not know', async () => {
    const address = await listen(() =>
      createServer((socket) => {
        socket.on('data', () =>
          socket.end(encodeFrame(Frame.error, JSON.stringify({ message: 'the runner does not do that' }))),
        );
      }),
    );
    expect(await helloInContainer(address)).toEqual({ unsupported: true });
  });

  it('is unreachable when nothing listens', async () => {
    const address = await listen(() => createServer());
    server!.close();
    expect(await helloInContainer(address)).toMatchObject({ unreachable: true });
  });
});
