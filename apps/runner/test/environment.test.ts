import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { AddressInfo, Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ContainerProcess, bindInstanceInContainer, buildImageInContainer } from '../src/client';
import { type Docker, type RunnerOptions, createRunner } from '../src/server';

const DOCKERFILE = 'FROM devailoop-agent-base\nUSER root\nRUN apt-get install -y unzip\nUSER agent\n';

/** Stands in for `docker build`: says what it read on stdin, then exits with the given code. */
const builder = (code: number) => `
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => { process.stdout.write('#1 building ' + input.split('\\n').length + ' lines\\n'); process.stderr.write('#2 DONE\\n'); process.exit(${code}); });
`;
/** Stands in for Claude Code in its container: echoes stdin in capitals. */
const ECHO = `process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase())); process.stdin.on('end', () => process.exit(0));`;

type Answer = { code: number; stdout?: string; stderr?: string };

/** Docker as the runner sees it: scripts in place of `build` and `run`, and answers to everything else. */
function fakeDocker(input: { buildCode?: number; answer?: (args: string[]) => Answer | undefined } = {}) {
  const spawned: { args: string[]; stdin: string; child: ChildProcess }[] = [];
  const execs: string[][] = [];
  const docker: Docker = {
    spawn(args) {
      const script = args[0] === 'buildx' && args[1] === 'build' ? builder(input.buildCode ?? 0) : ECHO;
      const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
      const entry = { args, stdin: '', child };
      // What the runner writes to the process, as the test wants to see it.
      const write = child.stdin!.write.bind(child.stdin!);
      const end = child.stdin!.end.bind(child.stdin!);
      child.stdin!.write = ((chunk: unknown, ...rest: never[]) => (
        (entry.stdin += String(chunk)),
        write(chunk as string, ...rest)
      )) as typeof child.stdin.write;
      child.stdin!.end = ((chunk?: unknown, ...rest: never[]) => {
        if (typeof chunk === 'string') entry.stdin += chunk;
        return end(chunk as string, ...rest);
      }) as typeof child.stdin.end;
      spawned.push(entry);
      return child;
    },
    async exec(args) {
      execs.push(args);
      const answer =
        input.answer?.(args) ??
        (args[0] === 'image' && args[1] === 'inspect' ? { code: 0, stdout: 'sha256:abc\n' } : { code: 0 });
      return { code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
    },
  };
  return { docker, spawned, execs };
}

/** What the base image's export is, as the runner is told it. */
let exported: Awaited<ReturnType<NonNullable<RunnerOptions['exportBase']>>> = {
  id: 'sha256:abc',
  dir: '/export/base',
  digest: `sha256:${'d'.repeat(64)}`,
};

let server: Server | undefined;
afterEach(() => server?.close());

async function listen(docker: Docker): Promise<string> {
  server = createRunner({
    docker,
    image: 'devailoop-agent-base',
    dataVolume: 'devailoop_worker-data',
    log: () => {},
    exportBase: async () => exported,
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = `127.0.0.1:${(server!.address() as AddressInfo).port}`;
  // Like the worker, which tells its runner the instance before asking for anything.
  await bindInstanceInContainer(address, 'test-instance-0001');
  return address;
}

const isSandboxCheck = (args: string[]) => args[0] === 'run' && args.includes('--entrypoint');

describe("building a Project's Environment", () => {
  it('builds from the Dockerfile on stdin with no build context, checks the sandbox, then tags it for the Project', async () => {
    const { docker, spawned, execs } = fakeDocker();
    let log = '';
    const reply = await buildImageInContainer(
      await listen(docker),
      { projectId: 7, dockerfile: DOCKERFILE },
      (text) => (log += text),
    );

    const hash = createHash('sha256').update(DOCKERFILE).digest('hex').slice(0, 12);
    expect(reply).toEqual({ built: true, image: `devailoop-env-7:${hash}`, baseImageId: 'sha256:abc' });

    const build = spawned[0]!;
    // Every option is the runner's; the context is "-", which is stdin, so no directory of the host's is sent.
    const candidate = build.args[build.args.indexOf('--tag') + 1]!;
    expect(candidate).toMatch(/^devailoop-env-7:candidate-[0-9a-f]{12}$/);
    expect(build.args).toEqual([
      'buildx',
      'build',
      '--builder',
      'devailoop-devailoop_worker-data',
      '--load',
      '--progress=plain',
      '--build-context',
      `devailoop-agent-base=oci-layout:///export/base@sha256:${'d'.repeat(64)}`,
      '--label',
      'devailoop.environment=7',
      '--label',
      'devailoop.owner=devailoop_worker-data',
      '--label',
      'devailoop.instance=test-instance-0001',
      '--tag',
      candidate,
      '-',
    ]);
    expect(build.stdin).toBe(DOCKERFILE);
    expect(log).toContain('#1 building 5 lines');
    expect(log).toContain('#2 DONE');
    expect(log).toContain('The sandbox check passed.');

    // The check runs in the new image, before it is given the Project's tag.
    const check = execs.findIndex(isSandboxCheck);
    const tag = execs.findIndex((args) => args[0] === 'image' && args[1] === 'tag');
    expect(execs[check]).toContain(candidate);
    expect(check).toBeLessThan(tag);
    expect(execs[tag]).toEqual(['image', 'tag', candidate, (reply as { image: string }).image]);
    expect(execs).toContainEqual(['image', 'rm', candidate]);

    // The builder is looked at before the build, and its container is limited as a session's is.
    const prepared = execs.findIndex((args) => args[0] === 'buildx' && args[2] === '--bootstrap');
    expect(execs[prepared]).toEqual(['buildx', 'inspect', '--bootstrap', 'devailoop-devailoop_worker-data']);
    expect(execs[prepared + 1]).toEqual([
      'update',
      '--memory',
      '8g',
      '--memory-swap',
      '8g',
      '--pids-limit',
      '4096',
      '--cpu-shares',
      '512',
      'buildx_buildkit_devailoop-devailoop_worker-data0',
    ]);
  });

  it('makes the builder when there is none, and builds nothing unlimited when it cannot', async () => {
    let made = false;
    const { docker, spawned, execs } = fakeDocker({
      answer: (args) =>
        args[1] === 'inspect' && args[2] !== '--bootstrap'
          ? made
            ? { code: 0 }
            : { code: 1, stderr: 'no builder\n' }
          : args[1] === 'create'
            ? ((made = true), { code: 0 })
            : undefined,
    });
    const reply = await buildImageInContainer(await listen(docker), { projectId: 7, dockerfile: DOCKERFILE }, () => {});
    expect(reply.built).toBe(true);
    expect(execs).toContainEqual([
      'buildx',
      'create',
      '--name',
      'devailoop-devailoop_worker-data',
      '--driver',
      'docker-container',
      '--driver-opt',
      'image=moby/buildkit:buildx-stable-1',
    ]);
    expect(spawned).toHaveLength(1);

    const broken = fakeDocker({
      answer: (args) => (args[0] === 'update' ? { code: 1, stderr: 'no such container\n' } : undefined),
    });
    let log = '';
    const refused = await buildImageInContainer(
      await listen(broken.docker),
      { projectId: 7, dockerfile: DOCKERFILE },
      (text) => (log += text),
    );
    expect(!refused.built && refused.reason).toMatch(/limits of the builder .* could not be set: no such container/);
    expect(broken.spawned).toHaveLength(0);
    expect(log).toContain('could not be set');
  });

  it('shows the real error when a builder buildx knows cannot start, not the progress before it', async () => {
    const { docker, spawned, execs } = fakeDocker({
      answer: (args) =>
        args[1] === 'inspect' && args[2] === '--bootstrap'
          ? {
              code: 1,
              stderr: '#1 [internal] booting buildkit\n#1 pulling image moby/buildkit\nERROR: pull failed: no route\n',
            }
          : args[1] === 'create'
            ? { code: 1, stderr: 'ERROR: existing instance for "x" but no append mode\n' }
            : undefined,
    });
    const reply = await buildImageInContainer(await listen(docker), { projectId: 7, dockerfile: DOCKERFILE }, () => {});
    expect(!reply.built && reply.reason).toMatch(/could not be started: pull failed: no route\./);
    expect(execs.some((args) => args[1] === 'create')).toBe(false);
    expect(spawned).toHaveLength(0);
  });

  it('fails the build, and starts none, when the base image cannot be exported', async () => {
    exported = { problem: 'devailoop-agent-base is not there, so nothing can be built on it.' };
    try {
      const { docker, spawned } = fakeDocker();
      const reply = await buildImageInContainer(
        await listen(docker),
        { projectId: 7, dockerfile: DOCKERFILE },
        () => {},
      );
      expect(reply).toEqual({
        built: false,
        reason: 'devailoop-agent-base is not there, so nothing can be built on it.',
      });
      expect(spawned).toHaveLength(0);
    } finally {
      exported = { id: 'sha256:abc', dir: '/export/base', digest: `sha256:${'d'.repeat(64)}` };
    }
  });

  it('gives the same Dockerfile the same tag, and a different one another', async () => {
    const { docker } = fakeDocker();
    const address = await listen(docker);
    const first = await buildImageInContainer(address, { projectId: 7, dockerfile: DOCKERFILE }, () => {});
    const again = await buildImageInContainer(address, { projectId: 7, dockerfile: DOCKERFILE }, () => {});
    const other = await buildImageInContainer(
      address,
      { projectId: 7, dockerfile: `${DOCKERFILE}RUN true\n` },
      () => {},
    );
    expect(first).toEqual(again);
    expect(other.built && first.built && other.image !== first.image).toBe(true);
  });

  it('never tags an image whose build failed', async () => {
    const { docker, execs } = fakeDocker({ buildCode: 1 });
    const reply = await buildImageInContainer(await listen(docker), { projectId: 7, dockerfile: DOCKERFILE }, () => {});
    expect(reply).toEqual({ built: false, reason: 'docker build failed (exit code 1). The log shows why.' });
    expect(execs.some((args) => args[1] === 'tag')).toBe(false);
    expect(execs.some(isSandboxCheck)).toBe(false);
    expect(execs.some((args) => args[0] === 'image' && args[1] === 'rm')).toBe(true);
  });

  it("says the build ran out of memory, naming DEVAILOOP_AGENT_MEMORY, when the builder's cgroup counted a kill", async () => {
    let reads = 0;
    const { docker } = fakeDocker({
      buildCode: 1,
      answer: (args) =>
        args[0] === 'exec' && args.includes('/sys/fs/cgroup/memory.events')
          ? { code: 0, stdout: `low 0\noom 1\noom_kill ${reads++ === 0 ? 2 : 3}\n` }
          : undefined,
    });
    let log = '';
    const reply = await buildImageInContainer(
      await listen(docker),
      { projectId: 7, dockerfile: DOCKERFILE },
      (text) => (log += text),
    );
    expect(!reply.built && reply.reason).toMatch(/ran out of memory.*DEVAILOOP_AGENT_MEMORY/);
    expect(log).toContain('DEVAILOOP_AGENT_MEMORY');
  });

  it('says the build ran out of memory when Docker recorded the builder itself as OOM-killed', async () => {
    const { docker } = fakeDocker({
      buildCode: 1,
      answer: (args) =>
        args[0] === 'exec'
          ? { code: 1 }
          : args[0] === 'container' && args[1] === 'inspect'
            ? { code: 0, stdout: 'true\n' }
            : undefined,
    });
    const reply = await buildImageInContainer(await listen(docker), { projectId: 7, dockerfile: DOCKERFILE }, () => {});
    expect(!reply.built && reply.reason).toContain('DEVAILOOP_AGENT_MEMORY');
  });

  it('keeps the generic reason when the kill count did not grow', async () => {
    const { docker } = fakeDocker({
      buildCode: 1,
      answer: (args) =>
        args[0] === 'exec' && args.includes('/sys/fs/cgroup/memory.events')
          ? { code: 0, stdout: 'oom_kill 2\n' }
          : undefined,
    });
    const reply = await buildImageInContainer(await listen(docker), { projectId: 7, dockerfile: DOCKERFILE }, () => {});
    expect(reply).toEqual({ built: false, reason: 'docker build failed (exit code 1). The log shows why.' });
  });

  it('never tags an image the sandbox cannot work in', async () => {
    const { docker, execs } = fakeDocker({
      answer: (args) =>
        isSandboxCheck(args)
          ? { code: 5, stderr: "the Agent's image must create /var/lib/devailoop-sandbox\n" }
          : undefined,
    });
    let log = '';
    const reply = await buildImageInContainer(
      await listen(docker),
      { projectId: 7, dockerfile: DOCKERFILE },
      (text) => (log += text),
    );
    expect(reply.built).toBe(false);
    expect(!reply.built && reply.reason).toMatch(/sandbox cannot work in it.*devailoop-sandbox/);
    expect(log).toContain('The sandbox check failed');
    expect(execs.some((args) => args[1] === 'tag')).toBe(false);
  });

  it.each([
    ['another base', 7, 'FROM ubuntu\n', /must start with "FROM devailoop-agent-base"/],
    ['a Project that is not an id', '../x', DOCKERFILE, /must name a Project/],
    ['a Project code instead of its id', 'SHOP', DOCKERFILE, /must name a Project/],
  ])('refuses %s without building', async (_name, projectId, dockerfile, message) => {
    const { docker, spawned } = fakeDocker();
    const reply = await buildImageInContainer(
      await listen(docker),
      { projectId: projectId as number, dockerfile },
      () => {},
    );
    expect(reply.built).toBe(false);
    expect(!reply.built && reply.reason).toMatch(message);
    expect(spawned).toHaveLength(0);
  });
});

describe("a session's image", () => {
  const spawnOptions = () => ({
    command: 'claude',
    args: ['-p'],
    cwd: '/data/projects/SHOP/working-copies/SHOP-1',
    env: { HOME: '/data/agent-home' },
    signal: new AbortController().signal,
  });
  const labelled = (label: string) => (args: string[]) =>
    args[0] === 'image' && args[1] === 'inspect' && args.join(' ').includes('Labels')
      ? { code: 0, stdout: `${label}\n` }
      : undefined;

  /** Runs a session and answers with the image it was started in, or why it was refused. */
  async function sessionIn(
    docker: Docker,
    spawned: { args: string[] }[],
    target: { project?: string; projectId?: number; image?: string | null },
  ) {
    return sessionWith(docker, spawned, target as { project: string; projectId: number; image?: string | null });
  }

  async function sessionWith(
    docker: Docker,
    spawned: { args: string[] }[],
    target: { project: string; projectId: number; image?: string | null },
  ) {
    let error: Error | undefined;
    const process = new ContainerProcess(await listen(docker), spawnOptions(), undefined, target);
    process.on('error', (e: Error) => (error = e));
    let out = '';
    process.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    // Written at once, before the runner has looked at the image: it must not be lost.
    process.stdin.write('hello\n');
    process.stdin.end();
    await new Promise((resolve) => process.once('exit', resolve));
    if (error) return { refused: error.message };
    const args = spawned[0]!.args;
    return { image: args[args.indexOf('claude') - 1], out };
  }

  it("runs in the runner's own image when the Project has none", async () => {
    const { docker, spawned } = fakeDocker();
    expect(await sessionIn(docker, spawned, { project: 'SHOP', projectId: 7, image: null })).toEqual({
      image: 'devailoop-agent-base',
      out: 'HELLO\n',
    });
  });

  it("runs in the Project's own Environment image, which the runner labelled for it", async () => {
    const { docker, spawned } = fakeDocker({ answer: labelled('7') });
    expect(
      await sessionIn(docker, spawned, { project: 'SHOP', projectId: 7, image: 'devailoop-env-7:0123456789ab' }),
    ).toEqual({
      image: 'devailoop-env-7:0123456789ab',
      out: 'HELLO\n',
    });
  });

  it.each([
    [
      'another Project’s image',
      { project: 'SHOP', projectId: 7, image: 'devailoop-env-8:0123456789ab' },
      '8',
      /not an Environment image of SHOP/,
    ],
    [
      'an image of any other name',
      { project: 'SHOP', projectId: 7, image: 'ubuntu:24.04' },
      '7',
      /not an Environment image of SHOP/,
    ],
    [
      'an image named by a Project code',
      { project: 'SHOP', projectId: 7, image: 'devailoop-env-shop:0123456789ab' },
      '7',
      /not an Environment image of SHOP/,
    ],
    [
      'an image without the runner’s label',
      { project: 'SHOP', projectId: 7, image: 'devailoop-env-7:0123456789ab' },
      '<no value>',
      /not built by the runner for SHOP/,
    ],
    [
      'an image labelled for another Project',
      { project: 'SHOP', projectId: 7, image: 'devailoop-env-7:0123456789ab' },
      '8',
      /not built by the runner for SHOP/,
    ],
    [
      'an image with no Project id named',
      { project: 'SHOP', image: 'devailoop-env-7:0123456789ab' },
      '7',
      /must name its Project by its id/,
    ],
    [
      'an image with no Project named',
      { projectId: 7, image: 'devailoop-env-7:0123456789ab' },
      '7',
      /must name its Project/,
    ],
    ['a session with no Project named', { image: null }, '7', /must name its Project/],
    ['a Project that is not a code', { project: '../SHOP', projectId: 7, image: null }, '7', /must name its Project/],
  ])('refuses %s', async (_name, target, label, message) => {
    const { docker, spawned } = fakeDocker({ answer: labelled(label) });
    const result = await sessionIn(docker, spawned, target);
    expect(result.refused).toMatch(message);
    expect(spawned).toHaveLength(0);
  });

  it('refuses an image that is not there', async () => {
    const { docker, spawned } = fakeDocker({
      answer: (args) => (args[1] === 'inspect' ? { code: 1, stderr: 'No such image\n' } : undefined),
    });
    const result = await sessionIn(docker, spawned, {
      project: 'SHOP',
      projectId: 7,
      image: 'devailoop-env-7:0123456789ab',
    });
    expect(result.refused).toMatch(/is not there: No such image/);
  });
});
