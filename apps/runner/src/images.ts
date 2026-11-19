import { isEnvironmentImageOf } from '@devailoop/runner-shared';
import { ENVIRONMENT_LABEL, INSTANCE_LABEL, OWNER_LABEL, SESSION_LABEL } from './docker-args';
import type { Docker } from './server';

/** The repositories every Environment image is tagged in: `devailoop-env-<project id>`. */
const ENVIRONMENT_REPOSITORY_PREFIX = 'devailoop-env-';

/** A build's tag of its own, until the sandbox check passes in it. */
const isCandidateTag = (tag: string) => tag.startsWith('candidate-');

const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';

/** One image the runner built, as `docker image ls` lists it: by tag, or by id alone when it has none. */
interface EnvironmentImage {
  id: string;
  /** `repository:tag`, or null for an image that lost its tag to a newer build of the same Dockerfile. */
  ref: string | null;
  tag: string | null;
}

/** Every image carrying the runner's Environment label, once for each tag it has. */
async function listEnvironmentImages(docker: Docker): Promise<EnvironmentImage[]> {
  const listed = await docker.exec([
    'image',
    'ls',
    '--no-trunc',
    '--filter',
    `label=${ENVIRONMENT_LABEL}`,
    '--format',
    '{{.ID}}\t{{.Repository}}\t{{.Tag}}',
  ]);
  if (listed.code !== 0) throw new Error(`The images could not be listed: ${firstLine(listed.stderr)}`);
  return lines(listed.stdout).flatMap((line): EnvironmentImage[] => {
    const [id, repository, tag] = line.split('\t');
    if (!id) return [];
    if (!repository || repository === '<none>' || !tag || tag === '<none>') return [{ id, ref: null, tag: null }];
    // Only the runner's own repositories: a label alone could be copied by anyone's Dockerfile.
    if (!repository.startsWith(ENVIRONMENT_REPOSITORY_PREFIX)) return [];
    return [{ id, ref: `${repository}:${tag}`, tag }];
  });
}

/** The owner label of each container or image, by id; one that could not be inspected is left out. */
export const ownersOf = (docker: Docker, kind: 'container' | 'image', ids: string[]) =>
  labelsOf(docker, kind, ids, OWNER_LABEL);

/** The value of one label of each container or image, by id, empty when it has none; one that could not be inspected is left out. */
async function labelsOf(
  docker: Docker,
  kind: 'container' | 'image',
  ids: string[],
  label: string,
): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  if (ids.length === 0) return owners;
  const inspected = await docker.exec([
    kind,
    'inspect',
    '--format',
    `{{.Id}}\t{{index .Config.Labels "${label}"}}`,
    ...ids,
  ]);
  for (const line of lines(inspected.stdout)) {
    const [id, owner] = line.split('\t');
    if (id) owners.set(id, owner === '<no value>' ? '' : (owner ?? ''));
  }
  return owners;
}

/** Whether something is the runner's to remove: its owner label is the runner's, or it has none (from before the label). */
export const isOwnedBy = (label: string | undefined, owner: string) =>
  label !== undefined && (label === '' || label === owner);

/** The images of this owner (or of none) among those listed. A listing can name an image once per tag. */
async function ownImages(docker: Docker, owner: string): Promise<EnvironmentImage[]> {
  const images = await listEnvironmentImages(docker);
  const owners = await ownersOf(docker, 'image', [...new Set(images.map((image) => image.id))]);
  return images.filter((image) => isOwnedBy(owners.get(image.id), owner));
}

/** The ids of the images the runner's containers, sessions and sandbox checks alike, were started from. */
async function imagesInUse(docker: Docker): Promise<Set<string>> {
  const listed = await docker.exec(['ps', '--all', '--quiet', '--filter', `label=${SESSION_LABEL}`]);
  if (listed.code !== 0) throw new Error(`The containers could not be listed: ${firstLine(listed.stderr)}`);
  const ids = lines(listed.stdout);
  if (ids.length === 0) return new Set();
  const inspected = await docker.exec(['container', 'inspect', '--format', '{{.Image}}', ...ids]);
  // A container that ended meanwhile is not there to inspect; the rest are still listed.
  return new Set(lines(inspected.stdout));
}

/** Why a keep list is refused, or null: each Project's id, with the images of that Project to keep. */
export function keepListProblem(keep: unknown): string | null {
  if (typeof keep !== 'object' || keep === null || Array.isArray(keep))
    return 'the images to keep must be given per Project';
  for (const [project, images] of Object.entries(keep)) {
    if (!/^[1-9][0-9]*$/.test(project)) return `"${project}" is not a Project's id`;
    if (!Array.isArray(images) || images.some((image) => typeof image !== 'string'))
      return `the images to keep of ${project} must be a list of names`;
  }
  return null;
}

/**
 * Removes the Environment images the runner built that are not to be kept: every one of a
 * Project not listed, the rest of a Project's, and those that lost their tag. Only those the runner built
 * itself or that predate the owner label. Never one a
 * container of the runner's was started from, never a build's candidate, and never by force, so
 * Docker itself refuses to remove an image a container has just been started from.
 */
export async function pruneEnvironmentImages(
  docker: Docker,
  keep: Record<string, string[]>,
  owner: string,
  log: (line: string) => void = () => {},
): Promise<{ removed: string[] }> {
  const kept = new Set(
    Object.entries(keep).flatMap(([project, images]) =>
      images.filter((image) => isEnvironmentImageOf(Number(project), image)),
    ),
  );
  // Listed before the containers: an image whose container starts in between is still refused by Docker.
  const images = await ownImages(docker, owner);
  const inUse = await imagesInUse(docker);
  const removed: string[] = [];
  for (const image of images) {
    if (inUse.has(image.id)) continue;
    if (image.ref !== null && (kept.has(image.ref) || isCandidateTag(image.tag!))) continue;
    const name = image.ref ?? image.id;
    const result = await docker.exec(['image', 'rm', name]);
    if (result.code === 0) removed.push(name);
    else log(`could not remove ${name}: ${firstLine(result.stderr)}`);
  }
  if (removed.length > 0) log(`removed ${removed.length} Environment image(s): ${removed.join(', ')}`);
  return { removed };
}

/** Removes builds' candidate tags left over from a runner that stopped mid-build. Only when no build can be under way. */
export async function removeLeftoverCandidates(docker: Docker, owner: string): Promise<number> {
  const candidates = (await ownImages(docker, owner)).filter(
    (image) => image.tag !== null && isCandidateTag(image.tag),
  );
  let removed = 0;
  for (const candidate of candidates) {
    if ((await docker.exec(['image', 'rm', candidate.ref!])).code === 0) removed++;
  }
  return removed;
}

/**
 * Removes the `candidate-*` tags of the base image that a stopped base build left behind. The base's
 * builds carry no Environment label, so `removeLeftoverCandidates` cannot see them. Never by force.
 */
export async function removeLeftoverBaseCandidates(docker: Docker, baseImage: string): Promise<number> {
  const listed = await docker.exec(['image', 'ls', baseImage, '--format', '{{.Tag}}']);
  if (listed.code !== 0) return 0;
  let removed = 0;
  for (const tag of listed.stdout.split('\n').map((line) => line.trim())) {
    if (!isCandidateTag(tag)) continue;
    if ((await docker.exec(['image', 'rm', `${baseImage}:${tag}`])).code === 0) removed++;
  }
  return removed;
}

/** The id of the image every Environment builds on, or null when it is not there. */
export async function baseImageId(docker: Docker, baseImage: string): Promise<string | null> {
  const inspected = await docker.exec(['image', 'inspect', '--format', '{{.Id}}', baseImage]);
  return inspected.code === 0 ? inspected.stdout.trim() || null : null;
}

/**
 * The other DevAILoop instances (not `instance`) that have containers or Environment images on
 * this Docker host, by the instance label the runner stamps on what it makes. What predates the
 * label has none and is not counted.
 */
export async function otherInstances(docker: Docker, instance: string): Promise<string[]> {
  const containers = await docker.exec(['ps', '--all', '--quiet', '--no-trunc', '--filter', `label=${SESSION_LABEL}`]);
  const images = await docker.exec(['image', 'ls', '--quiet', '--no-trunc', '--filter', `label=${ENVIRONMENT_LABEL}`]);
  const found = new Set<string>();
  for (const [kind, listed] of [
    ['container', containers],
    ['image', images],
  ] as const) {
    const labels = await labelsOf(docker, kind, [...new Set(lines(listed.stdout))], INSTANCE_LABEL);
    for (const label of labels.values()) if (label !== '' && label !== instance) found.add(label);
  }
  return [...found];
}
