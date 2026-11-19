import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { builderName, exportBase } from '../src/builder';
import type { Docker } from '../src/server';

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('the builder', () => {
  it('is named from the runner, so runners sharing a host keep their own', () => {
    expect(builderName('devailoop_worker-data')).toBe('devailoop-devailoop_worker-data');
    expect(builderName('a b/c')).toBe('devailoop-a_b_c');
  });
});

describe('exporting the base image', () => {
  let root: string;
  beforeEach(async () => (root = await mkdtemp(join(tmpdir(), 'devailoop-export-test-'))));
  afterEach(() => rm(root, { recursive: true, force: true }));

  const docker = (id: string | null, saves: string[]): Docker => ({
    spawn() {
      throw new Error('nothing is started here');
    },
    async exec(args) {
      if (args[0] === 'image')
        return id ? { code: 0, stdout: `${id}\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'No such image\n' };
      saves.push(args.join(' '));
      await writeFile(args[2]!, 'tar');
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  const layout = (digest: string | null) => async (_tar: string, dir: string) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.json'), JSON.stringify({ manifests: digest ? [{ digest }] : [] }));
  };

  it('saves it once for each id, pins its digest, and keeps only the newest', async () => {
    const saves: string[] = [];
    const first = await exportBase(docker('sha256:one', saves), 'devailoop-agent-base', root, layout(DIGEST));
    expect(first).toMatchObject({ id: 'sha256:one', digest: DIGEST, dir: join(root, 'sha256_one') });
    const again = await exportBase(
      docker('sha256:one', saves),
      'devailoop-agent-base',
      root,
      layout('sha256:' + 'b'.repeat(64)),
    );
    expect(again).toEqual(first);
    expect(saves).toHaveLength(1);

    await exportBase(docker('sha256:two', saves), 'devailoop-agent-base', root, layout(DIGEST));
    expect(saves).toHaveLength(2);
    expect(await readdir(root)).toEqual(['sha256_two']);
  });

  it('says why it cannot', async () => {
    expect(await exportBase(docker(null, []), 'devailoop-agent-base', root, layout(DIGEST))).toEqual({
      problem: 'devailoop-agent-base is not there, so nothing can be built on it.',
    });
    expect(await exportBase(docker('sha256:one', []), 'devailoop-agent-base', root, layout(null))).toEqual({
      problem: expect.stringContaining('not as an OCI layout'),
    });
    expect(await readdir(root)).toEqual([]);
  });
});
