import { describe, expect, it } from 'vitest';
import { findDataVolume } from '../src/data-volume';
import type { Docker } from '../src/server';

type Answer = { code: number; stdout?: string; stderr?: string };

/** A Docker that answers each command by the first rule its arguments match. */
function fakeDocker(rules: [match: (args: string[]) => boolean, answer: Answer][]) {
  const execs: string[][] = [];
  const docker: Docker = {
    spawn: () => {
      throw new Error('not used');
    },
    async exec(args) {
      execs.push(args);
      const answer = rules.find(([match]) => match(args))?.[1] ?? { code: 0 };
      return { code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
    },
  };
  return { docker, execs };
}

const selfInspect = (args: string[]) => args[0] === 'inspect' && args.at(-1) === 'abc123';
const volumeLs = (args: string[]) => args[0] === 'volume' && args[1] === 'ls';
const volumeInspect = (args: string[]) => args[0] === 'volume' && args[1] === 'inspect';
const workerPs = (args: string[]) => args[0] === 'ps';
const workerInspect = (args: string[]) => args[0] === 'inspect' && args.at(-1) === 'w1';
const missing: Answer = { code: 1, stderr: 'Error response from daemon: get nope: no such volume\n' };

describe("the worker's data volume", () => {
  it('is the one given, once it is found to exist', async () => {
    const { docker, execs } = fakeDocker([]);
    expect(await findDataVolume(docker, { given: 'mine_worker-data', self: 'abc123' })).toEqual({
      volume: 'mine_worker-data',
    });
    expect(execs).toEqual([['volume', 'inspect', '--format', '{{.Name}}', 'mine_worker-data']]);
  });

  it('is refused, clearly, when the one given does not exist', async () => {
    const { docker } = fakeDocker([[volumeInspect, missing]]);
    const found = await findDataVolume(docker, { given: 'nope', self: 'abc123' });
    expect(found).toEqual({
      problem: expect.stringContaining('The worker\'s data volume "nope" does not exist: Error response from daemon'),
    });
  });

  it("is the worker-data volume of the runner's own Compose project, whatever the project is called", async () => {
    const { docker, execs } = fakeDocker([
      [selfInspect, { code: 0, stdout: 'my-folder\n' }],
      [volumeLs, { code: 0, stdout: 'my-folder_worker-data\n' }],
    ]);
    expect(await findDataVolume(docker, { given: '', self: 'abc123' })).toEqual({ volume: 'my-folder_worker-data' });
    expect(execs.find(volumeLs)).toEqual(
      expect.arrayContaining([
        'label=com.docker.compose.project=my-folder',
        'label=com.docker.compose.volume=worker-data',
      ]),
    );
    expect(execs.at(-1)).toEqual(['volume', 'inspect', '--format', '{{.Name}}', 'my-folder_worker-data']);
  });

  it("is otherwise the volume the project's worker has at /data", async () => {
    const { docker } = fakeDocker([
      [selfInspect, { code: 0, stdout: 'devailoop\n' }],
      [volumeLs, { code: 0, stdout: '' }],
      [workerPs, { code: 0, stdout: 'w1\n' }],
      [workerInspect, { code: 0, stdout: 'volume shared-data\n' }],
    ]);
    expect(await findDataVolume(docker, { self: 'abc123' })).toEqual({ volume: 'shared-data' });
  });

  it('is not taken from a worker that has a folder of the host at /data', async () => {
    const { docker } = fakeDocker([
      [selfInspect, { code: 0, stdout: 'devailoop\n' }],
      [volumeLs, { code: 0, stdout: '' }],
      [workerPs, { code: 0, stdout: 'w1\n' }],
      [workerInspect, { code: 0, stdout: 'bind \n' }],
    ]);
    expect(await findDataVolume(docker, { self: 'abc123' })).toEqual({
      problem: expect.stringContaining('has no worker-data volume'),
    });
  });

  it('is refused, clearly, when the project has none', async () => {
    const { docker } = fakeDocker([
      [selfInspect, { code: 0, stdout: 'devailoop\n' }],
      [volumeLs, { code: 0, stdout: '' }],
      [workerPs, { code: 0, stdout: '' }],
    ]);
    const found = await findDataVolume(docker, { self: 'abc123' });
    expect(found).toEqual({
      problem: expect.stringMatching(/"devailoop", but it has no worker-data volume.*DEVAILOOP_DATA_VOLUME/),
    });
  });

  it('is refused, clearly, when the runner was not started by Compose', async () => {
    const { docker } = fakeDocker([[selfInspect, { code: 0, stdout: '\n' }]]);
    const found = await findDataVolume(docker, { self: 'abc123' });
    expect(found).toEqual({
      problem: expect.stringContaining('it was not started by Docker Compose. Set DEVAILOOP_DATA_VOLUME'),
    });
  });

  it('is refused when the volume found has gone by the time it is checked', async () => {
    const { docker } = fakeDocker([
      [selfInspect, { code: 0, stdout: 'devailoop\n' }],
      [volumeLs, { code: 0, stdout: 'devailoop_worker-data\n' }],
      [volumeInspect, missing],
    ]);
    expect(await findDataVolume(docker, { self: 'abc123' })).toEqual({
      problem: expect.stringContaining('"devailoop_worker-data" does not exist'),
    });
  });
});
