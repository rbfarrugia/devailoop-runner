import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { type Server, type Socket, createServer } from 'node:net';
import {
  AGENT_BASE_IMAGE,
  ENVIRONMENT_BUILD_TIME_LIMIT_MS,
  PROJECT_CODE_PATTERN,
  environmentImageTag,
  environmentProblem,
  environmentRepository,
  isEnvironmentImageOf,
  createLogger,
} from '@devailoop/runner-shared';
import {
  RECIPE_LABEL,
  agentBaseBuildArgs,
  agentBaseDockerfile,
  agentBaseRecipe,
  candidateBaseTag,
  ensureBaseImageProblem,
  AGENT_BASE_CONTEXT,
  type EnsureBaseImageInput,
} from './agent-base';
import {
  ENVIRONMENT_LABEL,
  INSTANCE_LABEL,
  SESSION_LABEL,
  allowedEnv,
  buildImageArgs,
  commandListsProblem,
  commandRunArgs,
  cwdProblem,
  localLlmCheckArgs,
  localLlmCheckProblem,
  sandboxCheckArgs,
  sessionRunArgs,
  type AgentContainerSettings,
  DEFAULT_CONTAINER_SETTINGS,
} from './docker-args';
import {
  type BaseExport,
  builderName,
  builderOomKills,
  builderRanOutOfMemory,
  ensureBuilder,
  exportBase,
} from './builder';
import { baseImageId, isOwnedBy, keepListProblem, otherInstances, ownersOf, pruneEnvironmentImages } from './images';
import {
  type BaseImageReply,
  type BindInstanceReply,
  type BuildImageReply,
  type EnsureBaseImageReply,
  Frame,
  FrameReader,
  type HelloReply,
  type LocalLlmCheckReply,
  OLLAMA_PS_MARKER,
  type PruneImagesReply,
  RUNNER_PROTOCOL_VERSION,
  type RunnerRequest,
  type SandboxCheckReply,
  contextLengthFromPs,
  encodeFrame,
} from './protocol';

/** How the runner reaches Docker. Replaced in tests. */
export interface Docker {
  /** Starts `docker` with these arguments, adding `env` to its environment. */
  spawn(args: string[], env: Record<string, string>): ChildProcess;
  /** Runs `docker` with these arguments to the end, or kills it after `timeoutMs` (two minutes unless given). */
  exec(args: string[], options?: { timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
}

export const realDocker: Docker = {
  spawn: (args, env) =>
    spawn('docker', args, {
      // Only what the docker command itself needs, and the session's own variables.
      env: {
        PATH: process.env.PATH ?? '',
        ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  exec: (args, options) =>
    new Promise((resolve) => {
      execFile(
        'docker',
        args,
        { timeout: options?.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          resolve({ code, stdout, stderr });
        },
      );
    }),
};

export interface RunnerOptions {
  docker: Docker;
  /** The image the Agent's sessions run in when their Project has no Environment image. */
  image: string;
  /** The Docker volume holding the worker's data, of which each session's container gets only its own parts. */
  dataVolume: string;
  /** What each container may take from the host, and its system-call filter. The defaults when not given. */
  limits?: AgentContainerSettings;
  log?: (line: string) => void;
  /** How long a build may take. */
  buildTimeLimitMs?: number;
  /** Exports the base image for a build; replaced in tests, which have no Docker to export from. */
  exportBase?: typeof exportBase;
  /** The folder holding the files agent-base copies; replaced in tests. */
  agentBaseDir?: string;
}

/** Whether a value is a Project's id, as the runner takes it from a request. */
const runnerLog = createLogger('runner');

const isProjectId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const containerName = (kind: string) => `devailoop-${kind}-${randomBytes(6).toString('hex')}`;

/** Removes the containers of sessions that were cut off, such as by a restart of the runner or the worker. */
export async function removeLeftoverContainers(docker: Docker, owner: string): Promise<number> {
  const listed = await docker.exec(['ps', '--all', '--quiet', '--no-trunc', '--filter', `label=${SESSION_LABEL}`]);
  // Full ids, as `container inspect` prints them below.
  const listedIds = listed.stdout
    .split('\n')
    .map((id) => id.trim())
    .filter(Boolean);
  // Only the runner's own, and those from before containers had an owner: another runner's are live.
  const owners = await ownersOf(docker, 'container', listedIds);
  const ids = listedIds.filter((id) => isOwnedBy(owners.get(id), owner));
  if (ids.length > 0) await docker.exec(['rm', '--force', ...ids]);
  return ids.length;
}

const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';

/**
 * The runner: the only part of DevAILoop that holds the Docker socket. It does only what a
 * request names, and builds every `docker` command itself, so a caller cannot widen what a
 * container may do.
 */
export function createRunner(options: RunnerOptions): Server {
  const log = options.log ?? ((line: string) => runnerLog.info(line));
  const limits = options.limits ?? DEFAULT_CONTAINER_SETTINGS;
  const buildTimeLimitMs = options.buildTimeLimitMs ?? ENVIRONMENT_BUILD_TIME_LIMIT_MS;
  const exportBaseImage = options.exportBase ?? exportBase;
  const builder = builderName(options.dataVolume);
  // The builder and the exported base are made by one build at a time.
  let preparing: Promise<unknown> = Promise.resolve();
  const prepareBuild = (): Promise<{ base: BaseExport } | { problem: string }> => {
    const prepared = preparing.then(async () => {
      const problem = await ensureBuilder(options.docker, builder, limits);
      if (problem) return { problem };
      const base = await exportBaseImage(options.docker, AGENT_BASE_IMAGE);
      return 'problem' in base ? { problem: base.problem } : { base };
    });
    preparing = prepared.catch(() => {});
    return prepared;
  };
  // The sandbox check is run once per image: an image with the same id gives the same answer.
  const sandboxChecks = new Map<string, Promise<SandboxCheckReply>>();
  // The instance the worker belongs to, once it has said; stamped on everything the runner makes.
  let instance: string | undefined;

  async function bindInstance(wanted: unknown): Promise<BindInstanceReply> {
    if (typeof wanted !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(wanted))
      return { ok: false, reason: 'the instance must be named by its id' };
    if (instance === wanted) return { ok: true };
    if (instance !== undefined) {
      return {
        ok: false,
        reason: `this runner already serves another DevAILoop instance (${instance}); each instance needs a runner of its own`,
      };
    }
    const others = await otherInstances(options.docker, wanted);
    if (others.length > 0) {
      return {
        ok: false,
        reason:
          `this Docker host is already used by another DevAILoop instance (${others.join(', ')}). Two instances would share the Environment image names and devailoop-agent-base. ` +
          "Run each instance on a Docker host of its own, or remove the other instance's sessions and Environment images (docker rm / docker rmi) if it is gone.",
      };
    }
    instance = wanted;
    return { ok: true };
  }

  async function checkSandbox(image: string): Promise<SandboxCheckReply> {
    const inspected = await options.docker.exec(['image', 'inspect', '--format', '{{.Id}}', image]);
    if (inspected.code !== 0) {
      return { available: false, reason: `The Agent's image ${image} is not there: ${firstLine(inspected.stderr)}` };
    }
    const id = inspected.stdout.trim();
    let check = sandboxChecks.get(id);
    if (!check) {
      check = options.docker
        .exec(sandboxCheckArgs({ name: containerName('check'), image, owner: options.dataVolume, instance, limits }))
        .then(({ code, stderr }): SandboxCheckReply => {
          if (code === 0) return { available: true };
          const said = firstLine(stderr) || `exit code ${code}`;
          return code === 3 || code === 5
            ? { available: false, reason: `In the Agent's image: ${said}` }
            : {
                available: false,
                reason:
                  `bubblewrap, which the sandbox is built on, cannot run in the Agent's image: ${said}.` +
                  (limits.apparmor === 'unconfined'
                    ? ''
                    : ` The Agent's containers run under the AppArmor profile ${limits.apparmor} (DEVAILOOP_AGENT_APPARMOR), which must allow the sandbox's mounts.`) +
                  (limits.seccomp === 'unconfined'
                    ? ''
                    : " If the host cannot use the runner's system-call profile, set DEVAILOOP_AGENT_SECCOMP=unconfined for the runner."),
              };
        });
      sandboxChecks.set(id, check);
      // A check that could not run at all is not remembered, so the next request tries again.
      check.catch(() => sandboxChecks.delete(id));
    }
    return check;
  }

  /** Asks a Local LLM for one token from a container like a session's, and says how it answered. */
  async function checkLocalLlm(
    request: Extract<RunnerRequest, { kind: 'check-local-llm' }>,
  ): Promise<LocalLlmCheckReply> {
    const started = Date.now();
    const { code, stdout, stderr } = await options.docker.exec(
      localLlmCheckArgs({
        name: containerName('llm-check'),
        image: options.image,
        owner: options.dataVolume,
        instance,
        ...request,
        limits,
      }),
    );
    if (code !== 0) {
      return { ok: false, kind: 'unreachable', detail: firstLine(stderr) || `curl ended with exit code ${code}` };
    }
    const marker = stdout.indexOf(`\n${OLLAMA_PS_MARKER}\n`);
    const answer = marker < 0 ? stdout : stdout.slice(0, marker);
    const split = answer.trimEnd().lastIndexOf('\n');
    const status = Number(answer.slice(split + 1));
    const body = split < 0 ? '' : answer.slice(0, split).trim();
    if (status >= 200 && status < 300) {
      const contextLength =
        marker < 0 ? undefined : contextLengthFromPs(stdout.slice(marker + OLLAMA_PS_MARKER.length + 2), request.model);
      return { ok: true, ms: Date.now() - started, ...(contextLength === undefined ? {} : { contextLength }) };
    }
    return { ok: false, kind: 'http', status: Number.isInteger(status) ? status : 0, body: body.slice(0, 500) };
  }

  /**
   * Why a session may not run in the image it asks for, or null. With none it runs in the
   * runner's own image; otherwise only in its own Project's Environment image, as this runner
   * named and labelled it, never in an image of anyone else's choosing.
   */
  async function imageProblem(
    request: Extract<RunnerRequest, { kind: 'session' | 'command' }>,
  ): Promise<string | null> {
    const { image, project, projectId } = request;
    if (image === undefined || image === null || image === options.image) return null;
    if (typeof image !== 'string') return 'the image must be named';
    if (!isProjectId(projectId)) return 'a session in an Environment image must name its Project by its id';
    if (!isEnvironmentImageOf(projectId, image))
      return `${image} is not an Environment image of ${project}, which the runner would have built`;
    const inspected = await options.docker.exec([
      'image',
      'inspect',
      '--format',
      `{{ index .Config.Labels "${ENVIRONMENT_LABEL}" }}\t{{ index .Config.Labels "${INSTANCE_LABEL}" }}`,
      image,
    ]);
    if (inspected.code !== 0) return `the image ${image} is not there: ${firstLine(inspected.stderr)}`;
    const [builtFor, builtIn = ''] = inspected.stdout.trim().split('\t');
    if (builtFor !== String(projectId)) return `the image ${image} was not built by the runner for ${project}`;
    // Another instance's image of the same name is not this instance's, whatever Project id it has there.
    if (instance && builtIn && builtIn !== '<no value>' && builtIn !== instance)
      return `the image ${image} was built for another DevAILoop instance`;
    return null;
  }

  async function serveSession(
    socket: Socket,
    request: Extract<RunnerRequest, { kind: 'session' }>,
    reader: { onFrame?: (type: number, payload: Buffer) => void },
  ) {
    // What the worker sends while the image is looked at is kept, and handed on once the container is started.
    const early: [number, Buffer][] = [];
    reader.onFrame = (type, payload) => void early.push([type, payload]);
    const refuse = (message: string) => socket.end(encodeFrame(Frame.error, JSON.stringify({ message })));

    // The Project decides the Agent's home and which working copies are its own, so a session without one has none to be given.
    if (typeof request.project !== 'string' || !PROJECT_CODE_PATTERN.test(request.project)) {
      return refuse('a session must name its Project by its code');
    }
    const problem = cwdProblem(request.cwd, request.project);
    if (problem || !Array.isArray(request.args) || request.args.some((arg) => typeof arg !== 'string')) {
      return refuse(problem ?? 'the arguments must be a list of strings');
    }
    let imageRefused: string | null;
    try {
      imageRefused = await imageProblem(request);
    } catch (error) {
      imageRefused = `the image could not be looked at: ${(error as Error).message}`;
    }
    if (imageRefused) return refuse(imageRefused);
    if (socket.destroyed) return;
    const image = request.image || options.image;

    const env = allowedEnv(request.env ?? {});
    const name = containerName('session');
    const child = options.docker.spawn(
      sessionRunArgs({
        name,
        project: request.project,
        image,
        dataVolume: options.dataVolume,
        instance,
        cwd: request.cwd,
        env,
        args: request.args,
        limits,
      }),
      env,
    );
    log(`started ${name} in ${request.cwd} (${image})`);
    let exited = false;
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      void options.docker.exec(['rm', '--force', name]);
    };

    child.stdout?.on('data', (chunk: Buffer) => socket.write(encodeFrame(Frame.stdout, chunk)));
    child.stderr?.on('data', (chunk: Buffer) => socket.write(encodeFrame(Frame.stderr, chunk)));
    child.stdin?.on('error', () => {});
    child.on('error', (error) => {
      if (exited) return;
      exited = true;
      socket.end(
        encodeFrame(Frame.error, JSON.stringify({ message: `docker could not be started: ${error.message}` })),
      );
    });
    // 'close', not 'exit': only then has everything the process wrote been passed on.
    child.on('close', (code, signal) => {
      if (exited) return;
      exited = true;
      log(`${name} ended (${signal ?? code})`);
      void finish(socket, name, removed, code, signal);
    });

    const onFrame = (type: number, payload: Buffer) => {
      if (type === Frame.stdin) child.stdin?.write(payload);
      else if (type === Frame.stdinEnd) child.stdin?.end();
      else if (type === Frame.kill) {
        // Stopping the docker command does not stop its container, so the container is told directly.
        const signal = payload.toString('utf8');
        if (signal === 'SIGKILL') remove();
        else void options.docker.exec(['kill', '--signal', /^SIG[A-Z0-9]+$/.test(signal) ? signal : 'SIGTERM', name]);
      }
    };
    for (const [type, payload] of early) onFrame(type, payload);
    reader.onFrame = onFrame;
    // The worker went away, or gave up on the session: its container goes too.
    const onClose = () => {
      if (!exited) {
        log(`${name}: the worker went away, removing the container`);
        remove();
      }
    };
    if (socket.destroyed) onClose();
    else socket.on('close', onClose);
  }

  /**
   * Ends a session or command: when its container ran out of memory the worker is told so on stderr, then the exit
   * frame is sent and the container (started without --rm, so that Docker still knew) is removed.
   */
  async function finish(
    socket: Socket,
    name: string,
    alreadyRemoved: boolean,
    code: number | null,
    signal: string | null,
  ) {
    if (!alreadyRemoved) {
      try {
        const inspected = await options.docker.exec(['container', 'inspect', '--format', '{{.State.OOMKilled}}', name]);
        if (inspected.code === 0 && inspected.stdout.trim() === 'true' && !socket.destroyed) {
          socket.write(
            encodeFrame(
              Frame.stderr,
              `The container ran out of memory at its limit of ${limits.memory} and was stopped. DEVAILOOP_AGENT_MEMORY on the runner raises the limit.\n`,
            ),
          );
        }
      } catch {
        // Whether it ran out of memory could not be asked: the exit is reported as it is.
      }
    }
    void options.docker.exec(['rm', '--force', name]);
    socket.end(encodeFrame(Frame.exit, JSON.stringify({ code, signal })));
  }

  /** Runs a Project's command in a container of its own, streaming the output, until it ends or its time is up. */
  async function serveCommand(
    socket: Socket,
    request: Extract<RunnerRequest, { kind: 'command' }>,
    reader: { onFrame?: (type: number, payload: Buffer) => void },
  ) {
    const early: [number, Buffer][] = [];
    reader.onFrame = (type, payload) => void early.push([type, payload]);
    const refuse = (message: string) => socket.end(encodeFrame(Frame.error, JSON.stringify({ message })));
    if (typeof request.project !== 'string' || !PROJECT_CODE_PATTERN.test(request.project))
      return refuse('a command must name its Project by its code');
    const problem = cwdProblem(request.cwd, request.project) ?? commandListsProblem(request);
    if (problem) return refuse(problem);
    let imageRefused: string | null;
    try {
      imageRefused = await imageProblem(request);
    } catch (error) {
      imageRefused = `the image could not be looked at: ${(error as Error).message}`;
    }
    if (imageRefused) return refuse(imageRefused);
    if (socket.destroyed) return;
    const image = request.image || options.image;
    const name = containerName('command');
    const child = options.docker.spawn(
      commandRunArgs({
        name,
        project: request.project,
        image,
        dataVolume: options.dataVolume,
        instance,
        limits,
        cwd: request.cwd,
        script: request.script,
        allowedDomains: request.allowedDomains,
        denyRead: request.denyRead,
      }),
      {},
    );
    log(`started ${name} in ${request.cwd} (${image})`);
    let exited = false;
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      void options.docker.exec(['rm', '--force', name]);
    };
    // Time is up: the container is removed, which ends the docker command and so the exit frame.
    const timer = setTimeout(() => {
      log(`${name}: out of time, removing the container`);
      remove();
    }, request.timeoutMs);
    child.stdin?.end();
    child.stdout?.on('data', (chunk: Buffer) => socket.write(encodeFrame(Frame.stdout, chunk)));
    child.stderr?.on('data', (chunk: Buffer) => socket.write(encodeFrame(Frame.stderr, chunk)));
    child.on('error', (error) => {
      if (exited) return;
      exited = true;
      clearTimeout(timer);
      socket.end(
        encodeFrame(Frame.error, JSON.stringify({ message: `docker could not be started: ${error.message}` })),
      );
    });
    child.on('close', (code, signal) => {
      if (exited) return;
      exited = true;
      clearTimeout(timer);
      log(`${name} ended (${signal ?? code})`);
      void finish(socket, name, removed, code, signal);
    });
    const onFrame = (type: number) => {
      if (type === Frame.kill) remove();
    };
    for (const [type] of early) onFrame(type);
    reader.onFrame = onFrame;
    const onClose = () => {
      if (!exited) {
        clearTimeout(timer);
        remove();
      }
    };
    if (socket.destroyed) onClose();
    else socket.on('close', onClose);
  }

  /**
   * Builds a Project's Environment image: to a tag of its own first, which becomes the
   * Project's image only once the sandbox check has passed in it, so a failed build or check
   * never replaces an image the Project's sessions use.
   */
  /**
   * Why a request that makes something may not be served, or null. Requests carry the instance
   * their worker belongs to, so a runner that restarted binds again by itself and never makes
   * anything without the instance label.
   */
  async function instanceProblem(request: RunnerRequest): Promise<string | null> {
    const sent = (request as { instance?: unknown }).instance;
    if (sent !== undefined) {
      const bound = await bindInstance(sent);
      return bound.ok ? null : bound.reason;
    }
    return instance === undefined
      ? 'the runner does not know which DevAILoop instance this worker belongs to; restart the worker'
      : null;
  }

  /** Runs one `docker buildx build`, with the Dockerfile on stdin and its output as log frames; killed on the time limit or when the worker goes away. */
  function runDockerBuild(socket: Socket, args: string[], dockerfile: string, say: (text: string) => void) {
    return new Promise<{ code: number | null; timedOut: boolean; gone: boolean }>((resolve) => {
      const child = options.docker.spawn(args, {});
      let timedOut = false;
      let gone = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, buildTimeLimitMs);
      // The worker went away: nobody is waiting for the image, so the build stops.
      const onClose = () => {
        gone = true;
        child.kill('SIGKILL');
      };
      socket.on('close', onClose);
      child.stdout?.on('data', (chunk: Buffer) => say(chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => say(chunk.toString('utf8')));
      child.stdin?.on('error', () => {});
      child.on('error', (error) => {
        say(`docker could not be started: ${error.message}\n`);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        socket.off('close', onClose);
        resolve({ code, timedOut, gone });
      });
      child.stdin?.end(dockerfile);
    });
  }

  /** Builds devailoop-agent-base from the runner's own recipe unless the image of that name already comes from it. */
  async function serveEnsureBase(socket: Socket, request: Extract<RunnerRequest, { kind: 'ensure-base-image' }>) {
    const problem = ensureBaseImageProblem(request);
    if (problem) return socket.end(encodeFrame(Frame.error, JSON.stringify({ message: problem })));
    const input = request as EnsureBaseImageInput;
    const say = (text: string) => {
      if (!socket.destroyed) socket.write(encodeFrame(Frame.log, text));
    };
    const finish = (reply: EnsureBaseImageReply) => {
      log(
        reply.built
          ? `${AGENT_BASE_IMAGE} ${reply.skipped ? 'is already' : 'was built for'} Claude Code ${input.sdkVersion}`
          : `building ${AGENT_BASE_IMAGE} failed: ${reply.reason}`,
      );
      socket.end(encodeFrame(Frame.reply, JSON.stringify(reply)));
    };
    const contextDir = options.agentBaseDir ?? AGENT_BASE_CONTEXT;
    const dockerfile = agentBaseDockerfile(input);
    const recipe = agentBaseRecipe(dockerfile, contextDir);
    const candidate = candidateBaseTag(randomBytes(6).toString('hex'));
    const untagCandidate = () => options.docker.exec(['image', 'rm', candidate]);

    // One base build at a time, and never while an Environment build is exporting the base.
    const work = preparing.then(async (): Promise<EnsureBaseImageReply | undefined> => {
      if (socket.destroyed) return;
      // Read now, every time: the image may have been removed or replaced since the last request.
      const current = await options.docker.exec([
        'image',
        'inspect',
        '--format',
        `{{index .Config.Labels "${RECIPE_LABEL}"}}`,
        AGENT_BASE_IMAGE,
      ]);
      if (current.code === 0 && current.stdout.trim() === recipe)
        return { built: true, image: AGENT_BASE_IMAGE, skipped: true };

      say(`Building ${AGENT_BASE_IMAGE} with Claude Code ${input.sdkVersion}...\n`);
      const before = await baseImageId(options.docker, AGENT_BASE_IMAGE);
      const builderProblem = await ensureBuilder(options.docker, builder, limits);
      if (builderProblem) {
        say(`${builderProblem}\n`);
        return { built: false, reason: builderProblem };
      }
      if (socket.destroyed) return;
      const killsBefore = await builderOomKills(options.docker, builder);
      try {
        const built = await runDockerBuild(
          socket,
          agentBaseBuildArgs({
            builder,
            tag: candidate,
            sdkVersion: input.sdkVersion,
            recipe,
            contextDir,
          }),
          dockerfile,
          say,
        );
        if (built.gone) return;
        if (built.code !== 0) {
          if (!built.timedOut && (await builderRanOutOfMemory(options.docker, builder, killsBefore))) {
            const reason = `The build ran out of memory at the builder's limit of ${limits.memory}. DEVAILOOP_AGENT_MEMORY on the runner raises the limit.`;
            say(`${reason}\n`);
            return { built: false, reason };
          }
          return {
            built: false,
            reason: built.timedOut
              ? `The build took longer than ${Math.round(buildTimeLimitMs / 60_000)} minutes and was stopped.`
              : `docker build failed${built.code === null ? '' : ` (exit code ${built.code})`}. The log shows why.`,
          };
        }
        say("\nChecking that the Agent's sandbox works in the new image...\n");
        let check: SandboxCheckReply;
        try {
          check = await checkSandbox(candidate);
        } catch (error) {
          check = { available: false, reason: (error as Error).message };
        }
        if (!check.available) {
          say(`The sandbox check failed: ${check.reason}\n`);
          return {
            built: false,
            reason: `The image built, but the Agent's sandbox cannot work in it. ${check.reason}`,
          };
        }
        say('The sandbox check passed.\n');
        const tagged = await options.docker.exec(['image', 'tag', candidate, AGENT_BASE_IMAGE]);
        if (tagged.code !== 0)
          return {
            built: false,
            reason: `The image could not be tagged ${AGENT_BASE_IMAGE}: ${firstLine(tagged.stderr)}`,
          };
        say(`Tagged ${AGENT_BASE_IMAGE}.\n`);
        // The image the name left is of no use any more. Never by force: one a container uses stays.
        const after = await baseImageId(options.docker, AGENT_BASE_IMAGE);
        if (before !== null && before !== after) {
          const removedOld = await options.docker.exec(['image', 'rm', before]);
          if (removedOld.code !== 0)
            log(`the previous ${AGENT_BASE_IMAGE} ${before} was left: ${firstLine(removedOld.stderr)}`);
        }
        return { built: true, image: AGENT_BASE_IMAGE, skipped: false };
      } finally {
        await untagCandidate();
      }
    });
    preparing = work.catch(() => {});
    const reply = await work;
    if (reply) finish(reply);
  }

  async function serveBuild(socket: Socket, request: Extract<RunnerRequest, { kind: 'build-image' }>) {
    const { projectId, dockerfile } = request;
    if (!isProjectId(projectId)) {
      return socket.end(
        encodeFrame(Frame.error, JSON.stringify({ message: 'the build must name a Project by its id' })),
      );
    }
    const problem = typeof dockerfile === 'string' ? environmentProblem(dockerfile) : 'the Dockerfile must be text';
    if (problem) return socket.end(encodeFrame(Frame.error, JSON.stringify({ message: problem })));

    const say = (text: string) => {
      if (!socket.destroyed) socket.write(encodeFrame(Frame.log, text));
    };
    const finish = (reply: BuildImageReply) => {
      log(`build for Project ${projectId} ${reply.built ? `made ${reply.image}` : `failed: ${reply.reason}`}`);
      socket.end(encodeFrame(Frame.reply, JSON.stringify(reply)));
    };
    const image = environmentImageTag(
      projectId,
      createHash('sha256').update(dockerfile, 'utf8').digest('hex').slice(0, 12),
    );
    const candidate = `${environmentRepository(projectId)}:candidate-${randomBytes(6).toString('hex')}`;
    const untagCandidate = () => options.docker.exec(['image', 'rm', candidate]);
    // A build is where tags are overwritten, so look again for another instance, which may have started since.
    const others = instance ? await otherInstances(options.docker, instance) : [];
    if (others.length > 0) {
      return socket.end(
        encodeFrame(
          Frame.error,
          JSON.stringify({
            message: `this Docker host is used by another DevAILoop instance (${others.join(', ')}), so no image is built here`,
          }),
        ),
      );
    }
    log(`building ${candidate} for Project ${projectId}`);
    say('Preparing the builder...\n');
    const prepared = await prepareBuild().catch((error: Error) => ({ problem: error.message }));
    if ('problem' in prepared) {
      say(`${prepared.problem}\n`);
      return finish({ built: false, reason: prepared.problem });
    }
    // The worker went away while the builder was made: nobody is waiting for the image.
    if (socket.destroyed) return;
    const { base } = prepared;

    const killsBefore = await builderOomKills(options.docker, builder);
    const built = await runDockerBuild(
      socket,
      buildImageArgs({ builder, base, tag: candidate, projectId, owner: options.dataVolume, instance }),
      dockerfile,
      say,
    );
    if (built.gone) {
      await untagCandidate();
      return;
    }
    if (built.code !== 0) {
      await untagCandidate();
      if (!built.timedOut && (await builderRanOutOfMemory(options.docker, builder, killsBefore))) {
        const reason = `The build ran out of memory at the builder's limit of ${limits.memory}. DEVAILOOP_AGENT_MEMORY on the runner raises the limit.`;
        say(`${reason}\n`);
        return finish({ built: false, reason });
      }
      return finish({
        built: false,
        reason: built.timedOut
          ? `The build took longer than ${Math.round(buildTimeLimitMs / 60_000)} minutes and was stopped.`
          : `docker build failed${built.code === null ? '' : ` (exit code ${built.code})`}. The log shows why.`,
      });
    }

    say("\nChecking that the Agent's sandbox works in the new image...\n");
    let check: SandboxCheckReply;
    try {
      check = await checkSandbox(candidate);
    } catch (error) {
      check = { available: false, reason: (error as Error).message };
    }
    if (!check.available) {
      say(`The sandbox check failed: ${check.reason}\n`);
      await untagCandidate();
      return finish({
        built: false,
        reason: `The image built, but the Agent's sandbox cannot work in it. ${check.reason}`,
      });
    }
    say('The sandbox check passed.\n');

    const tagged = await options.docker.exec(['image', 'tag', candidate, image]);
    await untagCandidate();
    if (tagged.code !== 0)
      return finish({ built: false, reason: `The image could not be tagged ${image}: ${firstLine(tagged.stderr)}` });
    say(`Tagged ${image}.\n`);
    finish({ built: true, image, baseImageId: base.id });
  }

  return createServer((socket) => {
    socket.on('error', () => {});
    const state: { onFrame?: (type: number, payload: Buffer) => void } = {};
    const reader = new FrameReader((type, payload) => {
      if (state.onFrame) return state.onFrame(type, payload);
      if (type !== Frame.request) {
        socket.destroy();
        return;
      }
      // Until the request is dealt with, nothing else from this connection is taken.
      state.onFrame = () => {};
      let request: RunnerRequest;
      try {
        request = JSON.parse(payload.toString('utf8')) as RunnerRequest;
      } catch {
        socket.end(encodeFrame(Frame.error, JSON.stringify({ message: 'the request is not JSON' })));
        return;
      }
      const failed = (error: Error) => {
        if (!socket.destroyed) socket.end(encodeFrame(Frame.error, JSON.stringify({ message: error.message })));
      };
      const makes =
        request.kind === 'session' ||
        request.kind === 'command' ||
        request.kind === 'build-image' ||
        request.kind === 'check-local-llm';
      if (makes) {
        // What the worker sends while the instance is looked at is held, then handed to whatever serves the request.
        const held: [number, Buffer][] = [];
        state.onFrame = (type, payload) => void held.push([type, payload]);
        instanceProblem(request).then((why) => {
          if (why) return void socket.end(encodeFrame(Frame.error, JSON.stringify({ message: why })));
          dispatch(request);
          for (const [type, payload] of held) state.onFrame?.(type, payload);
        }, failed);
      } else dispatch(request);

      function dispatch(request: RunnerRequest) {
        if (request.kind === 'session') {
          serveSession(socket, request, state).catch(failed);
        } else if (request.kind === 'command') {
          serveCommand(socket, request, state).catch(failed);
        } else if (request.kind === 'hello') {
          const reply: HelloReply = {
            protocolVersion: RUNNER_PROTOCOL_VERSION,
            runnerVersion: process.env.DEVAILOOP_VERSION?.trim() || 'dev',
          };
          socket.end(encodeFrame(Frame.reply, JSON.stringify(reply)));
        } else if (request.kind === 'check-sandbox') {
          checkSandbox(options.image).then(
            (reply) => socket.end(encodeFrame(Frame.reply, JSON.stringify(reply))),
            failed,
          );
        } else if (request.kind === 'check-local-llm') {
          const problem = localLlmCheckProblem(request);
          if (problem) return void socket.end(encodeFrame(Frame.error, JSON.stringify({ message: problem })));
          checkLocalLlm(request).then((reply) => socket.end(encodeFrame(Frame.reply, JSON.stringify(reply))), failed);
        } else if (request.kind === 'build-image') {
          serveBuild(socket, request).catch(failed);
        } else if (request.kind === 'prune-images') {
          const problem = keepListProblem(request.keep);
          if (problem) return void socket.end(encodeFrame(Frame.error, JSON.stringify({ message: problem })));
          pruneEnvironmentImages(options.docker, request.keep, options.dataVolume, log).then(
            (reply: PruneImagesReply) => socket.end(encodeFrame(Frame.reply, JSON.stringify(reply))),
            failed,
          );
        } else if (request.kind === 'bind-instance') {
          bindInstance(request.instance).then(
            (reply) => socket.end(encodeFrame(Frame.reply, JSON.stringify(reply))),
            failed,
          );
        } else if (request.kind === 'ensure-base-image') {
          serveEnsureBase(socket, request).catch(failed);
        } else if (request.kind === 'base-image') {
          baseImageId(options.docker, AGENT_BASE_IMAGE).then(
            (id) => socket.end(encodeFrame(Frame.reply, JSON.stringify({ id } satisfies BaseImageReply))),
            failed,
          );
        } else {
          socket.end(encodeFrame(Frame.error, JSON.stringify({ message: 'the runner does not do that' })));
        }
      }
    });
    socket.on('data', (chunk: Buffer) => {
      try {
        reader.push(chunk);
      } catch {
        socket.destroy();
      }
    });
  });
}
