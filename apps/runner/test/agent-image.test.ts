import { describe, expect, it } from 'vitest';
import { retiredAgentImageWarning } from '../src/agent-image';

describe('DEVAILOOP_AGENT_IMAGE, which is no longer used', () => {
  it('says nothing when it is unset, empty or the stock image', () => {
    expect(retiredAgentImageWarning(undefined)).toBeNull();
    expect(retiredAgentImageWarning('')).toBeNull();
    expect(retiredAgentImageWarning(' ')).toBeNull();
    expect(retiredAgentImageWarning('devailoop-agent-base')).toBeNull();
  });

  it('warns when it names another image, pointing to the upgrade note', () => {
    const warning = retiredAgentImageWarning('devailoop-agent-toolchains');
    expect(warning).toContain('DEVAILOOP_AGENT_IMAGE is set to devailoop-agent-toolchains, but it is no longer used');
    expect(warning).toContain("each Project's Environment");
    expect(warning).toContain('Upgrading from an instance-wide toolchain image');
  });
});
