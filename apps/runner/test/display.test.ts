import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** The launcher the agent-base image puts on the PATH as devailoop-display. */
const LAUNCHER = resolve(import.meta.dirname, '../agent-base/devailoop-display');

/**
 * Stands in for Xvfb: notes its arguments, then listens on TCP 6000+n of the loopback, as the
 * real one does with `-listen tcp`, until it is stopped. A display named in FAKE_XVFB_FAILS
 * ends at once, as Xvfb does when it finds the display taken.
 */
const FAKE_XVFB = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { createServer } = require('node:net');
const display = Number(process.argv[2].slice(1));
appendFileSync(process.env.FAKE_XVFB_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
if ((process.env.FAKE_XVFB_FAILS || '').split(',').includes(String(display))) {
  console.error('Server is already active for display ' + display);
  process.exit(1);
}
const server = createServer((socket) => socket.end()).listen(6000 + display, '127.0.0.1');
process.on('SIGTERM', () => { appendFileSync(process.env.FAKE_XVFB_LOG, 'stopped\\n'); server.close(); process.exit(0); });
`;

/** Stands in for an X client: connects to whatever DISPLAY names over TCP, and says so. */
const CLIENT = `node -e '
const display = process.env.DISPLAY;
const n = Number(display.replace(/^localhost:/, ""));
require("node:net").connect(6000 + n, "127.0.0.1")
  .on("connect", () => { console.log("connected to " + display); process.exit(Number(process.argv[1] || 0)); })
  .on("error", (e) => { console.log("could not connect: " + e.code); process.exit(9); });
'`;

describe('devailoop-display', () => {
  let dir: string;
  let bin: string;
  let locks: string;
  let first: number;
  const blockers: Server[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devailoop-display-'));
    bin = join(dir, 'bin');
    locks = join(dir, 'locks');
    await mkdir(bin);
    await mkdir(locks);
    await writeFile(join(bin, 'Xvfb'), FAKE_XVFB);
    await chmod(join(bin, 'Xvfb'), 0o755);
    // Far from any real display, so a test never meets one. The X port is 6000 + the display; that
    // stays below the range the system hands out to other processes' listeners (from 32768), which
    // the other packages' suites run at the same time.
    first = 20000 + Math.floor(Math.random() * 6000);
  });
  afterEach(async () => {
    for (const blocker of blockers.splice(0)) blocker.close();
    await rm(dir, { recursive: true, force: true });
  });

  function launch(args: string[], env: Record<string, string> = {}, path = `${bin}:${process.env.PATH}`) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn('/bin/bash', [LAUNCHER, ...args], {
        env: {
          PATH: path,
          TMPDIR: dir,
          FAKE_XVFB_LOG: join(dir, 'xvfb.log'),
          DEVAILOOP_DISPLAY_FIRST: String(first),
          DEVAILOOP_DISPLAY_LOCK_DIR: locks,
          DEVAILOOP_DISPLAY_WAIT_SECONDS: '5',
          ...env,
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => (stdout += data));
      child.stderr.on('data', (data) => (stderr += data));
      child.on('close', (code) => done({ code, stdout, stderr }));
    });
  }
  const xvfbLog = async () => (await readFile(join(dir, 'xvfb.log'), 'utf8')).trim().split('\n');
  const accepting = (port: number) =>
    new Promise<boolean>((done) => {
      const socket = connect(port, '127.0.0.1');
      socket.on('connect', () => (socket.destroy(), done(true))).on('error', () => done(false));
    });

  it('runs the command against Xvfb on TCP only, at DISPLAY=localhost:<n>, and stops Xvfb afterwards', async () => {
    const result = await launch(['bash', '-c', CLIENT]);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(`connected to localhost:${first}`);
    expect(result.code).toBe(0);
    expect(await xvfbLog()).toEqual([
      JSON.stringify([`:${first}`, '-listen', 'tcp', '-nolisten', 'unix', '-screen', '0', '1280x1024x24']),
      'stopped',
    ]);
    // -nolock is for root only: as the agent user, Xvfb would only warn about it.
    expect((await xvfbLog())[0]).not.toContain('-nolock');
    expect(await accepting(6000 + first)).toBe(false);
    // Its log was in /tmp (the lock directory here), and is gone.
    expect(await readdir(locks)).toEqual([]);
  });

  it("ends with the command's own exit code", async () => {
    const result = await launch(['bash', '-c', `${CLIENT} 5`]);
    expect(result.stdout.trim()).toBe(`connected to localhost:${first}`);
    expect(result.code).toBe(5);
  });

  it('passes the arguments on as they are', async () => {
    const result = await launch(['node', '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'a b', '"c"']);
    expect(JSON.parse(result.stdout)).toEqual(['a b', '"c"']);
  });

  it('skips a display whose lock file is there, or whose port is taken', async () => {
    await writeFile(join(locks, `.X${first}-lock`), '');
    const blocker = createServer().listen(6000 + first + 1, '127.0.0.1');
    blockers.push(blocker);
    await new Promise((done) => blocker.once('listening', done));

    const result = await launch(['bash', '-c', CLIENT]);
    expect(result.stdout.trim()).toBe(`connected to localhost:${first + 2}`);
    expect(result.code).toBe(0);
  });

  it('tries the next display when Xvfb ends before it is ready', async () => {
    const result = await launch(['bash', '-c', CLIENT], { FAKE_XVFB_FAILS: String(first) });
    expect(result.stdout.trim()).toBe(`connected to localhost:${first + 1}`);
    expect(result.code).toBe(0);
  });

  it('gives up after its tries, saying what Xvfb said', async () => {
    const result = await launch(['bash', '-c', CLIENT], {
      FAKE_XVFB_FAILS: `${first},${first + 1}`,
      DEVAILOOP_DISPLAY_TRIES: '2',
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`no display could be started on :${first} to :${first + 1}`);
    expect(result.stderr).toContain(`Server is already active for display ${first + 1}`);
  });

  it('says so at once when Xvfb is not installed', async () => {
    const result = await launch(['true'], {}, join(dir, 'nothing-here'));
    expect(result.code).toBe(127);
    expect(result.stderr).toContain('Xvfb is not installed in this image');
  });

  it('says so, without starting Xvfb, when /tmp is missing or not writable', async () => {
    const readOnly = join(dir, 'read-only');
    await mkdir(readOnly);
    await chmod(readOnly, 0o555);
    try {
      for (const where of [join(dir, 'nowhere'), readOnly]) {
        const result = await launch(['true'], { DEVAILOOP_DISPLAY_LOCK_DIR: where });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`${where} is not writable (does this Project need a display?)`);
      }
      await expect(readFile(join(dir, 'xvfb.log'), 'utf8')).rejects.toThrow();
    } finally {
      await chmod(readOnly, 0o755);
    }
  });

  it('needs a command', async () => {
    const result = await launch([]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('usage: devailoop-display <command>');
  });
});
