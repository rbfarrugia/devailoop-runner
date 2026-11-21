import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHAT_WITHOUT_WORKING_COPY_DIR,
  RELEVANCE_CHECKS_DIR,
  CLAUDE_CONFIGS_DIR,
  PROJECTS_DIR,
  WORKING_COPIES_DIR,
  agentHomeOf,
  claudeConfigOf,
  projectDirOf,
} from '@devailoop/runner-shared';
import { OLLAMA_PS_MARKER } from './protocol';

/** Every container the runner starts carries this label, so leftovers can be found and removed. */
export const SESSION_LABEL = 'devailoop.session';

/**
 * Everything the runner builds or starts carries this label, naming the runner's data volume, so
 * runners of different Organisations sharing one Docker host each clean up only their own.
 */
export const OWNER_LABEL = 'devailoop.owner';

/**
 * Names the DevAILoop instance (its database) the worker serving this runner belongs to, so that
 * instances sharing one Docker host can tell one another's containers and images apart.
 */
export const INSTANCE_LABEL = 'devailoop.instance';

/** The `--label` options naming the instance, none until the worker has told the runner which it is. */
const instanceLabel = (instance: string | undefined) => (instance ? ['--label', `${INSTANCE_LABEL}=${instance}`] : []);

/** Where the worker's data volume is mounted in the worker, and where a session's parts of it are in its container. */
export const DATA_DIR = '/data';

/**
 * Claude Code's TMPDIR in every Agent container, so the sandbox's own proxy sockets live here and
 * not in /tmp, which a display needs writable. The sandbox never lets commands write here. It is
 * fixed by the runner, so the worker cannot send or change it; the Agent's image must create it.
 */
export const SANDBOX_TMPDIR = '/var/lib/devailoop-sandbox';

/**
 * The environment a session may be given. Anything else the worker sends is dropped, so the
 * database address or any other secret of the worker's never reaches a container, whatever it sends.
 * HOME and CLAUDE_CONFIG_DIR are not among them: the runner sets them to the Project's own.
 */
const ALLOWED_ENV = new Set([
  'LANG',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  // Where a session on a Local LLM sends its requests, and the model it asks for.
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]);
/** Claude Code's and the SDK's own switches, which they set for themselves. */
const ALLOWED_ENV_PREFIXES = ['CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_'];

export function allowedEnv(env: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (ALLOWED_ENV.has(name) || ALLOWED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) kept[name] = value;
  }
  return kept;
}

const WORKING_COPY_PATTERN = new RegExp(
  `^${DATA_DIR}/${PROJECTS_DIR}/([A-Z][A-Z0-9]*)/${WORKING_COPIES_DIR}/([A-Z][A-Z0-9]*)-[1-9][0-9]*$`,
);

const RELEVANCE_CHECK_PATTERN = new RegExp(`^${DATA_DIR}/${RELEVANCE_CHECKS_DIR}/([A-Z][A-Z0-9]*)/[1-9][0-9]*$`);

/**
 * Why a session's working directory is refused, or null. It is all its container gets of the
 * data volume besides what Claude Code itself needs, so it may only be a working copy of a
 * Ticket of the session's own Project (`project`, a code already checked), in that Project's
 * directory, a relevance check's checkout of the default branch, or the empty
 * directory a chat on a Ticket without a working copy is answered from.
 */
export function cwdProblem(cwd: unknown, project: string): string | null {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return 'the working directory must be an absolute path';
  if (posix.normalize(cwd) !== cwd || cwd.split('/').includes('..')) {
    return 'the working directory must be written plainly, without "." or ".." parts';
  }
  if (cwd === `${DATA_DIR}/${CHAT_WITHOUT_WORKING_COPY_DIR}`) return null;
  const check = RELEVANCE_CHECK_PATTERN.exec(cwd);
  if (check) {
    return check[1] === project
      ? null
      : `the working directory ${cwd} is a relevance check of ${check[1]}, not of ${project}`;
  }
  const found = WORKING_COPY_PATTERN.exec(cwd);
  if (!found) {
    return `the working directory must be a Ticket's working copy, ${DATA_DIR}/${PROJECTS_DIR}/<code>/${WORKING_COPIES_DIR}/<Ticket Number>, ${DATA_DIR}/${RELEVANCE_CHECKS_DIR}/<code>/<question id>, or ${DATA_DIR}/${CHAT_WITHOUT_WORKING_COPY_DIR}`;
  }
  const [, homeProject, ticketProject] = found;
  if (homeProject !== ticketProject)
    return `the working directory ${cwd} is in the directory of ${homeProject}, but belongs to a Ticket of ${ticketProject}`;
  if (ticketProject !== project)
    return `the working directory ${cwd} belongs to a Ticket of ${ticketProject}, not of ${project}`;
  return null;
}

/**
 * What a container may take from the host, and the system-call filter it runs under. Set by the
 * runner's own environment when it starts (see `agentContainerSettings`), never by a request, so
 * the worker cannot widen it.
 */
export interface AgentContainerSettings {
  /** Memory, and with it swap, in Docker's size format (`8g`). A process that passes it is killed. */
  memory: string;
  /** How many processes and threads a container may have. */
  pids: number;
  /** The container's weight against others when CPUs are contended; nothing is slowed on an idle machine. */
  cpuShares: number;
  /** A hard cap in CPUs (`2`, `1.5`), none unless asked for. */
  cpus?: string;
  /** `devailoop`: the profile shipped with the runner. `unconfined`: no filter, the documented fallback. */
  seccomp: 'devailoop' | 'unconfined';
  /**
   * The AppArmor profile, on hosts that have AppArmor (Ubuntu). `unconfined` by default: Docker's own,
   * docker-default, refuses every mount, so bubblewrap cannot make its mount namespace under it.
   * Ignored by Docker where there is no AppArmor.
   */
  apparmor: string;
  /** The BuildKit image the Environment builder's container runs, pulled when the builder is first made. */
  buildkitImage: string;
}

/** What `docker buildx create` runs in the builder's container, unless DEVAILOOP_BUILDKIT_IMAGE says otherwise. */
export const DEFAULT_BUILDKIT_IMAGE = 'moby/buildkit:buildx-stable-1';

export const DEFAULT_CONTAINER_SETTINGS: AgentContainerSettings = {
  memory: '8g',
  pids: 4096,
  cpuShares: 512,
  seccomp: 'devailoop',
  apparmor: 'unconfined',
  buildkitImage: DEFAULT_BUILDKIT_IMAGE,
};

/** The seccomp profile shipped with the runner: Docker's default plus the calls bubblewrap needs. */
export const SECCOMP_PROFILE = fileURLToPath(new URL('../seccomp/agent.json', import.meta.url));

/** Reads the container settings from the runner's environment, or says which variable is wrong. */
export function agentContainerSettings(
  env: Record<string, string | undefined>,
): { settings: AgentContainerSettings } | { problem: string } {
  const value = (name: string) => env[name]?.trim() || undefined;
  const settings: AgentContainerSettings = { ...DEFAULT_CONTAINER_SETTINGS };
  const memory = value('DEVAILOOP_AGENT_MEMORY');
  if (memory !== undefined) {
    if (!/^[1-9][0-9]*[bkmg]$/i.test(memory))
      return { problem: `DEVAILOOP_AGENT_MEMORY is "${memory}". It must be a size such as 8g or 512m.` };
    settings.memory = memory.toLowerCase();
  }
  const pids = value('DEVAILOOP_AGENT_PIDS');
  if (pids !== undefined) {
    if (!/^[0-9]+$/.test(pids) || Number(pids) < 64)
      return { problem: `DEVAILOOP_AGENT_PIDS is "${pids}". It must be a whole number of at least 64.` };
    settings.pids = Number(pids);
  }
  const cpus = value('DEVAILOOP_AGENT_CPUS');
  if (cpus !== undefined) {
    if (!/^[0-9]+(\.[0-9]+)?$/.test(cpus) || Number(cpus) <= 0)
      return { problem: `DEVAILOOP_AGENT_CPUS is "${cpus}". It must be a number of CPUs above 0, such as 2 or 1.5.` };
    settings.cpus = cpus;
  }
  const seccomp = value('DEVAILOOP_AGENT_SECCOMP');
  if (seccomp !== undefined) {
    if (seccomp !== 'devailoop' && seccomp !== 'unconfined')
      return { problem: `DEVAILOOP_AGENT_SECCOMP is "${seccomp}". It must be devailoop or unconfined.` };
    settings.seccomp = seccomp;
  }
  const apparmor = value('DEVAILOOP_AGENT_APPARMOR');
  if (apparmor !== undefined) {
    if (apparmor.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(apparmor))
      return {
        problem: `DEVAILOOP_AGENT_APPARMOR is "${apparmor}". It must be unconfined or the name of an AppArmor profile loaded on the host.`,
      };
    settings.apparmor = apparmor;
  }
  const buildkit = value('DEVAILOOP_BUILDKIT_IMAGE');
  if (buildkit !== undefined) {
    if (buildkit.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(buildkit))
      return {
        problem: `DEVAILOOP_BUILDKIT_IMAGE is "${buildkit}". It must be an image name such as ${DEFAULT_BUILDKIT_IMAGE}.`,
      };
    settings.buildkitImage = buildkit;
  }
  return { settings };
}

/** What every Agent container is started with, whatever the image says. */
function fixedOptions(
  owner: string,
  instance?: string,
  limits: AgentContainerSettings = DEFAULT_CONTAINER_SETTINGS,
): string[] {
  return [
    // The Agent runs as an ordinary user, never root, even if the image's last USER is root.
    '--user',
    'agent',
    // The Agent's sandbox has to create namespaces, which Docker's default system-call filter forbids:
    // the runner's profile is that filter with the calls bubblewrap needs added. The Agent runs as an
    // ordinary user, so it needs none of Docker's default capabilities, and gets no new privileges.
    '--security-opt',
    `seccomp=${limits.seccomp === 'unconfined' ? 'unconfined' : SECCOMP_PROFILE}`,
    // The sandbox also makes its own mounts, which Docker's AppArmor profile refuses (see `apparmor`).
    '--security-opt',
    `apparmor=${limits.apparmor}`,
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    // What a container may take from the host. Memory and swap are the same, so a runaway build is
    // stopped at the limit and does not swap the machine to a crawl.
    '--memory',
    limits.memory,
    '--memory-swap',
    limits.memory,
    '--pids-limit',
    String(limits.pids),
    '--cpu-shares',
    String(limits.cpuShares),
    ...(limits.cpus ? ['--cpus', limits.cpus] : []),
    // Nothing of the host or the worker is mounted here: not the GitHub App's key, not the socket.
    // A session gets only its own parts of the data volume, from sessionDataOptions.
    // A fixed value and no secret, so it is given on the command line.
    '--env',
    `TMPDIR=${SANDBOX_TMPDIR}`,
    // Reaches the machine Docker runs on, where a Local LLM may be listening.
    '--add-host',
    'host.docker.internal:host-gateway',
    '--init',
    '--label',
    `${SESSION_LABEL}=1`,
    '--label',
    `${OWNER_LABEL}=${owner}`,
    ...instanceLabel(instance),
  ];
}

/**
 * What a session sees of the data volume: an empty, read-only tmpfs over all of it, and on it
 * only the Project's own Claude Code directory (its transcripts, which the sandbox closes to the
 * Agent's commands) and the Project's own directory, each a directory of the volume that must
 * exist. The Project's directory holds its Agent home and its working copies, so one mount holds
 * the pnpm store and the session's working directory, which lets pnpm hard-link (links do not cross
 * mounts). Its sandbox lets the session write only in the home and its own working copy. No other Project's transcripts,
 * home or working copy, no mirror, nothing else. Each is at the same path as in the worker: session resume depends on
 * stable paths. HOME and CLAUDE_CONFIG_DIR are set to the Project's own here, so the worker
 * cannot choose others.
 */
function sessionDataOptions(dataVolume: string, project: string, cwd: string): string[] {
  const part = (path: string) => [
    '--mount',
    `type=volume,source=${dataVolume},target=${DATA_DIR}/${path},volume-subpath=${path}`,
  ];
  return [
    '--mount',
    `type=tmpfs,target=${DATA_DIR},tmpfs-size=1m,tmpfs-mode=0555`,
    ...part(`${CLAUDE_CONFIGS_DIR}/${project}`),
    ...part(`${PROJECTS_DIR}/${project}`),
    // A working copy is inside the Project's directory; only the empty directory of a chat without one is a mount of its own.
    ...(cwd.startsWith(`${projectDirOf(DATA_DIR, project)}/`) ? [] : part(cwd.slice(DATA_DIR.length + 1))),
    '--env',
    `HOME=${agentHomeOf(DATA_DIR, project)}`,
    '--env',
    `CLAUDE_CONFIG_DIR=${claudeConfigOf(DATA_DIR, project)}`,
  ];
}

/** The oldest Docker Engine the runner works with: mounting part of a volume (`volume-subpath`) came in 26. */
export const MIN_DOCKER_MAJOR_VERSION = 26;

/** Why the runner cannot work with this Docker Engine, given its version, or null. */
export function dockerVersionProblem(version: string): string | null {
  const major = Number(/^(\d+)\./.exec(version.trim())?.[1]);
  if (Number.isInteger(major) && major >= MIN_DOCKER_MAJOR_VERSION) return null;
  return `Docker Engine ${version.trim() || '(unknown)'} is too old: the runner needs ${MIN_DOCKER_MAJOR_VERSION} or newer, to give each Project its own Agent home. Update Docker (Docker Desktop 4.29 or newer).`;
}

/**
 * The `docker run` for one session: Claude Code in the Agent's image, talking over stdio. The
 * environment is passed by name only, so its values come from the docker command's own
 * environment and never show on a command line.
 */
export function sessionRunArgs(input: {
  limits?: AgentContainerSettings;
  name: string;
  project: string;
  image: string;
  dataVolume: string;
  instance?: string;
  cwd: string;
  env: Record<string, string>;
  args: string[];
}): string[] {
  return [
    'run',
    '-i',
    '--name',
    input.name,
    ...fixedOptions(input.dataVolume, input.instance, input.limits),
    ...sessionDataOptions(input.dataVolume, input.project, input.cwd),
    '--workdir',
    input.cwd,
    ...Object.keys(input.env).flatMap((name) => ['--env', name]),
    input.image,
    'claude',
    ...input.args,
  ];
}

/**
 * What a `command` request is run with: the settings file for `srt` (Claude Code's sandbox as a
 * program) arrives as $1 and the script as $2, so neither is ever part of the shell text.
 */
const COMMAND_WRAPPER = 'f="$(mktemp)" && printf "%s" "$1" > "$f" && exec srt --settings "$f" bash -c "$2"';

/** The `srt` settings for a command: the same inputs as a session's sandbox gets. */
export function commandSandboxSettings(input: {
  project: string;
  cwd: string;
  allowedDomains: string[];
  denyRead: string[];
}): string {
  return JSON.stringify({
    network: { allowedDomains: input.allowedDomains, deniedDomains: [] },
    filesystem: {
      denyRead: [claudeConfigOf(DATA_DIR, input.project), ...input.denyRead],
      allowWrite: [agentHomeOf(DATA_DIR, input.project), input.cwd],
      denyWrite: [],
    },
  });
}

/** Why a `command` request's lists are refused, or null: plain strings, and absolute paths where paths are meant. */
export function commandListsProblem(input: {
  script: unknown;
  allowedDomains: unknown;
  denyRead: unknown;
  timeoutMs: unknown;
}): string | null {
  if (typeof input.script !== 'string' || input.script.length === 0 || input.script.length > 100_000)
    return 'the script must be 1 to 100,000 characters';
  if (
    typeof input.timeoutMs !== 'number' ||
    !Number.isFinite(input.timeoutMs) ||
    input.timeoutMs < 1000 ||
    input.timeoutMs > 4 * 60 * 60 * 1000
  ) {
    return 'the timeout must be between one second and four hours';
  }
  const { allowedDomains, denyRead } = input;
  if (
    !Array.isArray(allowedDomains) ||
    allowedDomains.some(
      (d) => typeof d !== 'string' || d.length === 0 || d.length > 253 || /[\u0000-\u001f\u007f\s]/.test(d),
    )
  ) {
    return 'the allowed domains must be a list of plain names';
  }
  if (
    !Array.isArray(denyRead) ||
    denyRead.some(
      (p) => typeof p !== 'string' || !p.startsWith('/') || p.length > 4096 || /[\u0000-\u001f\u007f]/.test(p),
    )
  ) {
    return 'the denied reads must be a list of absolute paths';
  }
  return null;
}

/**
 * The `docker run` for a Project's command (its Test command): `srt` runs the script in the
 * Project's image with a session's mounts and sandbox settings, and no variable of the worker's,
 * so no credential. Nothing is read from stdin.
 */
export function commandRunArgs(input: {
  limits?: AgentContainerSettings;
  name: string;
  project: string;
  image: string;
  dataVolume: string;
  instance?: string;
  cwd: string;
  script: string;
  allowedDomains: string[];
  denyRead: string[];
}): string[] {
  const settings = commandSandboxSettings(input);
  return [
    'run',
    '--name',
    input.name,
    ...fixedOptions(input.dataVolume, input.instance, input.limits),
    ...sessionDataOptions(input.dataVolume, input.project, input.cwd),
    '--workdir',
    input.cwd,
    '--entrypoint',
    'sh',
    input.image,
    '-c',
    COMMAND_WRAPPER,
    'sh',
    settings,
    input.script,
  ];
}

/** The same commands the worker's own check runs, in the Agent's image. */
const SANDBOX_CHECK_SCRIPT = [
  'socat -V >/dev/null 2>&1 || { echo "socat, which the sandbox needs, is not usable" >&2; exit 3; }',
  'bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --unshare-net --unshare-pid true || exit 4',
  `test -d ${SANDBOX_TMPDIR} && test -w ${SANDBOX_TMPDIR} || { echo "the Agent's image must create ${SANDBOX_TMPDIR}, owned by agent; build it on devailoop-agent-base" >&2; exit 5; }`,
].join('\n');

/** Every Environment image the runner builds carries this label, naming its Project's id. */
export const ENVIRONMENT_LABEL = 'devailoop.environment';

/** The name `devailoop-agent-base` has inside a build: the Dockerfile's `FROM` finds it as a named context. */
export const BASE_CONTEXT_NAME = 'devailoop-agent-base';

/**
 * The `docker buildx build` for a Project's Environment, run in the runner's own builder (see
 * builder.ts) so its container's limits apply. The Dockerfile comes on stdin and there is no
 * build context, so it cannot read a file of the host's; nothing it says can add a secret, a
 * mount of the host's or a privilege, because none is offered here. `--load` puts the image in
 * Docker's image store, where sessions find it. The builder's container cannot see Docker's
 * images, so devailoop-agent-base is given as a named context from an OCI layout (`base`).
 */
export function buildImageArgs(input: {
  builder: string;
  base: { dir: string; digest: string };
  tag: string;
  projectId: number;
  owner: string;
  instance?: string;
}): string[] {
  return [
    'buildx',
    'build',
    '--builder',
    input.builder,
    '--load',
    '--progress=plain',
    '--build-context',
    `${BASE_CONTEXT_NAME}=oci-layout://${input.base.dir}@${input.base.digest}`,
    '--label',
    `${ENVIRONMENT_LABEL}=${input.projectId}`,
    '--label',
    `${OWNER_LABEL}=${input.owner}`,
    ...instanceLabel(input.instance),
    '--tag',
    input.tag,
    '-',
  ];
}

/** The sandbox check needs nothing of the data volume, so it gets none of it. */
export function sandboxCheckArgs(input: {
  name: string;
  image: string;
  owner: string;
  instance?: string;
  limits?: AgentContainerSettings;
}): string[] {
  return [
    'run',
    '--rm',
    '--name',
    input.name,
    ...fixedOptions(input.owner, input.instance, input.limits),
    '--entrypoint',
    'sh',
    input.image,
    '-c',
    SANDBOX_CHECK_SCRIPT,
  ];
}

/**
 * Why a Local LLM check is refused, or null. The host and port end up in a URL and the model in a
 * JSON body, so each is held to plain characters.
 */
export function localLlmCheckProblem(input: { host: unknown; port: unknown; model: unknown }): string | null {
  const { host, port, model } = input;
  if (
    typeof host !== 'string' ||
    host.length === 0 ||
    host.length > 253 ||
    !/^[A-Za-z0-9.:[\]-]+$/.test(host) ||
    host.startsWith('-')
  ) {
    return 'the host must be a name or an address in plain characters';
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
    return 'the port must be between 1 and 65535';
  if (typeof model !== 'string' || model.length === 0 || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) {
    return 'the model name must be 1 to 200 characters, without control characters';
  }
  return null;
}

/**
 * Sends one tiny Messages API request. Its stdout is the response body, then a line with the HTTP
 * status; a failure to get any response ends it with curl's exit code and message on stderr. After a
 * 2xx it adds the marker line and the body of Ollama's `/api/ps` (which says the loaded model's
 * context window), if there is one. The URL and the body are arguments, never part of the script.
 */
const LOCAL_LLM_CHECK_SCRIPT =
  'out=$(curl -sS --connect-timeout 10 --max-time 180 -H "content-type: application/json" -H "x-api-key: local-llm" ' +
  '-H "anthropic-version: 2023-06-01" -d "$2" -w "\\n%{http_code}" "$1/v1/messages") || exit $?; ' +
  'printf "%s\\n" "$out"; ' +
  `case "$(printf "%s" "$out" | tail -n 1)" in 2??) echo '${OLLAMA_PS_MARKER}'; curl -s --connect-timeout 5 --max-time 10 "$1/api/ps" 2>/dev/null || true;; esac`;

/** The `docker run` that asks a Local LLM for one token, from a container set up as a session's is. */
export function localLlmCheckArgs(input: {
  limits?: AgentContainerSettings;
  name: string;
  image: string;
  owner: string;
  instance?: string;
  host: string;
  port: number;
  model: string;
}): string[] {
  const bare = input.host.replace(/^\[|\]$/g, '');
  const url = `http://${bare.includes(':') ? `[${bare}]` : bare}:${input.port}`;
  const body = JSON.stringify({ model: input.model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] });
  return [
    'run',
    '--rm',
    '--name',
    input.name,
    ...fixedOptions(input.owner, input.instance, input.limits),
    '--entrypoint',
    'sh',
    input.image,
    '-c',
    LOCAL_LLM_CHECK_SCRIPT,
    'sh',
    url,
    body,
  ];
}
