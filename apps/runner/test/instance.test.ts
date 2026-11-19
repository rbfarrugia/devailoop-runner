import type { AddressInfo, Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { bindInstanceInContainer, buildImageInContainer } from '../src/client';
import { type Docker, createRunner } from '../src/server';

const MINE = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER = 'bbbbbbbb-1111-2222-3333-444444444444';

/** A Docker with one container and one image on it, each labelled with an instance (or none). */
function dockerWith(labels: { container?: string; image?: string }): Docker {
  return {
    spawn() {
      throw new Error('nothing is started here');
    },
    async exec(args) {
      const kind = args[0] === 'image' ? 'image' : 'container';
      if (args[0] === 'ps') return { code: 0, stdout: 'c1\n', stderr: '' };
      if (args[0] === 'image' && args[1] === 'ls') return { code: 0, stdout: 'i1\n', stderr: '' };
      if (args[1] === 'inspect') {
        const label = kind === 'image' ? labels.image : labels.container;
        return { code: 0, stdout: `${kind === 'image' ? 'i1' : 'c1'}\t${label ?? ''}\n`, stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
  };
}

let server: Server | undefined;
afterEach(() => server?.close());

async function listen(docker: Docker, port = 0): Promise<string> {
  server = createRunner({
    docker,
    image: 'devailoop-agent-base',
    dataVolume: 'vol',
    log: () => {},
    exportBase: async () => ({ id: 'sha256:abc', dir: '/export', digest: `sha256:${'d'.repeat(64)}` }),
  });
  await new Promise<void>((resolve) => server!.listen(port, '127.0.0.1', resolve));
  return `127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe('the instance a runner serves', () => {
  it('serves an instance on a host with nothing of another, or only what predates the label', async () => {
    expect(await bindInstanceInContainer(await listen(dockerWith({})), MINE)).toEqual({ ok: true });
  });

  it('serves its own instance again, and one that left only its own things', async () => {
    const address = await listen(dockerWith({ container: MINE, image: MINE }));
    expect(await bindInstanceInContainer(address, MINE)).toEqual({ ok: true });
    expect(await bindInstanceInContainer(address, MINE)).toEqual({ ok: true });
  });

  it("refuses when another instance's container is on the host", async () => {
    const reply = await bindInstanceInContainer(await listen(dockerWith({ container: OTHER })), MINE);
    expect(reply).toMatchObject({ ok: false, reason: expect.stringContaining(OTHER) });
  });

  it("refuses when another instance's Environment image is on the host", async () => {
    const reply = await bindInstanceInContainer(await listen(dockerWith({ image: OTHER })), MINE);
    expect(reply).toMatchObject({ ok: false });
  });

  it('refuses a second instance once it serves one', async () => {
    const address = await listen(dockerWith({}));
    await bindInstanceInContainer(address, MINE);
    expect(await bindInstanceInContainer(address, OTHER)).toMatchObject({ ok: false });
  });

  it('refuses an instance that is not named by an id', async () => {
    expect(await bindInstanceInContainer(await listen(dockerWith({})), 'x y')).toMatchObject({ ok: false });
  });
});

/** Stops the runner and starts another at the same address, which knows nothing of what the first was told. */
async function restart(docker: Docker, address: string) {
  await new Promise((resolve) => server!.close(resolve));
  await listen(docker, Number(address.split(':')[1]));
}

describe('a runner that restarted', () => {
  /** A Docker that records what it is asked to run. */
  function recording() {
    const runs: string[][] = [];
    const docker: Docker = {
      spawn: (args) => {
        runs.push(args);
        throw new Error('stop here');
      },
      async exec(args) {
        if (args[0] === 'ps' || (args[0] === 'image' && args[1] === 'ls')) return { code: 0, stdout: '', stderr: '' };
        if (args[0] === 'buildx' || args[0] === 'update') return { code: 0, stdout: '', stderr: '' };
        runs.push(args);
        return { code: 1, stdout: '', stderr: 'no' };
      },
    };
    return { docker, runs };
  }

  it('makes nothing for a worker that has not told it the instance', async () => {
    const { docker, runs } = recording();
    const address = await listen(docker);
    const reply = await buildImageInContainer(
      address,
      { projectId: 7, dockerfile: 'FROM devailoop-agent-base\n' },
      () => {},
    );
    expect(reply).toMatchObject({ built: false, reason: expect.stringContaining('does not know which') });
    expect(runs).toEqual([]);
  });

  it('learns the instance again from the next request, and labels what it builds', async () => {
    const { docker, runs } = recording();
    const address = await listen(docker);
    await bindInstanceInContainer(address, MINE);
    // A new runner process at the same address: it has forgotten, and the request carries the instance.
    await restart(docker, address);
    await buildImageInContainer(address, { projectId: 7, dockerfile: 'FROM devailoop-agent-base\n' }, () => {});
    expect(runs.flat()).toContain(`devailoop.instance=${MINE}`);
  });

  it('refuses a build when another instance has shown up on the host', async () => {
    const address = await listen(dockerWith({}));
    await bindInstanceInContainer(address, MINE);
    await restart(dockerWith({ image: OTHER }), address);
    const reply = await buildImageInContainer(
      address,
      { projectId: 7, dockerfile: 'FROM devailoop-agent-base\n' },
      () => {},
    );
    expect(reply).toMatchObject({ built: false, reason: expect.stringContaining(OTHER) });
  });
});
