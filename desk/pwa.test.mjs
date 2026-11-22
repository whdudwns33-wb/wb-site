import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const asset = name => readFileSync(new URL('./app/' + name, import.meta.url));

test('설치 manifest, 아이콘과 두 화면의 head가 표준에 맞는다', () => {
  const manifest = JSON.parse(asset('manifest.webmanifest'));
  assert.deepEqual([manifest.id, manifest.scope, manifest.start_url, manifest.display,
    manifest.short_name, manifest.theme_color], ['/', '/', '/', 'standalone', '프로그램', '#1e3a3f']);
  assert.deepEqual(manifest.icons.map(icon => icon.purpose), ['any', 'any', 'maskable']);
  for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192],
    ['icon-512.png', 512], ['icon-maskable-512.png', 512]]) {
    const png = asset(name);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20), png[25]], [size, size, 2]);
  }
  for (const page of ['index.html', 'ext.html']) {
    const head = asset(page).toString().split('</head>')[0];
    assert.match(head, /href="\/manifest\.webmanifest" crossorigin="use-credentials"/);
    assert.match(head, /href="\/apple-touch-icon\.png"/);
    assert.match(head, /register\('\/sw\.js'\)/);
    assert.equal((head.match(/name="theme-color"/g) || []).length, 1);
  }
});

test('서비스 워커는 설치 자산만 저장하고 API와 MCP를 그대로 보낸다', async () => {
  const events = {};
  const deleted = [];
  let precached;
  let online = true;
  vm.runInNewContext(asset('sw.js').toString(), {
    URL,
    self: { addEventListener: (type, handler) => { events[type] = handler; },
      skipWaiting() {}, clients: { claim() {} } },
    caches: {
      async open() { return { addAll: paths => { precached = [...paths]; } }; },
      async keys() { return ['wb-pwa-20261121', 'wb-pwa-20261202', 'other-app']; },
      async delete(key) { deleted.push(key); },
      async match(path) { return path; }
    },
    async fetch() { if (online) return 'network'; throw new Error('offline'); }
  });
  await new Promise(resolve => events.install({ waitUntil: resolve }));
  await new Promise(resolve => events.activate({ waitUntil: resolve }));
  assert.deepEqual(precached, ['/offline.html', '/icon-192.png']);
  assert.deepEqual(deleted, ['wb-pwa-20261121']);
  function navigate(path, mode = 'navigate') {
    let result;
    events.fetch({ request: { url: 'https://desk.test' + path, mode },
      respondWith: response => { result = response; } });
    return result;
  }
  for (const path of ['/api', '/api/docs', '/mcp', '/mcp/']) assert.equal(navigate(path), undefined);
  assert.equal(navigate('/app.js', 'cors'), undefined);
  assert.equal(await navigate('/'), 'network');
  online = false;
  assert.equal(await navigate('/ext'), '/offline.html');
  online = true;
  assert.equal(await navigate('/'), 'network');
});
