import { AGENT_BASE_IMAGE } from '@devailoop/runner-shared';

/**
 * The warning for an instance that still sets DEVAILOOP_AGENT_IMAGE, or null. It once pointed
 * the runner at an instance-wide toolchain image; now each Project's Environment holds its
 * tools, and sessions of a Project without one always run in devailoop-agent-base. The runner
 * still starts, so the Environments the tools move to can be built.
 */
export function retiredAgentImageWarning(value: string | undefined): string | null {
  const image = value?.trim();
  if (!image || image === AGENT_BASE_IMAGE) return null;
  return (
    `DEVAILOOP_AGENT_IMAGE is set to ${image}, but it is no longer used: sessions run in their Project's Environment image, or else ${AGENT_BASE_IMAGE}. ` +
    `Move what ${image} adds into each Project's Environment and remove the setting from docker-compose.override.yml ` +
    `(docs/install.md, "Upgrading from an instance-wide toolchain image").`
  );
}
