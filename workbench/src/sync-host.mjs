import {createHash, randomUUID} from 'node:crypto';
import {readFile, writeFile, mkdir, mkdtemp, rename, rm} from 'node:fs/promises';
import {join, resolve, dirname, basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {createWorkbenchServer} from './serve.mjs';

const files = ['index.html', 'bulk.enc.json'];
const repository = 'whdudwns33-wb/wb-site';
const pages = 'https://whdudwns33-wb.github.io/wb-site/workbench/';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => files.every(file => a[file] === b[file]);
async function hashes(directory) {
  return Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(join(directory, file)))])));
}
async function readPointer(file) {
  let raw;
  try { raw = await readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const data = JSON.parse(raw);
  if (!/^[a-f0-9]{40}$/.test(data.commit)) throw Error('Invalid current release pointer.');
  return {raw, commit: data.commit};
}
async function writeAtomic(file, bytes) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try { await writeFile(temp, bytes, {flag: 'wx'}); await rename(temp, file); }
  finally { await rm(temp, {force: true}); }
}
async function get(fetcher, url) {
  const response = await fetcher(url, {headers: {'User-Agent': 'wb-workbench-host-sync', 'Cache-Control': 'no-cache'}, signal: AbortSignal.timeout(25000)});
  if (!response.ok) throw Error('Published release download failed: HTTP ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw Error('Published file has an invalid size.');
  return bytes;
}
async function restartWorkbench() {
  await promisify(execFile)('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
    "$ErrorActionPreference='Stop'; Stop-ScheduledTask -TaskName WB_Workbench_Server; Start-ScheduledTask -TaskName WB_Workbench_Server",
  ], {windowsHide: true, timeout: 25000});
}
async function verifyWorkbench(expected, fetcher) {
  const until = Date.now() + 45000;
  do {
    try {
      const response = await fetcher('http://127.0.0.1:18960/healthz', {signal: AbortSignal.timeout(3000)});
      if (!response.ok) throw Error('Server not ready.');
      const actual = await response.json();
      if (actual.ok && actual.hashes && same(actual.hashes, expected)) return;
    } catch {}
    await delay(500);
  } while (Date.now() < until);
  throw Error('Local server verification failed.');
}

export async function syncHost(runtimeRoot, {fetcher = globalThis.fetch, restart = restartWorkbench, verify = verifyWorkbench} = {}) {
  if (typeof runtimeRoot !== 'string' || !runtimeRoot.trim()) throw Error('WB_WORKBENCH_RUNTIME is required.');
  const root = resolve(runtimeRoot), protectedRoot = join(root, 'protected'), releaseRoot = join(root, 'releases');
  await mkdir(protectedRoot, {recursive: true});
  await mkdir(releaseRoot, {recursive: true});
  const pointerFile = join(protectedRoot, 'current-release.json'), previous = await readPointer(pointerFile);
  const oldHashes = await hashes(previous ? join(releaseRoot, previous.commit) : join(root, 'public'));
  const reference = JSON.parse(await get(fetcher, 'https://api.github.com/repos/' + repository + '/git/ref/heads/main'));
  const commit = reference.object?.sha;
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('Invalid published main revision.');
  const bytes = await Promise.all(files.map(file => get(fetcher, 'https://raw.githubusercontent.com/' + repository + '/' + commit + '/workbench/' + file)));
  const expected = Object.fromEntries(files.map((file, i) => [file, digest(bytes[i])]));
  let stage, switched = false;
  const result = {commit, hashes: expected, checkedAt: new Date().toISOString()};
  try {
    stage = await mkdtemp(join(releaseRoot, '.stage-'));
    await Promise.all(files.map((file, i) => writeFile(join(stage, file), bytes[i], {flag: 'wx'})));
    createWorkbenchServer(stage);
    result.build = JSON.parse(bytes[1]).t;
    const live = await Promise.all(files.map(file => get(fetcher, pages + file + '?v=' + result.build)));
    if (!files.every((file, i) => digest(live[i]) === expected[file])) {
      return {...result, status: 'pending', reason: 'GitHub Pages has not published both files from this main revision.'};
    }
    if (previous && same(oldHashes, expected)) return {...result, status: 'unchanged'};
    const target = join(releaseRoot, commit);
    let targetExists = false;
    try { await hashes(target); targetExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (targetExists) {
      if (!same(await hashes(target), expected)) throw Error('Existing release directory differs from the published revision.');
    } else {
      await rename(stage, target);
      stage = null;
    }
    const current = await readPointer(pointerFile);
    if ((current?.raw.toString() ?? null) !== (previous?.raw.toString() ?? null)) throw Error('The current release changed during synchronization.');
    await writeAtomic(pointerFile, JSON.stringify({commit, build: result.build, hashes: expected}));
    switched = true;
    await restart();
    await verify(expected, fetcher);
    return {...result, status: 'updated'};
  } catch (error) {
    if (switched) {
      try {
        if (previous) await writeAtomic(pointerFile, previous.raw);
        else await rm(pointerFile);
        await restart();
        await verify(oldHashes, fetcher);
      } catch { throw Error('Release activation failed and rollback could not be verified.'); }
      throw Error('Release activation failed; the previous release was restored.');
    }
    throw error;
  } finally {
    if (stage && dirname(stage) === releaseRoot && basename(stage).startsWith('.stage-')) await rm(stage, {recursive: true, force: true});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = process.env.WB_WORKBENCH_RUNTIME;
  try {
    const result = await syncHost(runtime);
    await writeAtomic(join(resolve(runtime), 'protected', 'sync-status.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } catch (error) {
    if (runtime) {
      try { await writeAtomic(join(resolve(runtime), 'protected', 'sync-status.json'), JSON.stringify({status: 'failed', checkedAt: new Date().toISOString(), reason: error.message}, null, 2)); } catch {}
    }
    console.error('Workbench sync failed; check the private sync-status.json metadata.');
    process.exitCode = 1;
  }
}
