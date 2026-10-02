import { createHash } from 'node:crypto';
import { readFile, writeFile, chmod, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bool, executable, output, projectDirectory, run, summary } from './common.mjs';

const upstream = 'https://packages.jetbrains.team/maven/p/amper/amper/org/jetbrains/kotlin/kotlin-cli';
export function version(value) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(value)) throw new Error('Expected an exact toolchain version');
  const [major, minor] = value.split('.').map(Number);
  if (major === 0 && minor < 12) throw new Error('Kotlin Toolchain >= 0.12.0 is required');
  return value;
}
export function wrapperPin(bytes) {
  const text = bytes.toString('utf8');
  const versions = [...text.matchAll(/^(?:set )?kotlin_cli_version=(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)\r?$/gm)];
  const hashes = [...text.matchAll(/^(?:set )?kotlin_cli_sha256=([a-fA-F0-9]{64})\r?$/gm)];
  if (versions.length !== 1 || hashes.length !== 1) throw new Error('Invalid wrapper pin');
  return { version: version(versions[0][1]), checksum: hashes[0][1].toLowerCase() };
}
export function verify(bytes, sha) {
  if (!/^[a-fA-F0-9]{64}$/.test(sha) || createHash('sha256').update(bytes).digest('hex') !== sha.toLowerCase()) throw new Error('Wrapper SHA-256 mismatch');
}
async function get(url, headers = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) { if (attempt === 2) throw error; }
  }
}
export async function downloadWrappers(target, download = get) {
  version(target);
  const files = await Promise.all(['kotlin', 'kotlin.bat'].map(async name => {
    const url = `${upstream}/${target}/kotlin-cli-${target}-wrapper${name.endsWith('.bat') ? '.bat' : ''}`;
    const [bytes, hash] = await Promise.all([download(url), download(`${url}.sha256`)]);
    verify(bytes, hash.toString('utf8').trim());
    const pin = wrapperPin(bytes);
    if (pin.version !== target) throw new Error('Upstream wrapper has the wrong version');
    return { name, bytes, pin };
  }));
  if (files[0].pin.checksum !== files[1].pin.checksum) throw new Error('Upstream wrappers disagree on the distribution checksum');
  return files;
}
export function newer(candidate, current) {
  const left = version(candidate).split('-')[0].split('.').map(Number);
  const right = version(current).split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return !candidate.includes('-') && current.includes('-');
}
export async function update(env = process.env) {
  const createPR = bool(env.INPUT_CREATE_PR ?? 'true', 'create-pull-request');
  const validate = bool(env.INPUT_VALIDATE ?? 'true', 'validate');
  if (createPR && env.GITHUB_EVENT_NAME && !['push', 'schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) {
    throw new Error('PR creation is only supported on push, schedule, or workflow_dispatch');
  }
  const cwd = await projectDirectory(env.INPUT_DIRECTORY, env);
  const gitRoot = run('git', ['rev-parse', '--show-toplevel'], { cwd, quiet: true });
  if (gitRoot.status) throw new Error('The project must be checked out with Git');
  const root = gitRoot.stdout.trim();
  const relative = path.relative(root, cwd).split(path.sep).join('/');
  if (!/^[A-Za-z0-9_./ -]*$/.test(relative)) throw new Error('Unsupported project directory characters');
  const paths = ['kotlin', 'kotlin.bat'].map(name => relative ? `${relative}/${name}` : name);
  const dirty = run('git', ['status', '--porcelain', '--', ...paths.map(p => `:(literal)${p}`)], { cwd: root, quiet: true });
  if (dirty.status || dirty.stdout.trim()) throw new Error('Commit wrapper changes before running the updater');
  const originals = await Promise.all(['kotlin', 'kotlin.bat'].map(async name => {
    try { return await readFile(path.join(cwd, name)); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }));
  const pins = originals.filter(Boolean).map(wrapperPin);
  if (!pins.length) throw new Error('No existing Kotlin Toolchain wrappers found');
  if (pins.some(pin => pin.version !== pins[0].version || pin.checksum !== pins[0].checksum)) throw new Error('Project wrappers disagree');
  let target = env.INPUT_VERSION || 'latest';
  if (target === 'latest') {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Heapy-update-kotlin-toolchain' };
    if (env.INPUT_TOKEN) headers.Authorization = `Bearer ${env.INPUT_TOKEN}`;
    const release = JSON.parse((await get('https://api.github.com/repos/JetBrains/kotlin-toolchain/releases/latest', headers)).toString('utf8'));
    target = version(String(release.tag_name).replace(/^v/, ''));
    if (!newer(target, pins[0].version)) target = pins[0].version;
  } else target = version(target);
  const files = await downloadWrappers(target);
  const changed = files.some((file, index) => !originals[index] || originals[index].toString('utf8').replaceAll('\r\n', '\n') !== file.bytes.toString('utf8').replaceAll('\r\n', '\n'));
  if (changed) {
    // Verify both downloads before replacing either tracked file.
    for (const file of files) {
      const temp = path.join(cwd, `.${file.name}.update-${process.pid}`);
      try {
        await writeFile(temp, file.bytes, { flag: 'wx', mode: 0o755 });
        await rename(temp, path.join(cwd, file.name));
      } finally { await rm(temp, { force: true }); }
    }
    if (process.platform !== 'win32') await chmod(path.join(cwd, 'kotlin'), 0o755);
    if (validate) {
      const cli = await executable(cwd, env, true);
      const childEnv = { ...env, KOTLIN_CLI_WRAPPER_ALWAYS_USE_INTRINSIC_VERSION: '1', KOTLIN_CLI_NO_WELCOME_BANNER: '1' };
      // PR credentials are not needed while executing project build code.
      delete childEnv.INPUT_TOKEN;
      for (const command of ['build', 'check']) {
        if (run(cli, [command], { cwd, env: childEnv }).status !== 0) throw new Error(`Updated toolchain failed ${command}; no PR will be created`);
      }
    }
  }
  for (const [key, value] of Object.entries({ version: target, 'previous-version': pins[0].version, changed: String(changed),
    'wrapper-paths': paths.map(p => `:(literal)${p}`).join(','), validated: String(changed && validate) })) await output(key, value, env);
  await summary(`### Kotlin Toolchain update\n\n${pins[0].version} → ${target}\n\nWrappers changed: ${changed}. Validation: ${changed && validate ? 'build and check passed' : 'not run'}.\n`, env);
  return { changed, version: target };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  update().catch(error => { console.error(error.message); process.exitCode = 1; });
}
