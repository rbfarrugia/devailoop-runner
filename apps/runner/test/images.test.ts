import type { AddressInfo, Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { baseImageIdInContainer, pruneImagesInContainer } from '../src/client';
import { removeLeftoverCandidates } from '../src/images';
import { type Docker, createRunner, removeLeftoverContainers } from '../src/server';

const OWNER = 'devailoop_worker-data';
const tag = (n: number) => String(n).padStart(12, 'a');

/** Docker's images and containers as a list, which `image ls`, `ps`, `container inspect` and `image rm` work on as Docker would. */
function fakeDocker(input: {
  images: { id: string; ref: string | null; owner?: string }[];
  containers?: { id: string; image: string; owner?: string }[];
  base?: string | null;
}) {
  const images = [...input.images];
  const containers = input.containers ?? [];
  const execs: string[][] = [];
  const docker: Docker = {
    spawn() {
      throw new Error('nothing is started here');
    },
    async exec(args) {
      execs.push(args);
      if (args[0] === 'image' && args[1] === 'ls') {
        const stdout = images
          .map(({ id, ref }) => {
            const [repository, t] = ref ? ref.split(':') : ['<none>', '<none>'];
            return `${id}\t${repository}\t${t}\n`;
          })
          .join('');
        return { code: 0, stdout, stderr: '' };
      }
      // Like Docker, `ps` prints short ids unless told not to truncate; `container inspect` always prints full ones.
      if (args[0] === 'ps') {
        const full = args.includes('--no-trunc');
        return { code: 0, stdout: containers.map((c) => `${full ? c.id : c.id.slice(0, 12)}\n`).join(''), stderr: '' };
      }
      if (args[0] === 'container' && args[1] === 'inspect' && args.join(' ').includes('devailoop.owner')) {
        const ids = args.slice(4);
        return {
          code: 0,
          stdout: containers
            .filter((c) => ids.includes(c.id))
            .map((c) => `${c.id}\t${c.owner ?? ''}\n`)
            .join(''),
          stderr: '',
        };
      }
      if (args[0] === 'image' && args[1] === 'inspect' && args.join(' ').includes('devailoop.owner')) {
        const ids = args.slice(4);
        return {
          code: 0,
          stdout: images
            .filter((i) => ids.includes(i.id))
            .map((i) => `${i.id}\t${i.owner ?? ''}\n`)
            .join(''),
          stderr: '',
        };
      }
      if (args[0] === 'container' && args[1] === 'inspect') {
        const ids = args.slice(4);
        return {
          code: 0,
          stdout: containers
            .filter((c) => ids.includes(c.id))
            .map((c) => `${c.image}\n`)
            .join(''),
          stderr: '',
        };
      }
      if (args[0] === 'image' && args[1] === 'rm') {
        const name = args[2]!;
        expect(args).not.toContain('--force');
        const index = images.findIndex((image) => image.ref === name || (image.ref === null && image.id === name));
        if (index < 0) return { code: 1, stdout: '', stderr: `No such image: ${name}` };
        const { id } = images[index]!;
        const tags = images.filter((image) => image.id === id).length;
        if (tags === 1 && containers.some((c) => c.image === id))
          return { code: 1, stdout: '', stderr: 'conflict: image is being used' };
        images.splice(index, 1);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'image' && args[1] === 'inspect') {
        return input.base
          ? { code: 0, stdout: `${input.base}\n`, stderr: '' }
          : { code: 1, stdout: '', stderr: 'No such image' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  return { docker, images, execs };
}

let server: Server | undefined;
afterEach(() => server?.close());

async function listen(docker: Docker): Promise<string> {
  server = createRunner({ docker, image: 'devailoop-agent-base', dataVolume: OWNER, log: () => {} });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const names = (images: { ref: string | null; id: string }[]) => images.map((image) => image.ref ?? image.id).sort();

describe("cleaning up Projects' images", () => {
  it('keeps only the images listed for each Project, after several builds', async () => {
    const { docker, images } = fakeDocker({
      images: [1, 2, 3, 4]
        .map((n) => ({ id: `sha256:shop${n}`, ref: `devailoop-env-7:${tag(n)}` }))
        .concat([
          { id: 'sha256:blog1', ref: `devailoop-env-8:${tag(1)}` },
          { id: 'sha256:blog2', ref: `devailoop-env-8:${tag(2)}` },
        ]),
    });
    const reply = await pruneImagesInContainer(await listen(docker), {
      7: [`devailoop-env-7:${tag(4)}`, `devailoop-env-7:${tag(3)}`],
      8: [`devailoop-env-8:${tag(2)}`],
    });
    expect(reply.removed.sort()).toEqual([
      `devailoop-env-7:${tag(1)}`,
      `devailoop-env-7:${tag(2)}`,
      `devailoop-env-8:${tag(1)}`,
    ]);
    expect(names(images)).toEqual([
      `devailoop-env-7:${tag(3)}`,
      `devailoop-env-7:${tag(4)}`,
      `devailoop-env-8:${tag(2)}`,
    ]);
  });

  it('removes every image of a Project that is not listed, as when it was deleted', async () => {
    const { docker, images } = fakeDocker({
      images: [
        { id: 'sha256:gone1', ref: `devailoop-env-9:${tag(1)}` },
        { id: 'sha256:gone2', ref: `devailoop-env-9:${tag(2)}` },
        { id: 'sha256:shop1', ref: `devailoop-env-7:${tag(1)}` },
      ],
    });
    await pruneImagesInContainer(await listen(docker), { 7: [`devailoop-env-7:${tag(1)}`] });
    expect(names(images)).toEqual([`devailoop-env-7:${tag(1)}`]);
  });

  it('never keeps a name listed under another Project', async () => {
    const { docker, images } = fakeDocker({ images: [{ id: 'sha256:blog1', ref: `devailoop-env-8:${tag(1)}` }] });
    await pruneImagesInContainer(await listen(docker), { 7: [`devailoop-env-8:${tag(1)}`] });
    expect(images).toEqual([]);
  });

  it('never removes an image a session is using, tagged or not', async () => {
    const { docker, images, execs } = fakeDocker({
      images: [
        { id: 'sha256:old', ref: `devailoop-env-7:${tag(1)}` },
        { id: 'sha256:retagged', ref: null },
        { id: 'sha256:stale', ref: null },
        { id: 'sha256:new', ref: `devailoop-env-7:${tag(2)}` },
      ],
      containers: [
        { id: 'c1', image: 'sha256:old' },
        { id: 'c2', image: 'sha256:retagged' },
      ],
    });
    const reply = await pruneImagesInContainer(await listen(docker), { 7: [`devailoop-env-7:${tag(2)}`] });
    expect(reply.removed).toEqual(['sha256:stale']);
    expect(names(images)).toEqual([`devailoop-env-7:${tag(1)}`, `devailoop-env-7:${tag(2)}`, 'sha256:retagged']);
    // The runner looked only at its own containers.
    expect(execs).toContainEqual(['ps', '--all', '--quiet', '--filter', 'label=devailoop.session']);
  });

  it("leaves a build's candidate alone, which only the runner's start removes", async () => {
    const candidate = { id: 'sha256:cand', ref: 'devailoop-env-7:candidate-0123456789ab' };
    const { docker, images } = fakeDocker({ images: [candidate] });
    await pruneImagesInContainer(await listen(docker), {});
    expect(images).toEqual([candidate]);
    expect(await removeLeftoverCandidates(docker, OWNER)).toBe(1);
    expect(images).toEqual([]);
  });

  it('touches only images labelled as Environments, and only in its own repositories', async () => {
    const { docker, images, execs } = fakeDocker({ images: [{ id: 'sha256:x', ref: 'someone-else:latest' }] });
    await pruneImagesInContainer(await listen(docker), {});
    expect(images).toHaveLength(1);
    expect(execs.find((args) => args[1] === 'ls')).toContain('label=devailoop.environment');
  });

  it('refuses a keep list that does not name Projects by id', async () => {
    const { docker, images } = fakeDocker({ images: [{ id: 'sha256:shop1', ref: `devailoop-env-7:${tag(1)}` }] });
    const address = await listen(docker);
    await expect(pruneImagesInContainer(address, { SHOP: [] })).rejects.toThrow(/not a Project's id/);
    await expect(pruneImagesInContainer(address, [] as never)).rejects.toThrow(/per Project/);
    expect(images).toHaveLength(1);
  });
});

describe("another runner's things on a shared Docker host", () => {
  const other = 'other_worker-data';

  it("prunes only its own and owner-less images, never another owner's", async () => {
    const { docker, images } = fakeDocker({
      images: [
        { id: 'sha256:mine', ref: `devailoop-env-7:${tag(1)}`, owner: OWNER },
        { id: 'sha256:old', ref: `devailoop-env-7:${tag(2)}` },
        { id: 'sha256:theirs', ref: `devailoop-env-8:${tag(1)}`, owner: other },
        { id: 'sha256:theirs-untagged', ref: null, owner: other },
      ],
    });
    const reply = await pruneImagesInContainer(await listen(docker), {});
    expect(reply.removed.sort()).toEqual([`devailoop-env-7:${tag(1)}`, `devailoop-env-7:${tag(2)}`]);
    expect(names(images)).toEqual([`devailoop-env-8:${tag(1)}`, 'sha256:theirs-untagged']);
  });

  it('never removes an image any container uses, even its own owner-less one', async () => {
    const { docker, images } = fakeDocker({
      images: [{ id: 'sha256:old', ref: `devailoop-env-7:${tag(1)}` }],
      containers: [{ id: 'c1', image: 'sha256:old', owner: other }],
    });
    await pruneImagesInContainer(await listen(docker), {});
    expect(images).toHaveLength(1);
  });

  it('removes only its own and owner-less candidates at start', async () => {
    const { docker, images } = fakeDocker({
      images: [
        { id: 'sha256:c1', ref: 'devailoop-env-7:candidate-000000000001', owner: OWNER },
        { id: 'sha256:c2', ref: 'devailoop-env-7:candidate-000000000002' },
        { id: 'sha256:c3', ref: 'devailoop-env-8:candidate-000000000003', owner: other },
      ],
    });
    expect(await removeLeftoverCandidates(docker, OWNER)).toBe(2);
    expect(names(images)).toEqual(['devailoop-env-8:candidate-000000000003']);
  });

  it('removes only its own and owner-less containers at start', async () => {
    const { docker, execs } = fakeDocker({
      images: [],
      containers: [
        { id: `mine${'0'.repeat(60)}`, image: 'sha256:a', owner: OWNER },
        { id: `old0${'0'.repeat(60)}`, image: 'sha256:a' },
        { id: `theirs${'0'.repeat(59)}`, image: 'sha256:a', owner: other },
      ],
    });
    expect(await removeLeftoverContainers(docker, OWNER)).toBe(2);
    expect(execs).toContainEqual(['rm', '--force', `mine${'0'.repeat(60)}`, `old0${'0'.repeat(60)}`]);
  });
});

describe('the base image', () => {
  it("answers devailoop-agent-base's id, or null when it is not there", async () => {
    expect(await baseImageIdInContainer(await listen(fakeDocker({ images: [], base: 'sha256:base' }).docker))).toBe(
      'sha256:base',
    );
    server?.close();
    expect(await baseImageIdInContainer(await listen(fakeDocker({ images: [], base: null }).docker))).toBeNull();
  });
});
