import { type ChildProcess, spawn } from 'node:child_process';
import type { AddressInfo, Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_BASE_CONTEXT,
  RECIPE_LABEL,
  agentBaseDockerfile,
  agentBaseRecipe,
  ensureBaseImageProblem,
} from '../src/agent-base';
import { ensureBaseImageInContainer } from '../src/client';
import { removeLeftoverBaseCandidates } from '../src/images';
import { type Docker, createRunner } from '../src/server';

const X64 = `sha512-${'A'.repeat(86)}==`;
const ARM64 = `sha512-${'B'.repeat(86)}==`;
const VALID = { sdkVersion: '0.3.296', integrity: { 'linux-x64': X64, 'linux-arm64': ARM64 } };

describe('the ensure-base-image request', () => {
  it('accepts a strict semver and sha512 integrities for both platforms', () => {
    expect(ensureBaseImageProblem(VALID)).toBeNull();
    expect(ensureBaseImageProblem({ ...VALID, sdkVersion: '1.0.0-beta.2' })).toBeNull();
  });

  it.each(['v1.2.3', '1.2', '01.2.3', '1.2.3+build', '1.2.3\nRUN evil', '1.2.3 --build-arg x', '', '^1.2.3'])(
    'refuses the version %j',
    (sdkVersion) => {
      expect(ensureBaseImageProblem({ ...VALID, sdkVersion })).toMatch(/sdkVersion/);
    },
  );

  it('refuses a version that is not text', () => {
    expect(ensureBaseImageProblem({ ...VALID, sdkVersion: 123 })).toMatch(/sdkVersion/);
    expect(ensureBaseImageProblem({ integrity: VALID.integrity })).toMatch(/sdkVersion/);
    expect(ensureBaseImageProblem(null)).toMatch(/sdkVersion/);
  });

  it.each([
    ['not sha512', 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA='],
    ['too short', 'sha512-AAAA=='],
    ['carrying a command', `sha512-${'A'.repeat(86)}==';rm -rf /;'`],
    ['with no prefix', `${'A'.repeat(86)}==`],
  ])('refuses an integrity that is %s', (_why, bad) => {
    expect(ensureBaseImageProblem({ ...VALID, integrity: { ...VALID.integrity, 'linux-arm64': bad } })).toMatch(
      /linux-arm64/,
    );
  });

  it('refuses a missing, extra or malformed integrity list', () => {
    expect(ensureBaseImageProblem({ sdkVersion: '1.2.3' })).toMatch(/integrity/);
    expect(ensureBaseImageProblem({ ...VALID, integrity: { 'linux-x64': X64 } })).toMatch(/exactly/);
    expect(ensureBaseImageProblem({ ...VALID, integrity: { ...VALID.integrity, 'linux-s390x': X64 } })).toMatch(
      /exactly/,
    );
    expect(ensureBaseImageProblem({ ...VALID, integrity: [X64] })).toMatch(/integrity/);
  });
});

describe('the generated agent-base Dockerfile', () => {
  const dockerfile = agentBaseDockerfile(VALID);

  it("pins Claude Code's version and checks both platforms' integrity before installing", () => {
    expect(dockerfile).toContain(
      'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-x64/-/claude-agent-sdk-linux-x64-0.3.296.tgz',
    );
    expect(dockerfile).toContain(
      'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-arm64/-/claude-agent-sdk-linux-arm64-0.3.296.tgz',
    );
    expect(dockerfile).toContain(`integrity='${X64}'`);
    expect(dockerfile).toContain(`integrity='${ARM64}'`);
    expect(dockerfile).toContain('createHash("sha512")');
    // The check comes before the binary is installed.
    expect(dockerfile.indexOf('createHash("sha512")')).toBeLessThan(dockerfile.indexOf('install -m 755'));
    expect(dockerfile).toContain('/usr/local/bin/claude');
  });

  it("holds today's agent-base: the sandbox's packages, the agent user, the sandbox's directory and the display launcher", () => {
    expect(dockerfile).toMatch(/^FROM node:24-bookworm-slim/);
    expect(dockerfile).toContain('git bubblewrap socat ripgrep ca-certificates procps curl python3-minimal');
    expect(dockerfile).toContain('@anthropic-ai/sandbox-runtime@0.0.82');
    expect(dockerfile).toContain('useradd --uid 1001');
    expect(dockerfile).toContain('/var/lib/devailoop-sandbox');
    expect(dockerfile).toContain('COPY --chmod=755 devailoop-display /usr/local/bin/devailoop-display');
    expect(dockerfile).toMatch(/USER agent\nCMD \["claude", "--version"\]\n$/);
  });

  it('changes its recipe with the version, an integrity or the launcher, and not otherwise', () => {
    const recipe = agentBaseRecipe(dockerfile);
    expect(agentBaseRecipe(agentBaseDockerfile(VALID))).toBe(recipe);
    expect(agentBaseRecipe(agentBaseDockerfile({ ...VALID, sdkVersion: '0.3.297' }))).not.toBe(recipe);
    expect(
      agentBaseRecipe(agentBaseDockerfile({ ...VALID, integrity: { ...VALID.integrity, 'linux-x64': ARM64 } })),
    ).not.toBe(recipe);
  });
});

/** Stands in for `docker buildx build`: says what it read on stdin, then exits with the given code. */
const builder = (code: number) => `
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => { process.stdout.write('#1 building ' + input.split('\\n').length + ' lines\\n'); process.exit(${code}); });
`;

type Answer = { code: number; stdout?: string; stderr?: string };

function fakeDocker(input: { buildCode?: number; answer?: (args: string[]) => Answer | undefined } = {}) {
  const spawned: { args: string[]; child: ChildProcess }[] = [];
  const execs: string[][] = [];
  const docker: Docker = {
    spawn(args) {
      const child = spawn(process.execPath, ['-e', builder(input.buildCode ?? 0)], { stdio: ['pipe', 'pipe', 'pipe'] });
      spawned.push({ args, child });
      return child;
    },
    async exec(args) {
      execs.push(args);
      const answer = input.answer?.(args) ?? { code: 0, stdout: 'sha256:abc\n' };
      return { code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
    },
  };
  return { docker, spawned, execs };
}

let server: Server | undefined;
afterEach(() => server?.close());

async function listen(docker: Docker, log: (line: string) => void = () => {}): Promise<string> {
  server = createRunner({
    docker,
    image: 'devailoop-agent-base',
    dataVolume: 'devailoop_worker-data',
    log,
    agentBaseDir: AGENT_BASE_CONTEXT,
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const recipeNow = () => agentBaseRecipe(agentBaseDockerfile(VALID));
const isSandboxCheck = (args: string[]) => args[0] === 'run' && args.includes('--entrypoint');
const isLabelRead = (args: string[]) => args[0] === 'image' && args[1] === 'inspect' && args[3]?.includes(RECIPE_LABEL);

describe('the runner ensuring devailoop-agent-base', () => {
  it('builds a candidate from its own recipe, checks the sandbox in it, then tags it and removes the old base', async () => {
    let tagged = false;
    const { docker, spawned, execs } = fakeDocker({
      answer: (args) => {
        if (isLabelRead(args)) return { code: 0, stdout: 'an-older-recipe\n' };
        if (args[0] === 'image' && args[1] === 'tag') tagged = true;
        // The name has the old id until it is tagged, the new one after.
        if (args[0] === 'image' && args[1] === 'inspect' && args[2] === '--format')
          return { code: 0, stdout: tagged ? 'sha256:new\n' : 'sha256:old\n' };
        return undefined;
      },
    });
    let log = '';
    const reply = await ensureBaseImageInContainer(await listen(docker), VALID, (text) => (log += text));

    expect(reply).toEqual({ built: true, image: 'devailoop-agent-base', skipped: false });
    const args = spawned[0]!.args;
    const candidate = args[args.indexOf('--tag') + 1]!;
    expect(candidate).toMatch(/^devailoop-agent-base:candidate-[0-9a-f]{12}$/);
    expect(args).toContain(`${RECIPE_LABEL}=${recipeNow()}`);
    expect(args).toContain('devailoop.agent-base.sdk-version=0.3.296');
    // The Dockerfile comes on stdin and the context is the runner's own folder.
    expect(args.slice(-3)).toEqual(['--file', '-', AGENT_BASE_CONTEXT]);
    expect(log).toContain('The sandbox check passed.');

    const order = (match: (a: string[]) => boolean) => execs.findIndex(match);
    expect(order(isSandboxCheck)).toBeGreaterThan(-1);
    expect(
      order((a) => a[0] === 'image' && a[1] === 'tag' && a[2] === candidate && a[3] === 'devailoop-agent-base'),
    ).toBeGreaterThan(order(isSandboxCheck));
    expect(execs).toContainEqual(['image', 'rm', 'sha256:old']);
    expect(execs).toContainEqual(['image', 'rm', candidate]);
    // Never by force.
    expect(execs.flat()).not.toContain('--force');
  });

  it('logs when the previous base cannot be removed', async () => {
    let tagged = false;
    const { docker } = fakeDocker({
      answer: (args) => {
        if (isLabelRead(args)) return { code: 0, stdout: 'an-older-recipe\n' };
        if (args[0] === 'image' && args[1] === 'tag') tagged = true;
        if (args[0] === 'image' && args[1] === 'inspect' && args[2] === '--format')
          return { code: 0, stdout: tagged ? 'sha256:new\n' : 'sha256:old\n' };
        if (args[0] === 'image' && args[1] === 'rm' && args[2] === 'sha256:old')
          return { code: 1, stderr: 'conflict: image is being used by a container\nmore\n' };
        return undefined;
      },
    });
    const lines: string[] = [];
    const reply = await ensureBaseImageInContainer(await listen(docker, (line) => lines.push(line)), VALID, () => {});
    expect(reply).toMatchObject({ built: true, skipped: false });
    expect(lines).toContain(
      'the previous devailoop-agent-base sha256:old was left: conflict: image is being used by a container',
    );
  });

  it('does not rebuild a base that already carries the recipe', async () => {
    const { docker, spawned } = fakeDocker({
      answer: (args) => (isLabelRead(args) ? { code: 0, stdout: `${recipeNow()}\n` } : undefined),
    });
    const reply = await ensureBaseImageInContainer(await listen(docker), VALID, () => {});
    expect(reply).toEqual({ built: true, image: 'devailoop-agent-base', skipped: true });
    expect(spawned).toHaveLength(0);
  });

  it('builds when there is no base yet, and again for another version', async () => {
    const missing = fakeDocker({
      answer: (args) => (isLabelRead(args) ? { code: 1, stderr: 'No such image' } : undefined),
    });
    expect(await ensureBaseImageInContainer(await listen(missing.docker), VALID, () => {})).toMatchObject({
      built: true,
    });
    expect(missing.spawned).toHaveLength(1);
    server?.close();

    const other = fakeDocker({
      answer: (args) => (isLabelRead(args) ? { code: 0, stdout: `${recipeNow()}\n` } : undefined),
    });
    const reply = await ensureBaseImageInContainer(
      await listen(other.docker),
      { ...VALID, sdkVersion: '0.3.297' },
      () => {},
    );
    expect(reply).toMatchObject({ built: true, skipped: false });
    expect(other.spawned).toHaveLength(1);
  });

  it('leaves the existing base alone when the build fails', async () => {
    const { docker, execs } = fakeDocker({
      buildCode: 1,
      answer: (args) => (isLabelRead(args) ? { code: 0, stdout: 'old\n' } : undefined),
    });
    const reply = await ensureBaseImageInContainer(await listen(docker), VALID, () => {});
    expect(reply).toMatchObject({ built: false, reason: expect.stringContaining('docker build failed (exit code 1)') });
    expect(execs.some((a) => a[0] === 'image' && a[1] === 'tag')).toBe(false);
  });

  it('does not tag an image the sandbox cannot work in', async () => {
    const { docker, execs } = fakeDocker({
      answer: (args) => {
        if (isLabelRead(args)) return { code: 1 };
        return isSandboxCheck(args) ? { code: 3, stderr: 'no bwrap' } : undefined;
      },
    });
    const reply = await ensureBaseImageInContainer(await listen(docker), VALID, () => {});
    expect(reply).toMatchObject({ built: false, reason: expect.stringContaining('sandbox cannot work in it') });
    expect(execs.some((a) => a[0] === 'image' && a[1] === 'tag')).toBe(false);
  });

  it('refuses a bad request without touching Docker', async () => {
    const { docker, execs, spawned } = fakeDocker();
    const reply = await ensureBaseImageInContainer(
      await listen(docker),
      { ...VALID, sdkVersion: '1.2.3\nRUN evil' },
      () => {},
    );
    expect(reply).toMatchObject({ built: false, reason: expect.stringContaining('sdkVersion') });
    expect(execs).toHaveLength(0);
    expect(spawned).toHaveLength(0);
  });

  it('says unreachable when the runner is not listening', async () => {
    expect(await ensureBaseImageInContainer('127.0.0.1:1', VALID, () => {})).toMatchObject({
      built: false,
      unreachable: true,
    });
  });
});

describe('candidates left by a base build that was cut off', () => {
  it('removes the candidate-* tags of the base at start, and no other tag, never by force', async () => {
    const { docker, execs } = fakeDocker({
      answer: (args) =>
        args[0] === 'image' && args[1] === 'ls'
          ? { code: 0, stdout: 'latest\ncandidate-aaaaaaaaaaaa\n<none>\ncandidate-bbbbbbbbbbbb\n' }
          : undefined,
    });
    expect(await removeLeftoverBaseCandidates(docker, 'devailoop-agent-base')).toBe(2);
    const removals = execs.filter((a) => a[1] === 'rm');
    expect(removals).toEqual([
      ['image', 'rm', 'devailoop-agent-base:candidate-aaaaaaaaaaaa'],
      ['image', 'rm', 'devailoop-agent-base:candidate-bbbbbbbbbbbb'],
    ]);
  });

  it('does nothing when there is no base image', async () => {
    const { docker, execs } = fakeDocker({ answer: () => ({ code: 1 }) });
    expect(await removeLeftoverBaseCandidates(docker, 'devailoop-agent-base')).toBe(0);
    expect(execs.some((a) => a[1] === 'rm')).toBe(false);
  });
});
