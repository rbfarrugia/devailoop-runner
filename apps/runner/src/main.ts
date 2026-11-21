import { hostname } from 'node:os';
import { AGENT_BASE_IMAGE, createLogger } from '@devailoop/runner-shared';
import { retiredAgentImageWarning } from './agent-image';
import { builderName } from './builder';
import { findDataVolume } from './data-volume';
import { agentContainerSettings, dockerVersionProblem } from './docker-args';
import { removeLeftoverBaseCandidates, removeLeftoverCandidates } from './images';
import { createRunner, realDocker, removeLeftoverContainers } from './server';

const log = createLogger('runner');

/** Says in one line why the runner will not start, and stops. */
function refuse(why: string): never {
  log.error(`not starting. ${why}`);
  process.exit(1);
}

const port = Number(process.env.DEVAILOOP_RUNNER_PORT || 7070);
if (!Number.isInteger(port) || port <= 0)
  refuse(`DEVAILOOP_RUNNER_PORT is "${process.env.DEVAILOOP_RUNNER_PORT}". It must be a port number.`);
const container = agentContainerSettings(process.env);
if ('problem' in container) refuse(container.problem);
const limits = container.settings;
const image = AGENT_BASE_IMAGE;
const retired = retiredAgentImageWarning(process.env.DEVAILOOP_AGENT_IMAGE);
if (retired) log.warn(retired);

const version = await realDocker.exec(['version', '--format', '{{.Server.Version}}']);
if (version.code !== 0) refuse(`Docker cannot be reached: ${version.stderr.trim().split('\n')[0]}`);
const tooOld = dockerVersionProblem(version.stdout);
if (tooOld) refuse(tooOld);

// In a container, its host name is its id, which is how the runner finds its own Compose project.
const found = await findDataVolume(realDocker, { given: process.env.DEVAILOOP_DATA_VOLUME, self: hostname() });
if ('problem' in found) refuse(found.problem);
const dataVolume = found.volume;

const removed = await removeLeftoverContainers(realDocker, dataVolume);
if (removed > 0) log.info(`removed ${removed} container(s) left over from earlier sessions`);
// No build is under way before the runner listens, so every candidate tag is one a stopped build left behind.
const candidates = await removeLeftoverCandidates(realDocker, dataVolume);
if (candidates > 0) log.info(`removed ${candidates} image(s) left over from builds that were cut off`);
const baseCandidates = await removeLeftoverBaseCandidates(realDocker, AGENT_BASE_IMAGE);
if (baseCandidates > 0)
  log.info(`removed ${baseCandidates} ${AGENT_BASE_IMAGE} candidate(s) left over from base builds that were cut off`);

const server = createRunner({ docker: realDocker, image, dataVolume, limits });
server.listen(port, () =>
  log.info(
    `listening on ${port}, sessions run in ${image} (or their Project's Environment image) with parts of ${dataVolume} under /data (Docker ${version.stdout.trim()}); each container may take ${limits.memory} of memory and ${limits.pids} processes${limits.cpus ? ` and ${limits.cpus} CPUs` : ''}, builds run in the builder ${builderName(dataVolume)} with the same limits (${limits.buildkitImage}), system calls filtered by ${limits.seccomp === 'unconfined' ? 'nothing (DEVAILOOP_AGENT_SECCOMP=unconfined)' : "the runner's profile"}, AppArmor profile ${limits.apparmor}`,
  ),
);

function shutdown() {
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
