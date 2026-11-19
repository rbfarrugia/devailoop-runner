import { type ChildProcess, spawn } from 'node:child_process';
import type { AddressInfo, Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { bindInstanceInContainer, runCommandInContainer } from '../src/client';
import { commandListsProblem, commandRunArgs, commandSandboxSettings } from '../src/docker-args';
import { type Docker, createRunner } from '../src/server';

const input = {
  cwd: '/data/projects/SHOP/working-copies/SHOP-1',
  script: 'pnpm -r test',
  timeoutMs: 60_000,
  project: 'SHOP',
  allowedDomains: ['registry.npmjs.org'],
  denyRead: ['/data/secrets/key.pem'],
};

describe('the docker run for a command', () => {
  const args = commandRunArgs({ name: 'c1', image: 'devailoop-agent-base', dataVolume: 'vol', ...input });
  const image = args.indexOf('devailoop-agent-base');

  it('runs the script under srt in the image, with the settings and the script as arguments, never in the shell text', () => {
    expect(args.slice(image + 1, image + 3)).toEqual(['-c', expect.stringContaining('srt --settings')]);
    expect(args.slice(-2)[1]).toBe('pnpm -r test');
    expect(args[image + 2]).not.toContain('pnpm -r test');
    expect(args.slice(0, image).join(' ')).toContain('--entrypoint sh');
  });

  it('passes no environment variable of the worker and mounts only the session parts of the volume', () => {
    expect(args.filter((a, i) => args[i - 1] === '--env').every((e) => !/KEY|TOKEN|DATABASE/.test(e))).toBe(true);
    expect(args.slice(0, image).filter((a) => a === '-v' || a === '--volume')).toEqual([]);
  });

  it("builds the sandbox settings from the Project's allowlist, denied reads and write paths", () => {
    const settings = JSON.parse(commandSandboxSettings(input));
    expect(settings.network.allowedDomains).toEqual(['registry.npmjs.org']);
    expect(settings.filesystem.denyRead).toEqual(['/data/claude-configs/SHOP', '/data/secrets/key.pem']);
    expect(settings.filesystem.allowWrite).toEqual(['/data/projects/SHOP/home', input.cwd]);
  });
});

describe('a command request', () => {
  it('is refused for a bad script, timeout, domain or path', () => {
    const ok = { script: 'true', allowedDomains: [], denyRead: [], timeoutMs: 5000 };
    expect(commandListsProblem(ok)).toBeNull();
    expect(commandListsProblem({ ...ok, script: '' })).toMatch(/script/);
    expect(commandListsProblem({ ...ok, timeoutMs: 10 })).toMatch(/timeout/);
    expect(commandListsProblem({ ...ok, allowedDomains: ['a b'] })).toMatch(/domains/);
    expect(commandListsProblem({ ...ok, denyRead: ['relative'] })).toMatch(/paths/);
  });
});

function fakeDocker(script: string, oomKilled = false) {
  const spawned: { args: string[]; child: ChildProcess }[] = [];
  const execs: string[][] = [];
  const docker: Docker = {
    spawn(args) {
      const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
      spawned.push({ args, child });
      return child;
    },
    async exec(args) {
      execs.push(args);
      if (args[0] === 'rm') for (const s of spawned) s.child.kill('SIGKILL');
      return { code: 0, stdout: args[0] === 'container' && oomKilled ? 'true\n' : 'false\n', stderr: '' };
    },
  };
  return { docker, spawned, execs };
}

let server: Server | undefined;
afterEach(() => server?.close());
async function listen(docker: Docker): Promise<string> {
  server = createRunner({ docker, image: 'devailoop-agent-base', dataVolume: 'vol', log: () => {} });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = `127.0.0.1:${(server!.address() as AddressInfo).port}`;
  // Like the worker, which tells its runner the instance before asking for anything.
  await bindInstanceInContainer(address, 'test-instance-0001');
  return address;
}

describe('running a command through the runner', () => {
  it('streams the output and reports the exit code', async () => {
    const { docker, spawned } = fakeDocker(
      "process.stdout.write('out\\n'); process.stderr.write('err\\n'); process.exit(3)",
    );
    const address = await listen(docker);
    let out = '';
    const result = await runCommandInContainer(address, input, (t) => (out += t));
    expect(result).toEqual({ kind: 'finished', exitCode: 3 });
    expect(out).toContain('out');
    expect(out).toContain('err');
    expect(spawned).toHaveLength(1);
  });

  it('says so in the output, and removes the container, when it ran out of memory', async () => {
    const { docker, execs } = fakeDocker('process.exit(137)', true);
    const address = await listen(docker);
    let out = '';
    const result = await runCommandInContainer(address, input, (t) => (out += t));
    expect(result).toEqual({ kind: 'finished', exitCode: 137 });
    expect(out).toContain('ran out of memory');
    expect(out).toContain('DEVAILOOP_AGENT_MEMORY');
    expect(execs.some((e) => e[0] === 'container' && e[1] === 'inspect')).toBe(true);
    expect(execs.some((e) => e[0] === 'rm' && e[1] === '--force')).toBe(true);
  });

  it('says nothing about memory, and still removes the container, otherwise', async () => {
    const { docker, execs } = fakeDocker('process.exit(3)');
    const address = await listen(docker);
    let out = '';
    await runCommandInContainer(address, input, (t) => (out += t));
    expect(out).not.toContain('memory');
    expect(execs.some((e) => e[0] === 'rm' && e[1] === '--force')).toBe(true);
  });

  it('kills the container when the time is up', async () => {
    const { docker, execs } = fakeDocker('setInterval(() => {}, 1000)');
    const address = await listen(docker);
    const result = await runCommandInContainer(address, { ...input, timeoutMs: 1000 }, () => {});
    expect(result).toEqual({ kind: 'timed_out' });
    expect(execs.some((e) => e[0] === 'rm')).toBe(true);
  });

  it("refuses a working copy of another Project, and an image that is not the Project's", async () => {
    const { docker, spawned } = fakeDocker('process.exit(0)');
    const address = await listen(docker);
    const other = await runCommandInContainer(
      address,
      { ...input, cwd: '/data/projects/OTHER/working-copies/OTHER-1' },
      () => {},
    );
    expect(other).toMatchObject({ kind: 'failed', reason: expect.stringContaining('OTHER') });
    const image = await runCommandInContainer(address, { ...input, image: 'evil:latest', projectId: 7 }, () => {});
    expect(image).toMatchObject({ kind: 'failed', reason: expect.stringContaining('not an Environment image') });
    expect(spawned).toHaveLength(0);
  });

  it('gives up when the signal is aborted', async () => {
    const { docker } = fakeDocker('setInterval(() => {}, 1000)');
    const address = await listen(docker);
    const controller = new AbortController();
    const pending = runCommandInContainer(address, input, () => {}, controller.signal);
    setTimeout(() => controller.abort(), 200);
    expect(await pending).toMatchObject({ kind: 'failed' });
  });
});
