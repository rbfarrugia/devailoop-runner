import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain script with no type declarations.
import { bundle } from '../bundle.mjs';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('the bundled runner', () => {
  it('is JavaScript with no source maps, beside the files it reads at run time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devailoop-runner-bundle-'));
    dirs.push(dir);
    await bundle({ outDir: dir });
    expect(readdirSync(join(dir, 'dist'))).toEqual(['main.js']);
    expect(readFileSync(join(dir, 'dist/main.js'), 'utf8')).not.toContain('sourceMappingURL');
    expect(readdirSync(dir).sort()).toEqual(['agent-base', 'dist', 'package.json', 'seccomp']);
    expect(readdirSync(join(dir, 'seccomp'))).toEqual(['agent.json']);
  }, 60_000);
});
