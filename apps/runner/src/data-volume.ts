import { DATA_DIR } from './docker-args';
import type { Docker } from './server';

/** The labels Docker Compose puts on what it creates. */
const PROJECT_LABEL = 'com.docker.compose.project';
const VOLUME_LABEL = 'com.docker.compose.volume';
const SERVICE_LABEL = 'com.docker.compose.service';

const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';

/**
 * The name of the worker's data volume, parts of which each session's container mounts under /data, or
 * why there is none. `given` is DEVAILOOP_DATA_VOLUME, used as it is when set. Otherwise the
 * volume is found from the Compose project the runner's own container (`self`) belongs to, so
 * it is right whatever the project is called: first the project's `worker-data` volume, then
 * whatever the project's worker container has at /data. Either way it must exist.
 */
export async function findDataVolume(
  docker: Docker,
  input: { given?: string; self: string },
): Promise<{ volume: string } | { problem: string }> {
  let volume = input.given?.trim();
  if (!volume) {
    const found = await findInProject(docker, input.self);
    if ('problem' in found) return found;
    volume = found.volume;
  }
  const inspected = await docker.exec(['volume', 'inspect', '--format', '{{.Name}}', volume]);
  if (inspected.code !== 0) {
    return {
      problem: `The worker's data volume "${volume}" does not exist: ${firstLine(inspected.stderr) || `exit code ${inspected.code}`}. Start the whole instance with docker compose up -d, or set DEVAILOOP_DATA_VOLUME to the volume the worker has at ${DATA_DIR} (see docker volume ls).`,
    };
  }
  return { volume };
}

async function findInProject(docker: Docker, self: string): Promise<{ volume: string } | { problem: string }> {
  const unset = `DEVAILOOP_DATA_VOLUME is not set, so the runner looks for the worker's data volume in its own Compose project`;
  const labels = await docker.exec(['inspect', '--format', `{{index .Config.Labels "${PROJECT_LABEL}"}}`, self]);
  const project = labels.code === 0 ? labels.stdout.trim() : '';
  if (!project) {
    const why = labels.code === 0 ? 'it was not started by Docker Compose' : firstLine(labels.stderr);
    return {
      problem: `${unset}, but cannot tell which that is: ${why}. Set DEVAILOOP_DATA_VOLUME to the name of the worker's data volume.`,
    };
  }

  const volumes = await docker.exec([
    'volume',
    'ls',
    '--quiet',
    '--filter',
    `label=${PROJECT_LABEL}=${project}`,
    '--filter',
    `label=${VOLUME_LABEL}=worker-data`,
  ]);
  const named = volumes.code === 0 ? lines(volumes.stdout) : [];
  if (named.length === 1) return { volume: named[0]! };

  // A volume Compose did not make, such as an external one, carries no labels; the worker's mount still tells.
  const workers = await docker.exec([
    'ps',
    '--all',
    '--quiet',
    '--filter',
    `label=${PROJECT_LABEL}=${project}`,
    '--filter',
    `label=${SERVICE_LABEL}=worker`,
  ]);
  for (const id of workers.code === 0 ? lines(workers.stdout) : []) {
    const mounts = await docker.exec([
      'inspect',
      '--format',
      `{{range .Mounts}}{{if eq .Destination "${DATA_DIR}"}}{{.Type}} {{.Name}}{{"\\n"}}{{end}}{{end}}`,
      id,
    ]);
    const [type, name] = (mounts.code === 0 ? firstLine(mounts.stdout) : '').split(' ');
    if (type === 'volume' && name) return { volume: name };
  }
  return {
    problem: `${unset}, "${project}", but it has no worker-data volume and no worker with a volume at ${DATA_DIR}. Start the whole instance with docker compose up -d, or set DEVAILOOP_DATA_VOLUME to the name of the worker's data volume.`,
  };
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
