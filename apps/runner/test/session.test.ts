import { type ChildProcess, spawn } from 'node:child_process';
import type { AddressInfo, Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ContainerProcess,
  bindInstanceInContainer,
  checkLocalLlmInContainer,
  checkSandboxInContainer,
} from '../src/client';
import { type Docker, createRunner, removeLeftoverContainers } from '../src/server';

/** Stands in for Claude Code in its container: echoes each line of stdin in capitals, then exits 7. */
const ECHO = `
process.stderr.write('starting\\n');
let rest = '';
process.stdin.on('data', (d) => { rest += d; let i; while ((i = rest.indexOf('\\n')) >= 0) { process.stdout.write(rest.slice(0, i).toUpperCase() + '\\n'); rest = rest.slice(i + 1); } });
process.stdin.on('end', () => process.exit(7));
`;
const HANG = 'setInterval(() => {}, 1000)';

/** Docker as the runner sees it, running a script in place of each container. */
function fakeDocker(script: string, answers: Record<string, { code: number; stdout?: string; stderr?: string }> = {}) {
  const spawned: { args: string[]; env: Record<string, string>; child: ChildProcess }[] = [];
  const execs: string[][] = [];
  const docker: Docker = {
    spawn(args, env) {
      const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
      spawned.push({ args, env, child });
      return child;
    },
    async exec(args) {
      execs.push(args);
      // Removing or killing a container ends the docker command attached to it.
      if (args[0] === 'rm' || args[0] === 'kill') {
        for (const session of spawned)
          if (args.includes(session.args[session.args.indexOf('--name') + 1]!)) session.child.kill('SIGKILL');
      }
      const answer = answers[args[0]!] ?? { code: 0 };
      return { code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
    },
  };
  return { docker, spawned, execs };
}

let server: Server | undefined;
afterEach(() => server?.close());

async function listen(docker: Docker): Promise<string> {
  server = createRunner({ docker, image: 'devailoop-agent-base', dataVolume: 'devailoop_worker-data', log: () => {} });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = `127.0.0.1:${(server!.address() as AddressInfo).port}`;
  // Like the worker, which tells its runner the instance before asking for anything.
  await bindInstanceInContainer(address, 'test-instance-0001');
  return address;
}

const spawnOptions = (overrides: Partial<ConstructorParameters<typeof ContainerProcess>[1]> = {}) => ({
  command: '/app/node_modules/claude',
  args: ['--output-format', 'stream-json'],
  cwd: '/data/projects/SHOP/working-copies/SHOP-1',
  env: { HOME: '/data/agent-home', DATABASE_URL: 'postgres://secret', ANTHROPIC_API_KEY: 'sk-ant-x' },
  signal: new AbortController().signal,
  ...overrides,
});

const SHOP = { project: 'SHOP', projectId: 7 };

const exited = (process: ContainerProcess) =>
  new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
    process.once('exit', (code, signal) => resolve([code, signal])),
  );

const collect = (process: ContainerProcess) => {
  let out = '';
  process.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
  return () => out;
};

describe('a session through the runner', () => {
  it("carries stdin, stdout, stderr and the exit code between the SDK and the container's process", async () => {
    const { docker, spawned } = fakeDocker(ECHO);
    const address = await listen(docker);
    let stderr = '';
    const process = new ContainerProcess(address, spawnOptions(), (text) => (stderr += text), SHOP);
    const out = collect(process);
    const exit = exited(process);
    process.stdin.write('hello\n');
    process.stdin.write('again\n');
    process.stdin.end();

    expect(await exit).toEqual([7, null]);
    expect(out()).toBe('HELLO\nAGAIN\n');
    expect(stderr).toBe('starting\n');
    expect(process.exitCode).toBe(7);

    // Only Claude Code's arguments go on, after the image; the worker's database address does not.
    const args = spawned[0]!.args;
    expect(args.slice(-3)).toEqual(['claude', '--output-format', 'stream-json']);
    // HOME is the runner's to set, to the Project's own home.
    expect(spawned[0]!.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-x' });
    expect(args).toContain('HOME=/data/projects/SHOP/home');
    expect(args.join(' ')).not.toContain('postgres://secret');
  });

  it('drops the script path when the SDK names a JavaScript runtime as the command', async () => {
    const { docker, spawned } = fakeDocker(ECHO);
    const process = new ContainerProcess(
      await listen(docker),
      spawnOptions({ command: '/usr/bin/node', args: ['/app/cli.js', '-p'] }),
      undefined,
      SHOP,
    );
    const exit = exited(process);
    process.stdin.end();
    await exit;
    expect(spawned[0]!.args.slice(-2)).toEqual(['claude', '-p']);
  });

  it('says so on stderr, and removes the container, when it ran out of memory', async () => {
    const { docker, execs, spawned } = fakeDocker('process.exit(137)', { container: { code: 0, stdout: 'true\n' } });
    const address = await listen(docker);
    let stderr = '';
    const process = new ContainerProcess(address, spawnOptions(), (text) => (stderr += text), SHOP);
    const exit = exited(process);
    process.stdin.end();
    expect(await exit).toEqual([137, null]);
    expect(stderr).toContain('ran out of memory');
    expect(stderr).toContain('DEVAILOOP_AGENT_MEMORY');
    const name = spawned[0]!.args[spawned[0]!.args.indexOf('--name') + 1]!;
    expect(execs).toContainEqual(['container', 'inspect', '--format', '{{.State.OOMKilled}}', name]);
    expect(execs).toContainEqual(['rm', '--force', name]);
  });

  it('says nothing about memory, and still removes the container, when it ended otherwise', async () => {
    const { docker, execs, spawned } = fakeDocker('process.exit(1)', { container: { code: 0, stdout: 'false\n' } });
    const address = await listen(docker);
    let stderr = '';
    const process = new ContainerProcess(address, spawnOptions(), (text) => (stderr += text), SHOP);
    const exit = exited(process);
    process.stdin.end();
    expect(await exit).toEqual([1, null]);
    expect(stderr).toBe('');
    const name = spawned[0]!.args[spawned[0]!.args.indexOf('--name') + 1]!;
    expect(execs).toContainEqual(['rm', '--force', name]);
  });

  it('removes the container when the session is killed', async () => {
    const { docker, execs } = fakeDocker(HANG);
    const process = new ContainerProcess(await listen(docker), spawnOptions(), undefined, SHOP);
    const exit = exited(process);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(process.kill('SIGKILL')).toBe(true);

    await exit;
    expect(process.killed).toBe(true);
    expect(execs.some((args) => args[0] === 'rm' && args[1] === '--force')).toBe(true);
  });

  it('removes the container when the SDK aborts the session', async () => {
    const { docker, execs } = fakeDocker(HANG);
    const controller = new AbortController();
    const process = new ContainerProcess(
      await listen(docker),
      spawnOptions({ signal: controller.signal }),
      undefined,
      SHOP,
    );
    const exit = exited(process);
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    await exit;
    expect(execs.some((args) => args[0] === 'kill' || args[0] === 'rm')).toBe(true);
  });

  it('removes the container when the worker goes away mid-session', async () => {
    const { docker, execs, spawned } = fakeDocker(HANG);
    const process = new ContainerProcess(await listen(docker), spawnOptions(), undefined, SHOP);
    await new Promise((resolve) => setTimeout(resolve, 200));
    (process as unknown as { socket: { destroy(): void } }).socket.destroy();

    await new Promise((resolve) => spawned[0]!.child.once('exit', resolve));
    const name = spawned[0]!.args[spawned[0]!.args.indexOf('--name') + 1];
    expect(execs).toContainEqual(['rm', '--force', name]);
  });

  it('refuses a working directory outside the data volume, starting nothing', async () => {
    const { docker, spawned } = fakeDocker(ECHO);
    const process = new ContainerProcess(await listen(docker), spawnOptions({ cwd: '/run/secrets' }), undefined, SHOP);
    const errors: Error[] = [];
    process.on('error', (error) => errors.push(error));
    await exited(process);
    expect(errors[0]?.message).toContain("must be a Ticket's working copy");
    expect(spawned).toHaveLength(0);
  });

  it("refuses another Project's working copy, starting nothing", async () => {
    const { docker, spawned } = fakeDocker(ECHO);
    const process = new ContainerProcess(
      await listen(docker),
      spawnOptions({ cwd: '/data/projects/BLOG/working-copies/BLOG-3' }),
      undefined,
      SHOP,
    );
    const errors: Error[] = [];
    process.on('error', (error) => errors.push(error));
    await exited(process);
    expect(errors[0]?.message).toContain('belongs to a Ticket of BLOG, not of SHOP');
    expect(spawned).toHaveLength(0);
  });

  it("mounts only the session's own working copy, home and Claude Code directory", async () => {
    const { docker, spawned } = fakeDocker(ECHO);
    const process = new ContainerProcess(await listen(docker), spawnOptions(), undefined, SHOP);
    const exit = exited(process);
    process.stdin.end();
    await exit;
    const { args } = spawned[0]!;
    expect(args.filter((arg, i) => args[i - 1] === '--mount')).toEqual([
      'type=tmpfs,target=/data,tmpfs-size=1m,tmpfs-mode=0555',
      'type=volume,source=devailoop_worker-data,target=/data/claude-configs/SHOP,volume-subpath=claude-configs/SHOP',
      'type=volume,source=devailoop_worker-data,target=/data/projects/SHOP,volume-subpath=projects/SHOP',
    ]);
  });

  it('says so when the runner cannot be reached', async () => {
    const process = new ContainerProcess('127.0.0.1:1', spawnOptions(), undefined, SHOP);
    const errors: Error[] = [];
    process.on('error', (error) => errors.push(error));
    await exited(process);
    expect(errors[0]?.message).toContain('could not be reached');
  });
});

describe("the sandbox check in the Agent's image", () => {
  it('passes when the check runs, and is run once per image', async () => {
    const { docker, execs } = fakeDocker(ECHO, { image: { code: 0, stdout: 'sha256:abc\n' } });
    const address = await listen(docker);
    expect(await checkSandboxInContainer(address)).toEqual({ available: true });
    expect(await checkSandboxInContainer(address)).toEqual({ available: true });
    expect(execs.filter((args) => args[0] === 'run')).toHaveLength(1);
  });

  it('fails, saying why, when bubblewrap cannot run in the image', async () => {
    const { docker } = fakeDocker(ECHO, {
      image: { code: 0, stdout: 'sha256:abc\n' },
      run: { code: 4, stderr: 'bwrap: No permissions to create new namespace\n' },
    });
    const check = await checkSandboxInContainer(await listen(docker));
    expect(check).toEqual({
      available: false,
      reason: expect.stringContaining('No permissions to create new namespace'),
    });
  });

  it("fails, saying how to fix it, when the image has no directory for the sandbox's sockets", async () => {
    const said =
      "the Agent's image must create /var/lib/devailoop-sandbox, owned by agent; build it on devailoop-agent-base";
    const { docker } = fakeDocker(ECHO, {
      image: { code: 0, stdout: 'sha256:abc\n' },
      run: { code: 5, stderr: `${said}\n` },
    });
    const check = await checkSandboxInContainer(await listen(docker));
    expect(check).toEqual({ available: false, reason: `In the Agent's image: ${said}` });
  });

  it('fails when the image is not there', async () => {
    const { docker } = fakeDocker(ECHO, { image: { code: 1, stderr: 'Error: No such image: devailoop-agent-base\n' } });
    const check = await checkSandboxInContainer(await listen(docker));
    expect(check).toEqual({ available: false, reason: expect.stringContaining('No such image') });
  });

  it('fails when the runner cannot be reached', async () => {
    expect(await checkSandboxInContainer('127.0.0.1:1')).toMatchObject({ available: false, unreachable: true });
  });
});

describe('leftover containers', () => {
  it('are found by their label and removed', async () => {
    const { docker, execs } = fakeDocker(ECHO, {
      ps: { code: 0, stdout: 'aaa\nbbb\n' },
      container: { code: 0, stdout: 'aaa\tv\nbbb\t\n' },
    });
    expect(await removeLeftoverContainers(docker, 'v')).toBe(2);
    expect(execs).toEqual([
      ['ps', '--all', '--quiet', '--no-trunc', '--filter', 'label=devailoop.session'],
      ['container', 'inspect', '--format', '{{.Id}}\t{{index .Config.Labels "devailoop.owner"}}', 'aaa', 'bbb'],
      ['rm', '--force', 'aaa', 'bbb'],
    ]);
  });
});

describe('checking a Local LLM through the runner', () => {
  const llm = { host: 'host.docker.internal', port: 11434, model: 'qwen3.5:9b' };

  it('says it answered when the status is 2xx', async () => {
    const { docker, execs } = fakeDocker(ECHO, { run: { code: 0, stdout: '{"content":[]}\n200' } });
    expect(await checkLocalLlmInContainer(await listen(docker), llm)).toMatchObject({ ok: true });
    expect(execs.find((args) => args[0] === 'run')).toContain('http://host.docker.internal:11434');
  });

  it('reports the context window Ollama lists for the model, also for an implied :latest tag', async () => {
    const ps = (name: string) => JSON.stringify({ models: [{ name, model: name, context_length: 4096 }] });
    for (const [listed, wanted] of [
      ['qwen3.5:9b', 'qwen3.5:9b'],
      ['llama3:latest', 'llama3'],
    ]) {
      const { docker } = fakeDocker(ECHO, {
        run: { code: 0, stdout: `{"content":[]}\n200\n---api-ps---\n${ps(listed!)}` },
      });
      expect(await checkLocalLlmInContainer(await listen(docker), { ...llm, model: wanted! })).toMatchObject({
        ok: true,
        contextLength: 4096,
      });
    }
  });

  it('passes without a context window when /api/ps is missing, not JSON or does not list the model', async () => {
    for (const ps of ['', '404 page not found', '{"models":[{"name":"other:1b","context_length":4096}]}']) {
      const { docker } = fakeDocker(ECHO, { run: { code: 0, stdout: `{"content":[]}\n200\n---api-ps---\n${ps}` } });
      const reply = await checkLocalLlmInContainer(await listen(docker), llm);
      expect(reply).toMatchObject({ ok: true });
      expect(reply).not.toHaveProperty('contextLength');
    }
  });

  it('says what the server answered with when it refuses', async () => {
    const { docker } = fakeDocker(ECHO, { run: { code: 0, stdout: '{"error":"model not found"}\n404' } });
    expect(await checkLocalLlmInContainer(await listen(docker), llm)).toEqual({
      ok: false,
      kind: 'http',
      status: 404,
      body: '{"error":"model not found"}',
    });
  });

  it("says it could not be reached, with curl's message", async () => {
    const { docker } = fakeDocker(ECHO, {
      run: { code: 7, stderr: 'curl: (7) Failed to connect to host.docker.internal port 11434\n' },
    });
    expect(await checkLocalLlmInContainer(await listen(docker), llm)).toEqual({
      ok: false,
      kind: 'unreachable',
      detail: 'curl: (7) Failed to connect to host.docker.internal port 11434',
    });
  });

  it('refuses a host that is not plain, without starting a container', async () => {
    const { docker, execs } = fakeDocker(ECHO);
    await expect(checkLocalLlmInContainer(await listen(docker), { ...llm, host: 'x;y' })).rejects.toThrow(
      /refused.*host/,
    );
    expect(execs.filter((args) => args[0] === 'run')).toHaveLength(0);
  });
});
