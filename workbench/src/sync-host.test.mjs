import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync} from 'node:fs';
import {join, dirname, basename, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {syncHost} from './sync-host.mjs';

const oldCommit = 'a'.repeat(40), newCommit = 'b'.repeat(40);
function pair(marker = 1) {
  const b64 = length => Buffer.alloc(length, marker).toString('base64');
  return {
    'index.html': Buffer.from('<script>const P=' + JSON.stringify({s: b64(16), i: b64(12), c: b64(32), it: 310000}) + ';</script>'),
    'bulk.enc.json': Buffer.from(JSON.stringify({v: 1, inner: 'gzip(bulk-data.json)', t: '0123abcd', i: b64(12), c: b64(32)})),
  };
}
function fixture(t, previous = false) {
  const root = mkdtempSync(join(tmpdir(), 'wb-sync-test-')), original = pair();
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('wb-sync-test-'));
    rmSync(root, {recursive: true});
  });
  mkdirSync(join(root, 'protected'));
  mkdirSync(join(root, 'public'));
  for (const [file, bytes] of Object.entries(original)) writeFileSync(join(root, 'public', file), bytes);
  const pointer = join(root, 'protected', 'current-release.json');
  if (previous) {
    const release = join(root, 'releases', oldCommit);
    mkdirSync(release, {recursive: true});
    for (const [file, bytes] of Object.entries(original)) writeFileSync(join(release, file), bytes);
    writeFileSync(pointer, JSON.stringify({commit: oldCommit, build: '0123abcd'}));
  }
  return {root, original, pointer};
}
function network(candidate, {commit = newCommit, published = candidate, failFile} = {}) {
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    if (url.includes('api.github.com')) return new Response(JSON.stringify({object: {sha: commit}}));
    const file = new URL(url).pathname.split('/').at(-1);
    if (file === failFile) return new Response('unavailable', {status: 503});
    const bytes = url.includes('raw.githubusercontent.com') ? candidate[file] : published[file];
    assert.ok(bytes, 'Unexpected network path');
    return new Response(bytes);
  };
  return {fetcher, calls};
}

test('pins both files to one main commit, preserves the original pair and activates an immutable release', async t => {
  const f = fixture(t), candidate = pair(2), net = network(candidate);
  let restarts = 0, verified = 0;
  const result = await syncHost(f.root, {...net, restart: async () => {
    restarts++;
    assert.equal(JSON.parse(readFileSync(f.pointer)).commit, newCommit);
    for (const [file, bytes] of Object.entries(candidate)) assert.deepEqual(readFileSync(join(f.root, 'releases', newCommit, file)), bytes);
  }, verify: async () => { verified++; }});
  assert.equal(result.status, 'updated');
  assert.equal(restarts, 1); assert.equal(verified, 1);
  assert.equal(net.calls.filter(url => url.includes('/' + newCommit + '/workbench/')).length, 2);
  for (const [file, bytes] of Object.entries(f.original)) assert.deepEqual(readFileSync(join(f.root, 'public', file)), bytes);
  assert.deepEqual(readdirSync(join(f.root, 'releases')), [newCommit]);
});

test('does not restart for unchanged bytes even when unrelated main commits change', async t => {
  const f = fixture(t, true), before = readFileSync(f.pointer), net = network(f.original);
  const result = await syncHost(f.root, {...net, restart: async () => assert.fail('Unexpected restart')});
  assert.equal(result.status, 'unchanged');
  assert.deepEqual(readFileSync(f.pointer), before);
});

test('waits until GitHub Pages publishes the complete pair and keeps the previous release', async t => {
  const f = fixture(t, true), before = readFileSync(f.pointer), net = network(pair(2), {published: f.original});
  const result = await syncHost(f.root, {...net, restart: async () => assert.fail('Unexpected restart')});
  assert.equal(result.status, 'pending');
  assert.deepEqual(readFileSync(f.pointer), before);
  assert.deepEqual(readdirSync(join(f.root, 'releases')), [oldCommit]);
});

for (const previous of [false, true]) test('restores the complete previous release after activation failure (pointer=' + previous + ')', async t => {
  const f = fixture(t, previous), before = previous ? readFileSync(f.pointer) : null, net = network(pair(2));
  const transitions = []; let checks = 0;
  await assert.rejects(syncHost(f.root, {...net, restart: async () => {
    transitions.push(existsSync(f.pointer) ? JSON.parse(readFileSync(f.pointer)).commit : null);
  }, verify: async () => { if (++checks === 1) throw Error('Synthetic server startup failure'); }}), /previous release was restored/);
  assert.deepEqual(transitions, [newCommit, previous ? oldCommit : null]);
  assert.equal(checks, 2);
  if (previous) assert.deepEqual(readFileSync(f.pointer), before);
  else assert.equal(existsSync(f.pointer), false);
  for (const [file, bytes] of Object.entries(f.original)) assert.deepEqual(readFileSync(join(f.root, 'public', file)), bytes);
});

test('rejects invalid revisions, missing downloads and plaintext without replacing saved files', async t => {
  const cases = [
    network(pair(2), {commit: '../private'}),
    network(pair(2), {failFile: 'bulk.enc.json'}),
    network({...pair(2), 'index.html': Buffer.from('plaintext is not a deployable app')}),
  ];
  for (const net of cases) {
    const f = fixture(t, true), before = readFileSync(f.pointer);
    await assert.rejects(syncHost(f.root, {...net, restart: async () => assert.fail('Unexpected restart')}));
    assert.deepEqual(readFileSync(f.pointer), before);
    assert.deepEqual(readdirSync(join(f.root, 'releases')), [oldCommit]);
  }
});

test('reports an unsuccessful rollback without claiming successful recovery', async t => {
  const f = fixture(t, true), net = network(pair(2));
  await assert.rejects(syncHost(f.root, {...net, restart: async () => { throw Error('Task failed'); }}), /rollback could not be verified/);
  assert.equal(JSON.parse(readFileSync(f.pointer)).commit, oldCommit);
});
