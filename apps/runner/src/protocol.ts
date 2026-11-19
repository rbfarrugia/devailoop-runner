/**
 * What the worker and the runner say to each other over one connection: the worker's request
 * first, then, for a session, the Claude Code process's input, output and end, each a frame of
 * one type byte, a four-byte length and the payload.
 */

export const Frame = {
  /** Worker to runner, first and once: the request, as JSON. */
  request: 0x01,
  /** Worker to runner: bytes for the process's stdin. */
  stdin: 0x02,
  /** Worker to runner: the process's stdin is closed. */
  stdinEnd: 0x03,
  /** Worker to runner: stop the process, with the signal's name. */
  kill: 0x04,
  /** Runner to worker: bytes the process wrote to stdout. */
  stdout: 0x10,
  /** Runner to worker: bytes the process wrote to stderr. */
  stderr: 0x11,
  /** Runner to worker, last: how the process ended, as JSON `{ code, signal }`. */
  exit: 0x12,
  /** Runner to worker, last: the answer to a request that is not a session, as JSON. */
  reply: 0x13,
  /** Runner to worker, last: why the request was refused, as JSON `{ message }`. */
  error: 0x14,
  /** Runner to worker, during a build: output of the build and of the sandbox check, as text. */
  log: 0x15,
} as const;

/**
 * The version of what the worker and the runner say to each other, counted from 1. The runner is
 * the one component customers update by hand, so the protocol is additive: a new request adds 1
 * here, and the worker raises the minimum it needs (`MIN_RUNNER_PROTOCOL_VERSION` in the worker's
 * runner-check.ts) only when it starts sending a request that older runners do not know.
 * Version 1 is every request below, `hello` included.
 */
export const RUNNER_PROTOCOL_VERSION = 1;

export type FrameType = (typeof Frame)[keyof typeof Frame];

/** A request the runner accepts. There is nothing else it will do. */
export type RunnerRequest =
  /** Asked first by the worker: which protocol the runner speaks and which published version of the runner image it is. */
  | { kind: 'hello' }
  /**
   * Run Claude Code for one session of a Project, with these arguments, in the runner's own
   * image or, given `image`, in that Project's Environment image, which the runner must have built.
   * Its home is the Project's own, which the runner chooses.
   */
  | {
      kind: 'session';
      cwd: string;
      args: string[];
      env: Record<string, string>;
      project: string;
      projectId?: number;
      image?: string | null;
    }
  /**
   * Run a shell script (a Project's Test command) in a working copy of `project`, in its
   * Environment image, under `srt` with the session's sandbox rules and no credentials. Output
   * comes as stdout and stderr frames, then an exit frame; the runner kills it after `timeoutMs`.
   */
  | {
      kind: 'command';
      cwd: string;
      script: string;
      timeoutMs: number;
      project: string;
      projectId?: number;
      image?: string | null;
      allowedDomains: string[];
      denyRead: string[];
    }
  /** Whether the Agent's sandbox can work in the Agent's image. */
  | { kind: 'check-sandbox' }
  /**
   * Build a Project's Environment image from this Dockerfile, with no build context, and check
   * the sandbox in it. The runner chooses the tag and every option; its output comes as log frames.
   */
  | { kind: 'build-image'; projectId: number; dockerfile: string }
  /**
   * Remove the Environment images the runner built that are not listed here, by Project: all of
   * a Project not listed (the keys are Project ids). Never one a session uses, and never a build's candidate.
   */
  | { kind: 'prune-images'; keep: Record<string, string[]> }
  /** The id of devailoop-agent-base, which every Environment builds on. */
  | { kind: 'base-image' }
  /**
   * Make sure devailoop-agent-base is built from the runner's own recipe, with Claude Code at this
   * version, installed from npm and checked against the integrity of each platform's package
   * (`linux-x64`, `linux-arm64`). Does nothing when the base already comes from that recipe; its
   * output comes as log frames.
   */
  | { kind: 'ensure-base-image'; sdkVersion: string; integrity: Record<string, string> }
  /**
   * Tells the runner which DevAILoop instance its worker belongs to. The runner then labels what it
   * makes with it, and refuses when another instance's containers or images are on this Docker host.
   */
  | { kind: 'bind-instance'; instance: string }
  /**
   * Whether a Local LLM answers a Messages API request from a container started as a session's is
   * (same network path), given as the session would reach it: loopback is already host.docker.internal.
   */
  | { kind: 'check-local-llm'; host: string; port: number; model: string };

/** How a Local LLM answered the check: it did, or it could not be reached, or it refused with an HTTP status. */
export type LocalLlmCheckReply =
  | { ok: true; ms: number; contextLength?: number }
  | { ok: false; kind: 'unreachable'; detail: string }
  | { ok: false; kind: 'http'; status: number; body: string };

/** The line the Local LLM check prints between the Messages API's answer and Ollama's `/api/ps`. */
export const OLLAMA_PS_MARKER = '---api-ps---';

/**
 * The context window Ollama's `/api/ps` reports for a model, or undefined when the body is not
 * JSON, does not list the model (by `name` or `model`, `:latest` implied) or has no usable number.
 */
export function contextLengthFromPs(body: string, model: string): number | undefined {
  let models: unknown;
  try {
    models = (JSON.parse(body) as { models?: unknown }).models;
  } catch {
    return undefined;
  }
  if (!Array.isArray(models)) return undefined;
  const tagged = (name: string) => (name.includes(':') ? name : `${name}:latest`);
  const wanted = tagged(model);
  for (const entry of models as Record<string, unknown>[]) {
    if (!entry || typeof entry !== 'object') continue;
    const names = [entry.name, entry.model].filter((n): n is string => typeof n === 'string');
    const length = entry.context_length;
    if (names.some((n) => tagged(n) === wanted) && typeof length === 'number' && Number.isFinite(length) && length > 0)
      return length;
  }
  return undefined;
}

export type SandboxCheckReply = { available: true } | { available: false; reason: string };

/** How a build ended: the new image's tag and the id of the base it was built on, or why there is none. */
export type BuildImageReply =
  { built: true; image: string; baseImageId: string | null } | { built: false; reason: string };

/** The runner's answer to `hello`: `runnerVersion` is the image's published version (`DEVAILOOP_VERSION`), `dev` when built from source. */
export interface HelloReply {
  protocolVersion: number;
  runnerVersion: string;
}

/** Whether the runner took the instance, or why it will not serve it. */
export type BindInstanceReply = { ok: true } | { ok: false; reason: string };

/** The images a cleanup removed, by name, or by id for one that had lost its tag. */
export type PruneImagesReply = { removed: string[] };

/** How ensuring devailoop-agent-base ended: it is there (`skipped` when it already was), or why it is not. */
export type EnsureBaseImageReply = { built: true; image: string; skipped: boolean } | { built: false; reason: string };

/** The id of devailoop-agent-base, or null when it is not there. */
export type BaseImageReply = { id: string | null };

export function encodeFrame(type: FrameType, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

/** Frames bigger than this are refused: nothing legitimate comes near it. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** Turns a stream of bytes back into frames, however they were split on the way. */
export class FrameReader {
  private pending: Buffer = Buffer.alloc(0);

  constructor(private readonly onFrame: (type: number, payload: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= 5) {
      const length = this.pending.readUInt32BE(1);
      if (length > MAX_FRAME_BYTES) throw new Error(`a frame of ${length} bytes is too big`);
      if (this.pending.length < 5 + length) return;
      const type = this.pending.readUInt8(0);
      const payload = this.pending.subarray(5, 5 + length);
      this.pending = this.pending.subarray(5 + length);
      this.onFrame(type, payload);
    }
  }
}

/** Where the runner listens: `host:port`, or the path of a Unix socket. */
export function connectionOptions(address: string): { host: string; port: number } | { path: string } {
  if (address.startsWith('/')) return { path: address };
  const match = /^(.+):(\d+)$/.exec(address);
  if (!match)
    throw new Error(`"${address}" is not a runner address: write it as host:port or as the path of a socket.`);
  return { host: match[1]!, port: Number(match[2]) };
}
