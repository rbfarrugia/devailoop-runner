import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { basename } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import {
  type BaseImageReply,
  type BindInstanceReply,
  type BuildImageReply,
  type EnsureBaseImageReply,
  Frame,
  FrameReader,
  type HelloReply,
  type LocalLlmCheckReply,
  type PruneImagesReply,
  type RunnerRequest,
  type SandboxCheckReply,
  connectionOptions,
  encodeFrame,
} from './protocol';

export type {
  BuildImageReply,
  EnsureBaseImageReply,
  HelloReply,
  LocalLlmCheckReply,
  PruneImagesReply,
  SandboxCheckReply,
} from './protocol';
export { RUNNER_PROTOCOL_VERSION, contextLengthFromPs } from './protocol';
export { SANDBOX_TMPDIR } from './docker-args';

/** What the Agent SDK asks to be started: the same shape as its `SpawnOptions`. */
/** The instance each runner was told its worker belongs to, sent with every request so a runner that restarted learns it again. */
const instances = new Map<string, string>();
const requestFrame = (address: string, request: RunnerRequest) =>
  encodeFrame(Frame.request, JSON.stringify({ instance: instances.get(address), ...request }));

export interface SessionSpawn {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

/** JavaScript runtimes the SDK may name as the command, with Claude Code's script as the first argument. */
const RUNTIMES = new Set(['node', 'bun', 'deno', 'node.exe', 'bun.exe', 'deno.exe']);

/**
 * Claude Code running in a container the runner started, made to look like a local child
 * process: what the Agent SDK's `spawnClaudeCodeProcess` must return.
 */
export class ContainerProcess extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private ended = false;
  private readonly socket;

  /**
   * `project` is the session's Project, whose Agent home the runner gives it. `image` is the
   * Project's Environment image, or null for the runner's own image; the runner refuses one it
   * did not build for that Project.
   */
  constructor(
    address: string,
    spawned: SessionSpawn,
    onStderr: ((text: string) => void) | undefined,
    target: { project: string; projectId: number; image?: string | null },
  ) {
    super();
    if (!spawned.cwd) throw new Error('A session in a container needs a working directory.');
    // Claude Code in the image is `claude`; only its arguments are passed on.
    const args = RUNTIMES.has(basename(spawned.command)) ? spawned.args.slice(1) : spawned.args;
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(spawned.env)) if (value !== undefined) env[name] = value;
    const request: RunnerRequest = { kind: 'session', cwd: spawned.cwd, args, env, ...target };

    const socket = connect(connectionOptions(address));
    this.socket = socket;
    socket.write(requestFrame(address, request));
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        if (socket.destroyed) return done();
        socket.write(encodeFrame(Frame.stdin, chunk), () => done());
      },
      final: (done) => {
        if (!socket.destroyed) socket.write(encodeFrame(Frame.stdinEnd));
        done();
      },
    });

    const reader = new FrameReader((type, payload) => {
      if (type === Frame.stdout) this.stdout.write(payload);
      else if (type === Frame.stderr) onStderr?.(payload.toString('utf8'));
      else if (type === Frame.exit) {
        const { code, signal } = JSON.parse(payload.toString('utf8')) as {
          code: number | null;
          signal: NodeJS.Signals | null;
        };
        this.finish(code, signal);
      } else if (type === Frame.error) {
        const { message } = JSON.parse(payload.toString('utf8')) as { message: string };
        this.fail(new Error(`The runner refused the session: ${message}`));
      }
    });
    socket.on('data', (chunk: Buffer) => {
      try {
        reader.push(chunk);
      } catch (error) {
        this.fail(error as Error);
      }
    });
    socket.on('error', (error) => this.fail(new Error(`The runner could not be reached: ${error.message}`)));
    socket.on('close', () => this.finish(this.exitCode, this.signalCode ?? 'SIGKILL'));
    // The SDK aborts this only after its own graceful close has had its chance.
    spawned.signal.addEventListener('abort', () => this.kill('SIGTERM'), { once: true });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.ended) return false;
    this.killed = true;
    if (!this.socket.destroyed) this.socket.write(encodeFrame(Frame.kill, signal));
    return true;
  }

  private fail(error: Error) {
    if (this.ended) return;
    if (this.listenerCount('error') > 0) this.emit('error', error);
    this.finish(1, null);
  }

  private finish(code: number | null, signal: NodeJS.Signals | null) {
    if (this.ended) return;
    this.ended = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.socket.end();
    this.emit('exit', code, signal);
  }
}

/** The runner could not be asked at all: nothing listens at its address, or it never answered. */
class RunnerUnreachable extends Error {}

/** Asks the runner one thing and waits for its answer. */
function ask<T>(address: string, request: RunnerRequest, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = connect(connectionOptions(address));
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new RunnerUnreachable(`The runner did not answer within ${timeoutMs / 1000} seconds.`));
    }, timeoutMs);
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      action();
    };
    const reader = new FrameReader((type, payload) => {
      const body = JSON.parse(payload.toString('utf8'));
      if (type === Frame.reply) settle(() => resolve(body as T));
      else if (type === Frame.error)
        settle(() => reject(new Error(`The runner refused: ${(body as { message: string }).message}`)));
    });
    socket.on('data', (chunk: Buffer) => reader.push(chunk));
    socket.on('error', (error) =>
      settle(() => reject(new RunnerUnreachable(`The runner could not be reached: ${error.message}`))),
    );
    socket.on('close', () =>
      settle(() => reject(new RunnerUnreachable('The runner closed the connection without answering.'))),
    );
    socket.write(requestFrame(address, request));
  });
}

/** What the runner said to `hello`, or why there is no answer: it could not be reached, or it predates `hello`. */
export type RunnerHello = HelloReply | { unreachable: true; reason: string } | { unsupported: true };

/** Asks the runner which protocol it speaks and which version of its image it is. Never throws. */
export async function helloInContainer(address: string): Promise<RunnerHello> {
  try {
    const reply = await ask<Partial<HelloReply>>(address, { kind: 'hello' }, 15_000);
    if (typeof reply.protocolVersion !== 'number') return { unsupported: true };
    return { protocolVersion: reply.protocolVersion, runnerVersion: String(reply.runnerVersion ?? 'unknown') };
  } catch (error) {
    if (error instanceof RunnerUnreachable) return { unreachable: true, reason: error.message };
    if ((error as Error).message.includes('the runner does not do that')) return { unsupported: true };
    return { unreachable: true, reason: (error as Error).message };
  }
}

/** The runner's answer to the sandbox check, or `unreachable` when the runner itself could not be asked. */
export type RunnerSandboxCheck = SandboxCheckReply | { available: false; reason: string; unreachable: true };

/** Whether the Agent's sandbox can work in the Agent's image, as the runner finds it. */
export async function checkSandboxInContainer(address: string): Promise<RunnerSandboxCheck> {
  try {
    return await ask<SandboxCheckReply>(address, { kind: 'check-sandbox' }, 120_000);
  } catch (error) {
    if (error instanceof RunnerUnreachable) return { available: false, reason: error.message, unreachable: true };
    return { available: false, reason: (error as Error).message };
  }
}

/**
 * Has the runner ask a Local LLM for one token from a container like a session's, so the answer
 * is what a session would get. Throws when the runner could not be asked or refused.
 */
export function checkLocalLlmInContainer(
  address: string,
  llm: { host: string; port: number; model: string },
): Promise<LocalLlmCheckReply> {
  return ask<LocalLlmCheckReply>(address, { kind: 'check-local-llm', ...llm }, 240_000);
}

/**
 * Has the runner remove the Environment images it built that are not in `keep`, by Project's
 * code: every image of a Project not listed. Throws when the runner could not do it.
 */
export function pruneImagesInContainer(address: string, keep: Record<string, string[]>): Promise<PruneImagesReply> {
  return ask<PruneImagesReply>(address, { kind: 'prune-images', keep }, 120_000);
}

/** Tells the runner which instance the worker belongs to; the reply says why when it will not serve it. Throws when the runner could not be asked. */
export async function bindInstanceInContainer(address: string, instance: string): Promise<BindInstanceReply> {
  const reply = await ask<BindInstanceReply>(address, { kind: 'bind-instance', instance }, 30_000);
  if (reply.ok) instances.set(address, instance);
  return reply;
}

/** The id of devailoop-agent-base as the runner finds it, or null when it is not there. Throws when the runner could not be asked. */
export async function baseImageIdInContainer(address: string): Promise<string | null> {
  return (await ask<BaseImageReply>(address, { kind: 'base-image' }, 30_000)).id;
}

/**
 * Has the runner make sure devailoop-agent-base is built with Claude Code at this version, handing
 * over the build's output as it comes. Answers why not when the runner could not be asked or refused.
 * `unreachable` is set when the runner could not be connected to, `unsupported` when it does not know the request.
 */
export function ensureBaseImageInContainer(
  address: string,
  input: { sdkVersion: string; integrity: Record<string, string> },
  onLog: (text: string) => void,
): Promise<EnsureBaseImageReply & { unreachable?: true; unsupported?: true }> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect(connectionOptions(address));
    const settle = (reply: EnsureBaseImageReply & { unreachable?: true; unsupported?: true }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reply);
    };
    const reader = new FrameReader((type, payload) => {
      if (type === Frame.log) onLog(payload.toString('utf8'));
      else if (type === Frame.reply) settle(JSON.parse(payload.toString('utf8')) as EnsureBaseImageReply);
      else if (type === Frame.error) {
        const { message } = JSON.parse(payload.toString('utf8')) as { message: string };
        settle({
          built: false,
          reason: `The runner refused the request: ${message}`,
          ...(message === 'the runner does not do that' ? { unsupported: true as const } : {}),
        });
      }
    });
    socket.on('data', (chunk: Buffer) => {
      try {
        reader.push(chunk);
      } catch (error) {
        settle({ built: false, reason: `The runner's answer could not be read: ${(error as Error).message}` });
      }
    });
    socket.on('error', (error) =>
      settle({ built: false, reason: `The runner could not be reached: ${error.message}`, unreachable: true }),
    );
    socket.on('close', () =>
      settle({ built: false, reason: 'The runner closed the connection before the build finished.' }),
    );
    socket.write(requestFrame(address, { kind: 'ensure-base-image', ...input }));
  });
}

/**
 * Has the runner build a Project's Environment image and check the sandbox in it, handing over
 * its output as it comes. Answers why not when the runner could not be asked or refused.
 * Aborting the signal gives up on the build, which the runner then stops.
 */
export function buildImageInContainer(
  address: string,
  input: { projectId: number; dockerfile: string },
  onLog: (text: string) => void,
  signal?: AbortSignal,
): Promise<BuildImageReply> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect(connectionOptions(address));
    const settle = (reply: BuildImageReply) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      socket.end();
      resolve(reply);
    };
    const onAbort = () => {
      socket.destroy();
      settle({ built: false, reason: 'The build was given up on.' });
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const reader = new FrameReader((type, payload) => {
      if (type === Frame.log) onLog(payload.toString('utf8'));
      else if (type === Frame.reply) settle(JSON.parse(payload.toString('utf8')) as BuildImageReply);
      else if (type === Frame.error) {
        const { message } = JSON.parse(payload.toString('utf8')) as { message: string };
        settle({ built: false, reason: `The runner refused the build: ${message}` });
      }
    });
    socket.on('data', (chunk: Buffer) => {
      try {
        reader.push(chunk);
      } catch (error) {
        settle({ built: false, reason: `The runner's answer could not be read: ${(error as Error).message}` });
      }
    });
    socket.on('error', (error) =>
      settle({ built: false, reason: `The runner could not be reached: ${error.message}` }),
    );
    socket.on('close', () =>
      settle({ built: false, reason: 'The runner closed the connection before the build finished.' }),
    );
    const request: RunnerRequest = { kind: 'build-image', ...input };
    socket.write(requestFrame(address, request));
  });
}

/** How a command run by the runner ended: with an exit code, or out of time, or not at all. */
export type CommandResult =
  { kind: 'finished'; exitCode: number } | { kind: 'timed_out' } | { kind: 'failed'; reason: string };

/**
 * Has the runner run a script in a Ticket's working copy, in the Project's image, under the
 * sandbox's rules, handing over its output (stdout and stderr together) as it comes. Aborting
 * the signal, or the time running out, kills it.
 */
export function runCommandInContainer(
  address: string,
  input: Omit<Extract<RunnerRequest, { kind: 'command' }>, 'kind'>,
  onOutput: (text: string, stream: 'stdout' | 'stderr') => void,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const socket = connect(connectionOptions(address));
    const settle = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.end();
      resolve(result);
    };
    // The runner enforces the time too; this one covers a runner that has gone quiet.
    const timer = setTimeout(() => {
      timedOut = true;
      socket.write(encodeFrame(Frame.kill, 'SIGKILL'));
      setTimeout(() => settle({ kind: 'timed_out' }), 10_000).unref();
    }, input.timeoutMs + 5_000);
    const onAbort = () => {
      socket.write(encodeFrame(Frame.kill, 'SIGKILL'));
      settle({ kind: 'failed', reason: 'The command was given up on.' });
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const started = Date.now();
    const reader = new FrameReader((type, payload) => {
      if (type === Frame.stdout || type === Frame.stderr)
        onOutput(payload.toString('utf8'), type === Frame.stdout ? 'stdout' : 'stderr');
      else if (type === Frame.exit) {
        const { code } = JSON.parse(payload.toString('utf8')) as { code: number | null; signal: string | null };
        // The runner removes the container when time is up, so the exit is a kill and not a code.
        if (timedOut || code === null || (code === 137 && Date.now() - started >= input.timeoutMs))
          settle({ kind: 'timed_out' });
        else settle({ kind: 'finished', exitCode: code });
      } else if (type === Frame.error) {
        const { message } = JSON.parse(payload.toString('utf8')) as { message: string };
        settle({ kind: 'failed', reason: `The runner refused the command: ${message}` });
      }
    });
    socket.on('data', (chunk: Buffer) => {
      try {
        reader.push(chunk);
      } catch (error) {
        settle({ kind: 'failed', reason: `The runner's answer could not be read: ${(error as Error).message}` });
      }
    });
    socket.on('error', (error) =>
      settle({ kind: 'failed', reason: `The runner could not be reached: ${error.message}` }),
    );
    socket.on('close', () =>
      settle({ kind: 'failed', reason: 'The runner closed the connection before the command ended.' }),
    );
    const request: RunnerRequest = { kind: 'command', ...input };
    socket.write(requestFrame(address, request));
  });
}
