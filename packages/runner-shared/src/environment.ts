/**
 * A Project's Environment: the Dockerfile its Agent image is built from. The image every
 * Environment builds on, and the one a Project without a good image of its own runs in.
 */
export const AGENT_BASE_IMAGE = 'devailoop-agent-base';

/** The most text an Environment may hold, in characters. */
export const MAX_ENVIRONMENT_LENGTH = 64 * 1024;

/** How long one build may take before it is stopped. */
export const ENVIRONMENT_BUILD_TIME_LIMIT_MS = 30 * 60 * 1000;

/** The most of a build's log that is kept: its end, where a failure shows. */
export const MAX_BUILD_LOG_CHARS = 256 * 1024;

export const ENVIRONMENT_BUILD_STATES = ['queued', 'building', 'succeeded', 'failed'] as const;
export type EnvironmentBuildState = (typeof ENVIRONMENT_BUILD_STATES)[number];

/** The Dockerfile's instructions, one per entry, with continued lines joined and comments left out. */
function instructions(dockerfile: string): string[] {
  const found: string[] = [];
  let current = '';
  for (const raw of dockerfile.split(/\r?\n/)) {
    const line = raw.trim();
    // A comment inside a continued instruction is skipped, as Docker does.
    if (line.startsWith('#') || (line === '' && current === '')) continue;
    current += `${current ? ' ' : ''}${line.replace(/\\$/, '').trim()}`;
    if (!line.endsWith('\\')) {
      if (current) found.push(current);
      current = '';
    }
  }
  if (current) found.push(current);
  return found;
}

/**
 * Why an Environment's Dockerfile is refused, or null if it may be built. It must build on
 * devailoop-agent-base and nothing else, and may not choose its own BuildKit frontend, which
 * would be another image run during the build.
 */
export function environmentProblem(dockerfile: string): string | null {
  if (dockerfile.length > MAX_ENVIRONMENT_LENGTH) {
    return `The Environment is too long: it may be at most ${MAX_ENVIRONMENT_LENGTH} characters.`;
  }
  // BuildKit drops a byte-order mark and a leading "#!" line before it looks for parser directives,
  // so a directive may follow them. Refuse the "#!" line, and any "key=value" comment line before
  // the first instruction (more than BuildKit reads as directives, to be safe).
  let leading = true;
  for (const raw of dockerfile.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (!line.startsWith('#')) break;
    if (leading && line.startsWith('#!')) {
      return 'The Environment may not start with a "#!" line. Remove that line.';
    }
    leading = false;
    if (/^#\s*[a-z]+\s*=/i.test(line)) {
      return 'The Environment may not have a parser directive such as "# syntax=". Remove that line.';
    }
  }
  const all = instructions(dockerfile);
  const first = all[0];
  if (!first || !new RegExp(`^FROM\\s+${AGENT_BASE_IMAGE}(:latest)?$`, 'i').test(first)) {
    return `The Environment must start with "FROM ${AGENT_BASE_IMAGE}", so the Agent's image keeps what the Agent needs.`;
  }
  if (all.slice(1).some((instruction) => /^FROM\s/i.test(instruction))) {
    return `The Environment may have only one FROM, "FROM ${AGENT_BASE_IMAGE}". To take files from another image, use COPY --from=<image>.`;
  }
  return null;
}

/**
 * The repository a Project's Environment images are tagged in. It is named by the Project's id,
 * which no other Project of the instance shares, whichever Organisation it belongs to, so
 * workers of different Organisations may use one Docker host without sharing an image.
 */
export function environmentRepository(projectId: number): string {
  return `devailoop-env-${projectId}`;
}

/**
 * The tag of the image a Project's Environment builds, from the hash of its Dockerfile: the
 * first 12 hex digits of its SHA-256, which the runner works out.
 */
export function environmentImageTag(projectId: number, hash: string): string {
  return `${environmentRepository(projectId)}:${hash}`;
}

/** Whether a name is one of this Project's Environment images, in the exact form the runner gives them. */
export function isEnvironmentImageOf(projectId: number, image: string): boolean {
  const [repository, tag, ...rest] = image.split(':');
  return rest.length === 0 && repository === environmentRepository(projectId) && /^[0-9a-f]{12}$/.test(tag ?? '');
}

/**
 * Where each Project's directory is, in the worker's data directory: `projects/<code>`. It holds the
 * Project's Agent home (`home`) and its Tickets' working copies (`working-copies`), side by side. A
 * session's container mounts the whole directory, so pnpm can hard-link from the store in the home
 * into the working copy (links do not cross mounts), yet the sandbox lets the session write only in
 * the home and its own working copy: another Ticket's working copy is never writable to it.
 */
export const PROJECTS_DIR = 'projects';

/** A Project's directory, given the data directory (/data in the worker and in every Agent container). */
export function projectDirOf(dataDir: string, projectCode: string): string {
  return `${dataDir.replace(/\/+$/, '')}/${PROJECTS_DIR}/${projectCode}`;
}

/**
 * Where each Project's Agent home was before the Project directory: `agent-homes/<code>`. The worker
 * moves them to `projects/<code>/home` when it starts.
 */
export const AGENT_HOMES_DIR = 'agent-homes';

/**
 * A Project's Agent home: `projects/<code>/home`. Caches and anything else a Run leaves in its
 * home stay with its own Project.
 */
export function agentHomeOf(dataDir: string, projectCode: string): string {
  return `${projectDirOf(dataDir, projectCode)}/home`;
}

/**
 * Where each Project's Claude Code directory is, in the data directory: `claude-configs/<code>`.
 * It is Claude Code's CLAUDE_CONFIG_DIR in the Project's sessions, holding their transcripts, so
 * no session of one Project has another's transcripts anywhere it can reach.
 */
export const CLAUDE_CONFIGS_DIR = 'claude-configs';

/** A Project's Claude Code directory, given the data directory (/data in the worker and in every Agent container). */
export function claudeConfigOf(dataDir: string, projectCode: string): string {
  return `${dataDir.replace(/\/+$/, '')}/${CLAUDE_CONFIGS_DIR}/${projectCode}`;
}

/**
 * Where every Project's sessions kept Claude Code's directory before each Project had its own.
 * The worker moves the transcripts out of it into each Project's directory when it starts, then removes it.
 */
export const SHARED_CLAUDE_CONFIG_DIR = 'claude';

/** Where each Ticket's working copy is, in its Project's directory: `projects/<code>/working-copies/<Ticket Number>`. */
export const WORKING_COPIES_DIR = 'working-copies';

/** The code of the Project a Ticket Number belongs to: everything before the last dash. */
export function projectCodeOfTicket(ticketNumber: string): string {
  return ticketNumber.slice(0, ticketNumber.lastIndexOf('-'));
}

/** A Project's working copies, given the data directory. */
export function workingCopiesOf(dataDir: string, projectCode: string): string {
  return `${projectDirOf(dataDir, projectCode)}/${WORKING_COPIES_DIR}`;
}

/** A Ticket's working copy, given the data directory (/data in the worker and in every Agent container). */
export function workingCopyOf(dataDir: string, ticketNumber: string): string {
  return `${workingCopiesOf(dataDir, projectCodeOfTicket(ticketNumber))}/${ticketNumber}`;
}

/** Where each Repository's mirror is, in the data directory: `mirrors/<owner>/<name>.git`. Only the worker itself uses them. */
export const MIRRORS_DIR = 'mirrors';

/** Where each relevance check's checkout of the default branch is, in the data directory: `relevance-checks/<PROJECT>/<question id>`. Removed when the answer ends. */
export const RELEVANCE_CHECKS_DIR = 'relevance-checks';

/** Where a chat on a Ticket that has no working copy is answered from, in the data directory. Always empty. */
export const CHAT_WITHOUT_WORKING_COPY_DIR = 'chat-without-working-copy';
