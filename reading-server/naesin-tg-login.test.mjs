import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import worker from './worker.mjs';

test('탐구브레인 학생 연동에만 탐구브레인 설치 정보를 응답한다', async () => {
  const origin = 'https://student.invalid';
  const html = readFileSync(new URL('../reading/index.html', import.meta.url), 'utf8');
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(html)),
    'ETag': '"reading-root"',
    'X-Robots-Tag': 'noindex',
  };
  const requestedAssets = [];
  const env = { ASSETS: { fetch: async request => {
    requestedAssets.push(request.url);
    return new Response(html, { headers });
  } } };
  const get = path => worker.fetch(new Request(origin + path), env, {});

  const login = await get('/?app=naesin-tg&c=synthetic');
  assert.equal(login.status, 200);
  const source = await login.text();
  assert.match(source, /<title>WB 탐구브레인 · 학생 연동<\/title>/);
  assert.match(source, /rel="manifest" href="\/naesin-tg\/manifest.webmanifest" crossorigin="use-credentials"/);
  assert.match(source, /rel="apple-touch-icon" href="\/naesin-tg\/apple-touch-icon.png"/);
  assert.match(source, /name="theme-color" content="#2a3b2e"/);
  assert.match(source, /name="apple-mobile-web-app-title" content="탐구브레인"/);
  assert.equal(login.headers.get('cache-control'), 'no-store');
  assert.equal(login.headers.get('etag'), null);
  assert.equal(login.headers.get('content-length'), null);
  assert.equal(login.headers.get('x-robots-tag'), 'noindex');

  for (const path of ['/', '/?app=naesin']) {
    const reading = await get(path);
    assert.equal(await reading.text(), html);
    assert.equal(reading.headers.get('etag'), '"reading-root"');
  }
  assert.deepEqual(requestedAssets, [origin + '/', origin + '/', origin + '/?app=naesin']);
});
