import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentContainerSettings } from './docker-args';
import { baseImageId } from './images';
import type { Docker } from './server';

const run = promisify(execFile);

/** Pulling BuildKit the first time can take longer than a `docker` command usually may. */
const PREPARE_TIMEOUT_MS = 10 * 60 * 1000;

const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';

/** The line buildx says its error in: the last `ERROR:` line, else the last line, since BuildKit's progress comes first. */
function errorLine(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const error = lines.findLast((line) => line.startsWith('ERROR:'));
  return (error ?? lines.at(-1) ?? 'no reason given').replace(/^ERROR:\s*/, '');
}

/**
 * The name of the runner's buildx builder: one for each runner, named from its owner (its data
 * volume), so runners of different Organisations on one Docker host never share a builder or its limits.
 */
export const builderName = (owner: string) => `devailoop-${owner.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}`;

/** The container buildx runs a `docker-container` builder in. */
const builderContainer = (name: string) => `buildx_buildkit_${name}0`;

/**
 * How many processes the kernel has killed in the builder's container for want of memory, from its cgroup's
 * `memory.events` (cgroup v2, which Docker Desktop and current Linux distributions use), or null when that cannot
 * be read. A `RUN` step killed inside the builder counts here, though the builder itself keeps running.
 */
export async function builderOomKills(docker: Docker, name: string): Promise<number | null> {
  try {
    const events = await docker.exec(['exec', builderContainer(name), 'cat', '/sys/fs/cgroup/memory.events']);
    if (events.code !== 0) return null;
    const kills = /^oom_kill\s+(\d+)$/m.exec(events.stdout)?.[1];
    return kills === undefined ? null : Number(kills);
  } catch {
    return null;
  }
}

/**
 * Whether the builder has run out of memory since `before`, the count `builderOomKills` gave before the build:
 * a step of the build was killed, or the builder's own container was (which Docker records, and which leaves
 * nothing to exec in).
 */
export async function builderRanOutOfMemory(docker: Docker, name: string, before: number | null): Promise<boolean> {
  const after = await builderOomKills(docker, name);
  if (after !== null && after > (before ?? 0)) return true;
  try {
    const inspected = await docker.exec([
      'container',
      'inspect',
      '--format',
      '{{.State.OOMKilled}}',
      builderContainer(name),
    ]);
    return inspected.code === 0 && inspected.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Makes sure the builder exists, runs, and has the container limits as they are now, so a builder
 * that was removed, stopped or made under other limits is put right before a build and never
 * builds unlimited. The `docker-container` driver has no process limit of its own, so every limit
 * is set with `docker update` on its container. Returns why it cannot, or null.
 */
export async function ensureBuilder(docker: Docker, name: string, limits: AgentContainerSettings) {
  const needs = `It needs ${limits.buildkitImage}, which is pulled from a registry (DEVAILOOP_BUILDKIT_IMAGE names another).`;
  // Only a builder buildx does not know is made; one it knows that cannot start shows why it cannot.
  const known = await docker.exec(['buildx', 'inspect', name]);
  if (known.code !== 0) {
    const created = await docker.exec([
      'buildx',
      'create',
      '--name',
      name,
      '--driver',
      'docker-container',
      '--driver-opt',
      `image=${limits.buildkitImage}`,
    ]);
    if (created.code !== 0) return `The builder ${name} could not be made: ${errorLine(created.stderr)}. ${needs}`;
  }
  const started = await docker.exec(['buildx', 'inspect', '--bootstrap', name], { timeoutMs: PREPARE_TIMEOUT_MS });
  if (started.code !== 0) return `The builder ${name} could not be started: ${errorLine(started.stderr)}. ${needs}`;
  const updated = await docker.exec([
    'update',
    '--memory',
    limits.memory,
    '--memory-swap',
    limits.memory,
    '--pids-limit',
    String(limits.pids),
    '--cpu-shares',
    String(limits.cpuShares),
    ...(limits.cpus ? ['--cpus', limits.cpus] : []),
    builderContainer(name),
  ]);
  if (updated.code !== 0) return `The limits of the builder ${name} could not be set: ${firstLine(updated.stderr)}`;
  return null;
}

/** devailoop-agent-base as an OCI layout on disk, which a build can name as a context. */
export interface BaseExport {
  /** The id of the image exported. */
  id: string;
  dir: string;
  /** The digest of the layout's manifest, which pins the context. */
  digest: string;
}

/** Where exported layouts are kept: in the runner's own temporary directory, so nothing outlives its container. */
export const BASE_EXPORT_DIR = join(tmpdir(), 'devailoop-base-export');

const unpack = async (tar: string, dir: string) => void (await run('tar', ['-xf', tar, '-C', dir]));

/** The digest of the manifest `index.json` of an OCI layout lists first. */
async function layoutDigest(dir: string): Promise<string | null> {
  try {
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as { manifests?: { digest?: unknown }[] };
    const digest = index.manifests?.[0]?.digest;
    return typeof digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
  } catch {
    return null;
  }
}

/**
 * Exports the base image, once for each id it has: a container builder cannot see Docker's local
 * images, so a build gets it as a layout the buildx client serves. Only the newest export is kept.
 * Returns the export, or why it could not be made.
 */
export async function exportBase(
  docker: Docker,
  image: string,
  root: string = BASE_EXPORT_DIR,
  extract: (tar: string, dir: string) => Promise<void> = unpack,
): Promise<BaseExport | { problem: string }> {
  const id = await baseImageId(docker, image);
  if (id === null) return { problem: `${image} is not there, so nothing can be built on it.` };
  const name = id.replace(/[^A-Za-z0-9]/g, '_');
  const dir = join(root, name);
  const existing = existsSync(dir) ? await layoutDigest(dir) : null;
  if (existing) return { id, dir, digest: existing };

  const partial = join(root, `${name}.partial`);
  const tar = join(root, `${name}.tar`);
  try {
    await rm(partial, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
    await mkdir(partial, { recursive: true });
    const saved = await docker.exec(['save', '--output', tar, image], { timeoutMs: PREPARE_TIMEOUT_MS });
    if (saved.code !== 0) return { problem: `${image} could not be exported: ${firstLine(saved.stderr)}` };
    await extract(tar, partial);
    const digest = await layoutDigest(partial);
    if (digest === null)
      return { problem: `${image} was exported, but not as an OCI layout. Docker 26 or newer does that.` };
    await rename(partial, dir);
    for (const other of await readdir(root))
      if (other !== name) await rm(join(root, other), { recursive: true, force: true });
    return { id, dir, digest };
  } catch (error) {
    return { problem: `${image} could not be exported: ${(error as Error).message}` };
  } finally {
    await rm(tar, { force: true });
    await rm(partial, { recursive: true, force: true });
  }
}
