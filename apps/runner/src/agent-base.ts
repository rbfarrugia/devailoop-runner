import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AGENT_BASE_IMAGE } from '@devailoop/runner-shared';

/** The platforms of Claude Code that agent-base can be built for, by the architecture BuildKit names them with. */
export const CLAUDE_PLATFORMS = { amd64: 'linux-x64', arm64: 'linux-arm64' } as const;

/** What the worker asks for: the Claude Code version, and the npm integrity of its package for each platform. */
export interface EnsureBaseImageInput {
  sdkVersion: string;
  integrity: Record<(typeof CLAUDE_PLATFORMS)[keyof typeof CLAUDE_PLATFORMS], string>;
}

/** The recipe's own files, which the runner carries beside its code (like seccomp/agent.json). */
export const AGENT_BASE_CONTEXT = fileURLToPath(new URL('../agent-base/', import.meta.url));

/** Where Claude Code comes from. Nothing else is ever downloaded and run. */
const REGISTRY = 'https://registry.npmjs.org';
const SDK_PACKAGE = 'claude-agent-sdk';

/** What agent-base is built on: Node 24 on Debian, as the worker's image is. */
export const NODE_BASE_IMAGE = 'node:24-bookworm-slim';

/** The labels that say what an agent-base was built from. */
export const SDK_VERSION_LABEL = 'devailoop.agent-base.sdk-version';
export const RECIPE_LABEL = 'devailoop.agent-base.recipe';

/** Semantic Versioning 2.0: no leading `v`, no leading zeros, an optional pre-release and no build metadata. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
/** What npm prints as `integrity` for a tarball: sha512 in base64 (64 bytes, so 86 characters and `==`). */
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** Why a request is refused, or null. Only what passes is ever written into the Dockerfile. */
export function ensureBaseImageProblem(input: unknown): string | null {
  const { sdkVersion, integrity } = (input ?? {}) as { sdkVersion?: unknown; integrity?: unknown };
  if (typeof sdkVersion !== 'string' || sdkVersion.length > 64 || !SEMVER.test(sdkVersion))
    return 'sdkVersion must be a version such as 1.2.3 (semver, with no leading "v" and no build metadata)';
  if (typeof integrity !== 'object' || integrity === null || Array.isArray(integrity))
    return 'integrity must give the npm integrity of each platform';
  const given = Object.keys(integrity).sort();
  const wanted = Object.values(CLAUDE_PLATFORMS).sort();
  if (given.join() !== wanted.join()) return `integrity must name exactly ${wanted.join(' and ')}`;
  for (const [platform, hash] of Object.entries(integrity as Record<string, unknown>))
    if (typeof hash !== 'string' || !INTEGRITY.test(hash))
      return `the integrity for ${platform} must be an npm sha512-… hash`;
  return null;
}

/**
 * The Dockerfile of devailoop-agent-base: what the Agent's sessions run in, kept small and free of
 * DevAILoop's own code. Claude Code's binary is the SDK's platform package for the architecture
 * being built, fetched from npm and checked against the integrity before anything is installed.
 */
export function agentBaseDockerfile(input: EnsureBaseImageInput): string {
  const { sdkVersion, integrity } = input;
  const tarball = (platform: string) =>
    `${REGISTRY}/@anthropic-ai/${SDK_PACKAGE}-${platform}/-/${SDK_PACKAGE}-${platform}-${sdkVersion}.tgz`;
  const arm = (arch: string, platform: keyof typeof integrity) =>
    `${arch}) url='${tarball(platform)}'; integrity='${integrity[platform]}';;`;
  return `FROM ${NODE_BASE_IMAGE}
ARG TARGETARCH
# git for working copies; bubblewrap and socat are what the Agent's sandbox is built on.
# python3-minimal because the Agent reaches for \`python3 -\` to script edits; a Project that
# needs pip, venv or the full standard library adds them in its Environment.
RUN apt-get update \\
 && apt-get install -y --no-install-recommends git bubblewrap socat ripgrep ca-certificates procps curl python3-minimal \\
 && rm -rf /var/lib/apt/lists/* \\
 && npm install -g pnpm@10.33.2 @anthropic-ai/sandbox-runtime@0.0.82
# The same uid as the worker's agent user, so both can work on the files in /data. The runner
# makes /var/lib/devailoop-sandbox Claude Code's TMPDIR (SANDBOX_TMPDIR), so the sandbox's own
# sockets are kept there, out of /tmp and out of every command's reach. The runner's sandbox
# check refuses an image without it.
RUN useradd --uid 1001 --create-home --shell /bin/bash agent \\
 && mkdir /data && chown agent:agent /data \\
 && mkdir -p /var/lib/devailoop-sandbox && chown agent:agent /var/lib/devailoop-sandbox && chmod 700 /var/lib/devailoop-sandbox
# Claude Code ${sdkVersion}: the SDK's native binary, taken from npm only if the tarball is the one the integrity names.
RUN case "$TARGETARCH" in \\
 ${arm('amd64', 'linux-x64')} \\
 ${arm('arm64', 'linux-arm64')} \\
 *) echo "no Claude Code for $TARGETARCH" >&2; exit 1;; \\
 esac \\
 && curl -fsSL --retry 3 -o /tmp/claude.tgz "$url" \\
 && node -e 'const h="sha512-"+require("crypto").createHash("sha512").update(require("fs").readFileSync("/tmp/claude.tgz")).digest("base64"); if (h !== process.argv[1]) { console.error("the tarball does not match its integrity hash"); process.exit(1); }' "$integrity" \\
 && mkdir /tmp/claude-package && tar -xzf /tmp/claude.tgz -C /tmp/claude-package --strip-components=1 package/claude \\
 && install -m 755 /tmp/claude-package/claude /usr/local/bin/claude \\
 && rm -rf /tmp/claude.tgz /tmp/claude-package
# Starts a display that works inside the sandbox, for Projects that need one. Xvfb itself is
# not here, to keep the image small: a Project's Environment adds it (docs/agent-containers.md,
# "Xvfb in the Environment").
COPY --chmod=755 devailoop-display /usr/local/bin/devailoop-display
USER agent
CMD ["claude", "--version"]
`;
}

/** What names a build of agent-base: its Dockerfile and the files it copies. Equal recipes give the same image. */
export function agentBaseRecipe(dockerfile: string, contextDir: string = AGENT_BASE_CONTEXT): string {
  const display = readFileSync(`${contextDir}devailoop-display`);
  return createHash('sha256').update(dockerfile).update('\0').update(display).digest('hex');
}

/** The `docker buildx build` arguments for one build of agent-base; the Dockerfile comes on stdin. */
export function agentBaseBuildArgs(input: {
  builder: string;
  tag: string;
  sdkVersion: string;
  recipe: string;
  contextDir?: string;
}): string[] {
  return [
    'buildx',
    'build',
    '--builder',
    input.builder,
    '--load',
    '--progress=plain',
    '--label',
    `${SDK_VERSION_LABEL}=${input.sdkVersion}`,
    '--label',
    `${RECIPE_LABEL}=${input.recipe}`,
    '--tag',
    input.tag,
    '--file',
    '-',
    input.contextDir ?? AGENT_BASE_CONTEXT,
  ];
}

export const candidateBaseTag = (suffix: string) => `${AGENT_BASE_IMAGE}:candidate-${suffix}`;
