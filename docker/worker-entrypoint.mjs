// The worker's entrypoint, built into the image that docker-compose.worker.yml builds on the
// customer's PC (the compose file carries a copy of this file; a test keeps them equal). It enrols
// the worker if need be, fetches the worker bundle from the server, installs the Agent SDK from
// npm at the version the bundle's manifest names, and runs the bundle. Nothing here is secret.
// It holds no dollar sign, so that Compose does not interpolate it.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const dataDir = env.DEVAILOOP_DATA_DIR || '/data';
const withoutSlash = (url) => (url.endsWith('/') ? withoutSlash(url.slice(0, -1)) : url);
const server = withoutSlash(env.DEVAILOOP_SERVER_URL || '');
const registry = withoutSlash(env.DEVAILOOP_NPM_REGISTRY || 'https://registry.npmjs.org');
const bundlesDir = join(dataDir, 'bundle');
const credentialFile = join(dataDir, 'worker-credential', 'credential.json');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function fail(message) {
  console.error('devailoop worker: ' + message);
  process.exit(1);
}
/** The server cannot be reached: a network error or a 5xx. */
class Unreachable extends Error {}

async function call(path, options = {}) {
  let response;
  try {
    response = await fetch(server + path, options);
  } catch (error) {
    throw new Unreachable('cannot reach ' + server + ': ' + (error.cause?.message || error.message));
  }
  if (response.status >= 500) throw new Unreachable(server + ' answered ' + response.status);
  return response;
}

async function message(response) {
  try {
    return (await response.json()).error?.message || 'The server answered ' + response.status + '.';
  } catch {
    return 'The server answered ' + response.status + '.';
  }
}

async function credential() {
  const token = env.DEVAILOOP_ENROLMENT_TOKEN;
  let stored = null;
  try {
    stored = JSON.parse(readFileSync(credentialFile, 'utf8'));
  } catch {}
  if (stored?.credential && (!token || sha256(token) === stored.enrolledWith)) return stored.credential;
  if (!token) fail('this worker has no credential yet, and DEVAILOOP_ENROLMENT_TOKEN is not set in .env.');
  const response = await call('/api/worker/enrol', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enrolmentToken: token }),
  });
  if (!response.ok) {
    if (stored?.credential) {
      console.error('devailoop worker: the enrolment token in .env was refused; carrying on with the stored credential.');
      return stored.credential;
    }
    fail('enrolment was refused. ' + (await message(response)));
  }
  const { credential } = await response.json();
  mkdirSync(join(dataDir, 'worker-credential'), { recursive: true, mode: 0o700 });
  writeFileSync(credentialFile, JSON.stringify({ credential, enrolledWith: sha256(token) }, null, 2) + '\n', { mode: 0o600 });
  return credential;
}

/** The sha256 of the bundle this worker last ran, if its folder is still there. */
function current() {
  try {
    const sha = readFileSync(join(bundlesDir, 'current'), 'utf8').trim();
    return existsSync(join(bundlesDir, sha, 'dist', 'main.js')) ? sha : null;
  } catch {
    return null;
  }
}

/** Fetches the bundle when the server has a newer one than `have`. Returns the sha256 to run. */
async function fetchBundle(credential, have) {
  const headers = { authorization: 'Bearer ' + credential };
  const response = await call('/api/worker/bundle', { headers: have ? { ...headers, 'if-none-match': '"' + have + '"' } : headers });
  if (response.status === 304 && have) return have;
  if (response.status === 401 || response.status === 403) fail('the server refused this worker (' + response.status + '): it has been revoked. Add it again on the Workers page.');
  if (!response.ok) fail('the server would not send the worker bundle. ' + (await message(response)));
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha = sha256(bytes);
  const announced = (response.headers.get('x-devailoop-bundle-sha256') || '').toLowerCase();
  if (sha !== announced) fail('the bundle downloaded has sha256 ' + sha + ', not the ' + announced + ' the server announced. Refusing to run it.');
  const manifestResponse = await call('/api/worker/bundle/manifest', { headers });
  if (!manifestResponse.ok) fail('the server would not send the bundle manifest. ' + (await message(manifestResponse)));
  const manifest = await manifestResponse.json();
  if (manifest.sha256 !== sha) fail('the manifest names sha256 ' + manifest.sha256 + ', not ' + sha + '. Refusing to run the bundle.');
  const target = join(bundlesDir, sha);
  const staging = target + '.new';
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  writeFileSync(staging + '.tar.gz', bytes);
  const untar = spawnSync('tar', ['-xzf', staging + '.tar.gz', '-C', staging], { stdio: 'inherit' });
  rmSync(staging + '.tar.gz', { force: true });
  if (untar.status !== 0) fail('the bundle could not be unpacked.');
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest));
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  writeFileSync(join(bundlesDir, 'current'), sha + '\n');
  // The new bundle is in place: the old ones can go.
  for (const name of readdirSync(bundlesDir)) if (name !== sha && name !== 'current') rmSync(join(bundlesDir, name), { recursive: true, force: true });
  return sha;
}

/** Installs one npm package from the registry into `dir`, checking the integrity hash the manifest holds. */
async function install(name, version, integrity, dir) {
  if (existsSync(join(dir, 'package.json'))) return;
  const response = await fetch(registry + '/' + name + '/-/' + name.split('/')[1] + '-' + version + '.tgz');
  if (!response.ok) fail('npm answered ' + response.status + ' for ' + name + '@' + version + '.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if ('sha512-' + createHash('sha512').update(bytes).digest('base64') !== integrity) fail(name + '@' + version + ' does not match the integrity hash in the manifest. Refusing to install it.');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = dir + '.tgz';
  writeFileSync(file, bytes);
  const untar = spawnSync('tar', ['-xzf', file, '-C', dir, '--strip-components=1'], { stdio: 'inherit' });
  rmSync(file, { force: true });
  if (untar.status !== 0) fail(name + '@' + version + ' could not be unpacked.');
}

/** The Agent SDK, and Claude Code with it, at the manifest's version: cached per version in the volume. */
async function installSdk(bundleDir) {
  const manifest = JSON.parse(readFileSync(join(bundlesDir, bundleDir, 'manifest.json'), 'utf8'));
  const { sdk } = manifest;
  const platform = sdk.name + '-linux-' + (process.arch === 'arm64' ? 'arm64' : 'x64');
  const cache = join(dataDir, 'sdk', sdk.version, 'node_modules'); // a node_modules tree, so the SDK finds its platform package from its real path
  const wanted = [[sdk.name, sdk.integrity], [platform, sdk.platforms[platform]]];
  for (const [name, integrity] of wanted) {
    if (!integrity) fail('the manifest has no integrity hash for ' + name + '.');
    await install(name, sdk.version, integrity, join(cache, name));
    const link = join(bundlesDir, bundleDir, 'node_modules', name);
    if (!existsSync(link)) {
      mkdirSync(join(link, '..'), { recursive: true });
      symlinkSync(join(cache, name), link);
    }
  }
  return manifest;
}

const setup = process.argv[2] === 'setup-github';
if (!server) fail('DEVAILOOP_SERVER_URL is not set in .env.');
mkdirSync(bundlesDir, { recursive: true });
let sha = current();
try {
  sha = await fetchBundle(await credential(), sha);
} catch (error) {
  if (!(error instanceof Unreachable) || !sha) fail(error.message);
  console.error('devailoop worker: ' + error.message + '; starting the cached bundle ' + sha + '.');
}
const manifest = await installSdk(sha);

const script = setup ? 'setup-github.js' : 'main.js';
const child = spawn('node', [join(bundlesDir, sha, 'dist', script), ...process.argv.slice(setup ? 3 : 2)], {
  stdio: 'inherit',
  env: { ...env, DEVAILOOP_BUNDLE_SHA256: sha, DEVAILOOP_VERSION: manifest.version },
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
