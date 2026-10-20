import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, basename, resolve} from 'node:path';
import {request} from 'node:http';
import {createWorkbenchServer, parsePort} from './serve.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'wb-serve-test-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('wb-serve-test-'));
    rmSync(directory, {recursive: true});
  });
  const base64 = length => Buffer.alloc(length, 1).toString('base64');
  const index = Buffer.from('<!doctype html><script>const P=' + JSON.stringify({s: base64(16), i: base64(12), c: base64(32), it: 310000}) + ';</script>');
  const bulk = Buffer.from(JSON.stringify({v: 1, inner: 'gzip(bulk-data.json)', t: '0123abcd', i: base64(12), c: base64(32)}));
  writeFileSync(join(directory, 'index.html'), index);
  writeFileSync(join(directory, 'bulk.enc.json'), bulk);
  return {directory, index, bulk};
}

async function serve(t, directory) {
  const server = createWorkbenchServer(directory);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal(server.address().address, '127.0.0.1');
  return (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({hostname: '127.0.0.1', port: server.address().port, path, method}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves only the encrypted pair, supports HEAD/query and retains the startup snapshot', async t => {
  const f = fixture(t), get = await serve(t, f.directory);
  writeFileSync(join(f.directory, 'index.html'), 'changed after startup');
  writeFileSync(join(f.directory, 'bulk.enc.json'), 'changed after startup');
  for (const [path, expected, type] of [
    ['/workbench/', f.index, 'text/html'],
    ['/workbench/index.html?cache=off', f.index, 'text/html'],
    ['/workbench/bulk.enc.json?v=0123abcd', f.bulk, 'application/json'],
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const res = await get(path, method);
      assert.equal(res.status, 200);
      assert.equal(res.headers['cache-control'], 'no-store, no-transform');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.ok(res.headers['content-type'].startsWith(type));
      assert.equal(Number(res.headers['content-length']), expected.length);
      assert.deepEqual(res.body, method === 'HEAD' ? Buffer.alloc(0) : expected);
    }
  }
  const health = await get('/healthz');
  assert.deepEqual(JSON.parse(health.body), {ok: true, build: '0123abcd'});
  assert.equal((await get('/healthz', 'HEAD')).body.length, 0);
});

test('redirects to a trailing slash and rejects source paths, traversal and writes', async t => {
  const f = fixture(t), get = await serve(t, f.directory);
  for (const path of ['/', '/?v=1', '/workbench', '/workbench?v=1']) {
    const res = await get(path);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/workbench/');
  }
  for (const path of ['/workbench/src/app.html', '/workbench/src/private-seed.json', '/workbench/backup/',
    '/.git/config', '/workbench/../index.html', '/workbench/../workbench/index.html',
    '/workbench/%2e%2e/index.html', '/workbench%2findex.html', '//workbench/', '/index.html', '/bulk.enc.json']) {
    assert.equal((await get(path)).status, 404, path);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const res = await get('/workbench/index.html', method);
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET, HEAD');
  }
  assert.deepEqual(readFileSync(join(f.directory, 'index.html')), f.index);
  assert.deepEqual(readFileSync(join(f.directory, 'bulk.enc.json')), f.bulk);
});

test('validates the port and rejects missing, plaintext or malformed deployment files', t => {
  assert.equal(parsePort(), 18960);
  assert.equal(parsePort('65535'), 65535);
  for (const value of ['', '0', '-1', '65536', '123abc', '1e3', ' 18960 ', '0x1234']) assert.throws(() => parsePort(value));
  for (const directory of [undefined, '', '   ']) assert.throws(() => createWorkbenchServer(directory));
  const f = fixture(t);
  for (const index of ['<!doctype html>plaintext app', 'const P={bad};', 'const P={"s":"bad"};']) {
    writeFileSync(join(f.directory, 'index.html'), index);
    assert.throws(() => createWorkbenchServer(f.directory), /missing or invalid/);
  }
  writeFileSync(join(f.directory, 'index.html'), f.index);
  const bulk = JSON.parse(f.bulk);
  for (const invalid of ['not JSON', '{}', JSON.stringify({...bulk, t: '../src'}), JSON.stringify({...bulk, t: 12345678}), JSON.stringify({...bulk, i: 'bad'}),
    JSON.stringify({...bulk, c: ''}), JSON.stringify({...bulk, v: 2})]) {
    writeFileSync(join(f.directory, 'bulk.enc.json'), invalid);
    assert.throws(() => createWorkbenchServer(f.directory), /missing or invalid/);
  }
  rmSync(join(f.directory, 'bulk.enc.json'));
  assert.throws(() => createWorkbenchServer(f.directory), /missing or invalid/);
});
