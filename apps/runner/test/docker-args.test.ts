import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SANDBOX_TMPDIR,
  SECCOMP_PROFILE,
  agentContainerSettings,
  commandRunArgs,
  allowedEnv,
  cwdProblem,
  dockerVersionProblem,
  localLlmCheckArgs,
  localLlmCheckProblem,
  sandboxCheckArgs,
  sessionRunArgs,
} from '../src/docker-args';

describe('the docker run for a session', () => {
  const args = sessionRunArgs({
    name: 'devailoop-session-1',
    project: 'SHOP',
    image: 'devailoop-agent-base',
    dataVolume: 'devailoop_worker-data',
    cwd: '/data/projects/SHOP/working-copies/SHOP-1',
    env: { LANG: 'C.UTF-8', ANTHROPIC_API_KEY: 'sk-ant-secret' },
    args: ['--output-format', 'stream-json', '--user', 'root'],
  });
  const beforeImage = args.slice(0, args.indexOf('devailoop-agent-base'));

  it('runs Claude Code in the image as the agent user, with stdin open', () => {
    expect(args.slice(0, 2)).toEqual(['run', '-i']);
    expect(args).not.toContain('--rm');
    expect(beforeImage.join(' ')).toContain('--user agent');
    expect(args.slice(args.indexOf('devailoop-agent-base') + 1, args.indexOf('devailoop-agent-base') + 2)).toEqual([
      'claude',
    ]);
  });

  it("puts the session's own arguments after the image, where they reach Claude Code and not docker", () => {
    expect(beforeImage).not.toContain('root');
    expect(args.slice(-4)).toEqual(['--output-format', 'stream-json', '--user', 'root']);
  });

  it('mounts only parts of the data volume, under /data, and narrows the system-call filter without lifting it', () => {
    const mounts = beforeImage.filter((arg, i) => beforeImage[i - 1] === '--mount');
    expect(beforeImage.filter((arg) => arg === '--mount' || arg === '--volume' || arg === '-v')).toHaveLength(
      mounts.length,
    );
    for (const mount of mounts)
      expect(mount).toMatch(/^type=(tmpfs|volume,source=devailoop_worker-data),target=\/data[,/]/);
    expect(
      mounts.filter((mount) => mount.startsWith('type=volume')).every((mount) => mount.includes(',volume-subpath=')),
    ).toBe(true);
    expect(beforeImage.join(' ')).toContain(`--security-opt seccomp=${SECCOMP_PROFILE}`);
    expect(beforeImage.join(' ')).not.toContain('unconfined');
    expect(beforeImage).not.toContain('--privileged');
    expect(beforeImage.join(' ')).not.toContain('docker.sock');
    expect(beforeImage.join(' ')).toContain('--workdir /data/projects/SHOP/working-copies/SHOP-1');
  });

  it('lets the container reach the machine Docker runs on, for a Local LLM there', () => {
    expect(beforeImage.join(' ')).toContain('--add-host host.docker.internal:host-gateway');
  });

  it('names the variables but never their values, which stay off the command line', () => {
    expect(beforeImage.join(' ')).toContain('--env LANG --env ANTHROPIC_API_KEY');
    expect(args.join(' ')).not.toContain('sk-ant-secret');
  });

  it("labels the session and the sandbox check with the runner's owner", () => {
    const check = sandboxCheckArgs({ name: 'c', image: 'i', owner: 'v' });
    expect(check.join(' ')).toContain('--label devailoop.session=1 --label devailoop.owner=v');
  });

  it('checks the sandbox in the image under the same conditions, with nothing of the data volume', () => {
    const check = sandboxCheckArgs({ name: 'c', image: 'devailoop-agent-base', owner: 'v' });
    expect(check.join(' ')).toContain('--user agent');
    expect(check.join(' ')).toContain(`seccomp=${SECCOMP_PROFILE}`);
    expect(check.join(' ')).toContain('bwrap');
    expect(check).not.toContain('--mount');
  });

  it("keeps the sandbox's sockets out of /tmp: TMPDIR is the runner's own, whatever the worker sends", () => {
    expect(SANDBOX_TMPDIR).toBe('/var/lib/devailoop-sandbox');
    const session = sessionRunArgs({
      name: 's',
      project: 'SHOP',
      image: 'devailoop-agent-base',
      dataVolume: 'v',
      cwd: '/data/projects/SHOP/working-copies/SHOP-1',
      env: allowedEnv({ HOME: '/data/agent-home', TMPDIR: '/tmp' }),
      args: [],
    });
    const check = sandboxCheckArgs({ name: 'c', image: 'devailoop-agent-base', owner: 'v' });
    for (const run of [session, check]) {
      const options = run.slice(0, run.indexOf('devailoop-agent-base'));
      const tmpdirs = options.filter((arg, i) => options[i - 1] === '--env' && arg.startsWith('TMPDIR'));
      expect(tmpdirs).toEqual(['TMPDIR=/var/lib/devailoop-sandbox']);
    }
    expect(session.slice(0, session.indexOf('devailoop-agent-base'))).not.toContain('TMPDIR');
  });

  it("checks that the image has the directory for the sandbox's sockets, saying how to fix it", () => {
    const script = sandboxCheckArgs({ name: 'c', image: 'devailoop-agent-base', owner: 'v' }).at(-1)!;
    expect(script).toContain('test -d /var/lib/devailoop-sandbox && test -w /var/lib/devailoop-sandbox');
    expect(script).toContain(
      "the Agent's image must create /var/lib/devailoop-sandbox, owned by agent; build it on devailoop-agent-base",
    );
    expect(script).toContain('exit 5');
  });
});

describe("a Project's own Agent home", () => {
  const home = (project: string) =>
    sessionRunArgs({
      name: 's',
      project,
      image: 'i',
      dataVolume: 'v',
      cwd: `/data/projects/${project}/working-copies/${project}-1`,
      env: { HOME: '/data/agent-home' },
      args: [],
    });

  it("hides the whole data volume under an empty read-only tmpfs, then mounts only the session's own parts on it, the working copy inside the home's mount", () => {
    const args = home('SHOP');
    const mounts = args.filter((arg, i) => args[i - 1] === '--mount');
    expect(mounts).toEqual([
      'type=tmpfs,target=/data,tmpfs-size=1m,tmpfs-mode=0555',
      'type=volume,source=v,target=/data/claude-configs/SHOP,volume-subpath=claude-configs/SHOP',
      'type=volume,source=v,target=/data/projects/SHOP,volume-subpath=projects/SHOP',
    ]);
  });

  it('gives a chat on a Ticket without a working copy only the empty directory it is answered from', () => {
    const args = sessionRunArgs({
      name: 's',
      project: 'SHOP',
      image: 'i',
      dataVolume: 'v',
      cwd: '/data/chat-without-working-copy',
      env: {},
      args: [],
    });
    const mounts = args.filter((arg, i) => args[i - 1] === '--mount');
    expect(mounts.at(-1)).toBe(
      'type=volume,source=v,target=/data/chat-without-working-copy,volume-subpath=chat-without-working-copy',
    );
    expect(mounts.join(' ')).not.toContain('working-copies');
    expect(mounts.join(' ')).not.toContain('mirrors');
  });

  it("sets HOME to the Project's home itself, so Project B's session never gets Project A's", () => {
    const homes = (args: string[]) => args.filter((arg, i) => args[i - 1] === '--env' && arg.startsWith('HOME='));
    expect(homes(home('SHOP'))).toEqual(['HOME=/data/projects/SHOP/home']);
    expect(homes(home('BLOG'))).toEqual(['HOME=/data/projects/BLOG/home']);
    expect(home('BLOG').join(' ')).not.toContain('SHOP');
  });

  it("gives a session only its own Project's Claude Code directory, and sets CLAUDE_CONFIG_DIR to it itself", () => {
    const configs = (args: string[]) =>
      args.filter((arg, i) => args[i - 1] === '--env' && arg.startsWith('CLAUDE_CONFIG_DIR'));
    expect(configs(home('SHOP'))).toEqual(['CLAUDE_CONFIG_DIR=/data/claude-configs/SHOP']);
    expect(configs(home('BLOG'))).toEqual(['CLAUDE_CONFIG_DIR=/data/claude-configs/BLOG']);
    const mounts = home('BLOG').filter((arg, i, args) => args[i - 1] === '--mount');
    expect(mounts).toContain(
      'type=volume,source=v,target=/data/claude-configs/BLOG,volume-subpath=claude-configs/BLOG',
    );
    expect(mounts.join(' ')).not.toMatch(/target=\/data\/claude[,/]/);
  });

  it('needs Docker Engine 26 or newer, which can mount part of a volume', () => {
    expect(dockerVersionProblem('26.1.4\n')).toBeNull();
    expect(dockerVersionProblem('28.0.0')).toBeNull();
    expect(dockerVersionProblem('25.0.5')).toMatch(/too old.*26 or newer/);
    expect(dockerVersionProblem('')).toMatch(/too old/);
  });
});

describe('what a session may be given', () => {
  it("keeps Claude Code's own variables and the credential, and drops the worker's secrets, HOME and CLAUDE_CONFIG_DIR", () => {
    expect(
      allowedEnv({
        HOME: '/data/agent-home',
        LANG: 'C.UTF-8',
        CLAUDE_CONFIG_DIR: '/data/claude',
        CLAUDE_CODE_OAUTH_TOKEN: 'tok',
        CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
        CLAUDE_AGENT_SDK_VERSION: '1',
        DATABASE_URL: 'postgres://devailoop:pw@postgres/devailoop',
        GITHUB_APP_PRIVATE_KEY: 'key',
        GITHUB_APP_PRIVATE_KEY_FILE: '/run/secrets/github-app.pem',
        PATH: '/usr/bin',
        LD_PRELOAD: '/tmp/x.so',
        ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434',
        ANTHROPIC_AUTH_TOKEN: 'local-llm',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3.5:9b',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3.5:9b',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3.5:9b',
        ANTHROPIC_MODEL: 'other',
      }),
    ).toEqual({
      ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434',
      ANTHROPIC_AUTH_TOKEN: 'local-llm',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3.5:9b',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3.5:9b',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3.5:9b',
      LANG: 'C.UTF-8',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      CLAUDE_AGENT_SDK_VERSION: '1',
    });
  });

  it("works only in a working copy of its own Project's, or in the chat's empty directory", () => {
    expect(cwdProblem('/data/projects/SHOP/working-copies/SHOP-1', 'SHOP')).toBeNull();
    expect(cwdProblem('/data/projects/SHOP/working-copies/SHOP-120', 'SHOP')).toBeNull();
    expect(cwdProblem('/data/chat-without-working-copy', 'SHOP')).toBeNull();
    expect(cwdProblem('/data/relevance-checks/SHOP/12', 'SHOP')).toBeNull();
    expect(cwdProblem('/data/relevance-checks/BLOG/12', 'SHOP')).toMatch(/not of SHOP/);
    expect(cwdProblem('/data/projects/BLOG/working-copies/BLOG-1', 'SHOP')).toMatch(
      /belongs to a Ticket of BLOG, not of SHOP/,
    );
    expect(cwdProblem('/data/projects/SHOPX/working-copies/SHOPX-1', 'SHOP')).not.toBeNull();
    expect(cwdProblem('/data/projects/SHOP/working-copies/BLOG-1', 'SHOP')).toMatch(
      /directory of SHOP, but belongs to a Ticket of BLOG/,
    );
    for (const cwd of [
      '/',
      '/data',
      '/data/claude',
      '/data/claude-configs/SHOP',
      '/data/mirrors',
      '/data/projects/SHOP',
      '/data/projects/SHOP/home',
      '/data/working-copies',
      '/data/working-copies/SHOP-1',
      '/data/projects/SHOP/working-copies',
      '/data/projects/SHOP/working-copies/SHOP-1/src',
      '/data/projects/SHOP/working-copies/SHOP-0',
      '/data/working-copies/shop-1',
      '/run/secrets',
      '/data/../run/secrets',
      '/data/projects/SHOP/working-copies/SHOP-1/..',
      'data/working-copies/SHOP-1',
      42,
    ]) {
      expect(cwdProblem(cwd, 'SHOP'), String(cwd)).not.toBeNull();
    }
  });
});

describe('the check of a Local LLM', () => {
  const llm = { host: 'host.docker.internal', port: 11434, model: 'qwen3.5:9b' };

  it('runs curl in a container set up as a session is, with the URL and body as arguments and no data volume', () => {
    const args = localLlmCheckArgs({ name: 'c', image: 'devailoop-agent-base', owner: 'v', ...llm });
    const joined = args.join(' ');
    expect(joined).toContain('--add-host host.docker.internal:host-gateway');
    expect(joined).toContain('--user agent');
    expect(args).not.toContain('--mount');
    expect(args.slice(-2)[0]).toBe('http://host.docker.internal:11434');
    expect(JSON.parse(args.at(-1)!)).toMatchObject({ model: 'qwen3.5:9b', max_tokens: 1 });
    expect(args[args.indexOf('-c') + 1]).not.toContain('qwen');
  });

  it('also asks /api/ps after a 2xx, with the marker the runner parses', () => {
    const script = localLlmCheckArgs({ name: 'c', image: 'i', owner: 'v', ...llm })[
      localLlmCheckArgs({ name: 'c', image: 'i', owner: 'v', ...llm }).indexOf('-c') + 1
    ]!;
    expect(script).toContain('"$1/api/ps"');
    expect(script).toContain('---api-ps---');
  });

  it('brackets an IPv6 address in the URL', () => {
    expect(localLlmCheckArgs({ name: 'c', image: 'i', owner: 'v', ...llm, host: '::1' }).at(-2)).toBe(
      'http://[::1]:11434',
    );
  });

  it('accepts a plain host, port and model, and refuses anything else', () => {
    expect(localLlmCheckProblem(llm)).toBeNull();
    expect(localLlmCheckProblem({ ...llm, host: '172.18.80.1' })).toBeNull();
    for (const host of ['', '-oops', 'a b', 'x;rm', 'a/b', 5])
      expect(localLlmCheckProblem({ ...llm, host })).toMatch(/host/);
    for (const port of [0, 70000, 1.5, '11434']) expect(localLlmCheckProblem({ ...llm, port })).toMatch(/port/);
    for (const model of ['', 'a\nb', 'x'.repeat(201), 3])
      expect(localLlmCheckProblem({ ...llm, model })).toMatch(/model/);
  });
});

describe('what a container may take from the host', () => {
  const cwd = '/data/projects/SHOP/working-copies/SHOP-1';
  const runs = (limits?: Parameters<typeof sandboxCheckArgs>[0]['limits']) => ({
    session: sessionRunArgs({
      name: 's',
      project: 'SHOP',
      image: 'img',
      dataVolume: 'v',
      cwd,
      env: {},
      args: [],
      limits,
    }),
    command: commandRunArgs({
      name: 'c',
      project: 'SHOP',
      image: 'img',
      dataVolume: 'v',
      cwd,
      script: 'true',
      allowedDomains: [],
      denyRead: [],
      limits,
    }),
    check: sandboxCheckArgs({ name: 'k', image: 'img', owner: 'v', limits }),
    llm: localLlmCheckArgs({ name: 'l', image: 'img', owner: 'v', host: 'h', port: 1, model: 'm', limits }),
  });
  const before = (args: string[]) => args.slice(0, args.indexOf('img')).join(' ');

  it('bounds memory, processes and CPU, drops every capability and forbids new privileges on every docker run', () => {
    for (const [kind, args] of Object.entries(runs())) {
      const options = before(args);
      expect(options, kind).toContain('--memory 8g --memory-swap 8g');
      expect(options, kind).toContain('--pids-limit 4096');
      expect(options, kind).toContain('--cpu-shares 512');
      expect(options, kind).not.toContain('--cpus');
      expect(options, kind).toContain('--cap-drop ALL');
      expect(options, kind).not.toContain('--cap-add');
      expect(options, kind).toContain('--security-opt no-new-privileges');
      expect(options, kind).toContain(`--security-opt seccomp=${SECCOMP_PROFILE}`);
    }
  });

  it('takes the limits it was given, and keeps unconfined as a fallback that changes nothing else', () => {
    const limits = {
      memory: '16g',
      pids: 8192,
      cpuShares: 1024,
      cpus: '4',
      seccomp: 'unconfined' as const,
      buildkitImage: 'x/y:1',
    };
    for (const [kind, args] of Object.entries(runs(limits))) {
      const options = before(args);
      expect(options, kind).toContain('--memory 16g --memory-swap 16g');
      expect(options, kind).toContain('--pids-limit 8192');
      expect(options, kind).toContain('--cpu-shares 1024 --cpus 4');
      expect(options, kind).toContain('--security-opt seccomp=unconfined');
      expect(options, kind).toContain('--cap-drop ALL');
      expect(options, kind).toContain('--security-opt no-new-privileges');
    }
  });

  it("checks the namespaces and mounts the Agent's sandbox makes", () => {
    expect(runs().check.at(-1)).toContain('--tmpfs /tmp --unshare-net --unshare-pid');
  });

  it("reads the settings from the runner's environment, with defaults, and refuses what it cannot use", () => {
    expect(agentContainerSettings({})).toEqual({
      settings: {
        memory: '8g',
        pids: 4096,
        cpuShares: 512,
        seccomp: 'devailoop',
        buildkitImage: 'moby/buildkit:buildx-stable-1',
      },
    });
    expect(
      agentContainerSettings({
        DEVAILOOP_AGENT_MEMORY: '512M',
        DEVAILOOP_AGENT_PIDS: '100',
        DEVAILOOP_AGENT_CPUS: '1.5',
        DEVAILOOP_AGENT_SECCOMP: 'unconfined',
        DEVAILOOP_BUILDKIT_IMAGE: 'registry.example/buildkit:1',
      }),
    ).toEqual({
      settings: {
        memory: '512m',
        pids: 100,
        cpuShares: 512,
        cpus: '1.5',
        seccomp: 'unconfined',
        buildkitImage: 'registry.example/buildkit:1',
      },
    });
    expect(agentContainerSettings({ DEVAILOOP_AGENT_MEMORY: '' })).toHaveProperty('settings');
    expect(agentContainerSettings({ DEVAILOOP_AGENT_MEMORY: 'lots' })).toEqual({
      problem: expect.stringContaining('DEVAILOOP_AGENT_MEMORY'),
    });
    expect(agentContainerSettings({ DEVAILOOP_AGENT_MEMORY: '0g' })).toHaveProperty('problem');
    expect(agentContainerSettings({ DEVAILOOP_AGENT_PIDS: '10' })).toEqual({
      problem: expect.stringContaining('DEVAILOOP_AGENT_PIDS'),
    });
    expect(agentContainerSettings({ DEVAILOOP_AGENT_CPUS: '0' })).toEqual({
      problem: expect.stringContaining('DEVAILOOP_AGENT_CPUS'),
    });
    expect(agentContainerSettings({ DEVAILOOP_AGENT_SECCOMP: 'off' })).toEqual({
      problem: expect.stringContaining('DEVAILOOP_AGENT_SECCOMP'),
    });
    expect(agentContainerSettings({ DEVAILOOP_BUILDKIT_IMAGE: '--privileged x' })).toEqual({
      problem: expect.stringContaining('DEVAILOOP_BUILDKIT_IMAGE'),
    });
  });
});

describe("the runner's seccomp profile", () => {
  const profile = JSON.parse(readFileSync(SECCOMP_PROFILE, 'utf8')) as {
    defaultAction: string;
    syscalls: { names: string[]; action: string; errnoRet?: number; args?: unknown[] }[];
  };
  const allowed = new Set(
    profile.syscalls.filter((rule) => rule.action === 'SCMP_ACT_ALLOW').flatMap((rule) => rule.names),
  );

  it('refuses what it does not name', () => {
    expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
  });

  it("allows the calls the Agent's sandbox (bubblewrap) makes, and ordinary programs", () => {
    for (const name of [
      'clone',
      'unshare',
      'setns',
      'mount',
      'umount2',
      'pivot_root',
      'execve',
      'openat',
      'read',
      'write',
      'mmap',
      'futex',
      'socket',
    ]) {
      expect(allowed.has(name), name).toBe(true);
    }
  });

  it('names only real calls, each once outside the rules that tell them apart by their arguments', () => {
    const names = profile.syscalls.flatMap((rule) => rule.names);
    expect(names.filter((name) => !/^[a-z_][a-z0-9_]*$/.test(name))).toEqual([]);
    const plain = profile.syscalls.filter((rule) => !rule.args).flatMap((rule) => rule.names);
    expect(plain.filter((name, i) => plain.indexOf(name) !== i)).toEqual([]);
    // A pasted block of text would show up as a jump in the count.
    expect(allowed.size).toBeGreaterThan(300);
    expect(allowed.size).toBeLessThan(450);
  });

  it('leaves clone3 to fail with ENOSYS, so libraries fall back to clone', () => {
    expect(profile.syscalls.find((rule) => rule.names.includes('clone3'))).toMatchObject({
      action: 'SCMP_ACT_ERRNO',
      errnoRet: 38,
    });
  });

  it('allows none of the calls that touch the kernel or the host itself', () => {
    for (const name of [
      'kexec_load',
      'kexec_file_load',
      'init_module',
      'finit_module',
      'delete_module',
      'bpf',
      'perf_event_open',
      'open_by_handle_at',
      'keyctl',
      'add_key',
      'request_key',
      'reboot',
      'swapon',
      'swapoff',
      'acct',
      'settimeofday',
      'clock_settime',
      'syslog',
      'iopl',
      'ioperm',
      'userfaultfd',
      'quotactl',
      'lookup_dcookie',
      'move_pages',
    ]) {
      expect(allowed.has(name), name).toBe(false);
    }
  });
});
