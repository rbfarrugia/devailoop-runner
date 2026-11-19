// Bundles the runner into JavaScript, so the published image holds no TypeScript source
// (apps/runner/Dockerfile).
//
//   node apps/runner/bundle.mjs <outDir>
//
// Writes <outDir>/dist/main.js, and beside it what the runner reads at run time:
//   seccomp/agent.json  src/docker-args.ts (SECCOMP_PROFILE)
//   agent-base/         src/agent-base.ts (the files the base image's Dockerfile copies in)
// This file, and the Dockerfile, run both in the DevAILoop repository and in the public runner
// repository (docs/ci-cd.md), so they use paths relative to apps/runner only.
import { build } from 'esbuild';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '../..');

/** Bundles the runner into <outDir>/dist and copies the files it reads beside itself. */
export async function bundle({ outDir }) {
  await build({
    absWorkingDir: root,
    entryPoints: { main: 'apps/runner/src/main.ts' },
    bundle: true,
    splitting: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    outdir: resolve(outDir, 'dist'),
    // The only package the runner imports from the rest of the repository; resolved without an install.
    alias: { '@devailoop/runner-shared': resolve(root, 'packages/runner-shared/src/index.ts') },
    sourcemap: false,
    // Bundled CommonJS packages call require() for Node's own modules.
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    logLevel: 'warning',
  });
  mkdirSync(resolve(outDir, 'seccomp'), { recursive: true });
  cpSync(resolve(here, 'seccomp/agent.json'), resolve(outDir, 'seccomp/agent.json'));
  cpSync(resolve(here, 'agent-base'), resolve(outDir, 'agent-base'), { recursive: true });
  writeFileSync(resolve(outDir, 'package.json'), '{"type":"module"}\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('Usage: node apps/runner/bundle.mjs <outDir>');
    process.exit(1);
  }
  await bundle({ outDir: resolve(outDir) });
}
