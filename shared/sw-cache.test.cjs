'use strict';
/* 같은 주소의 앱들은 CacheStorage를 공유한다 — 새 앱이 다른 앱의 셸·가족 링크를 지우면 안 된다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const apps = { reading: 'wbr', vocab: 'wbv', naesin: 'wbn', 'naesin-ko': 'wbk', haru: 'wbh', hanja: 'wbhj', letter: 'wbl', chunk: 'wbc' };

(async () => {
  for (const [app, prefix] of Object.entries(apps)) {
    const src = fs.readFileSync(path.join(__dirname, '..', app, 'sw.js'), 'utf8');
    const current = src.match(/const VERSION = '([^']+)'/)[1];
    const old = prefix + '-shell-old';
    const keep = [current, ...Object.values(apps).filter(p => p !== prefix).map(p => p + '-shell-other'),
      'wbl-meta', 'wbl-fonts', 'wbc-meta', 'unrelated-cache'];
    const hooks = {}, deleted = [];
    let claimed = false, done;
    vm.runInNewContext(src, {
      self: { addEventListener: (name, fn) => { hooks[name] = fn; }, clients: { claim: () => { claimed = true; } } },
      caches: { keys: async () => [old, ...keep], delete: async (key) => { deleted.push(key); return true; } }
    });
    hooks.activate({ waitUntil: (p) => { done = p; } });
    await done;
    assert.deepStrictEqual(deleted, [old], app + '가 타 앱 캐시·가족 링크·글꼴을 지우거나 옛 셸을 남겼다');
    assert.ok(claimed, app + '가 활성화 뒤 열린 화면을 맡지 않았다');
    console.log('  ✓ ' + app + ' — 자기 옛 셸만 삭제, 타 앱·가족 링크·글꼴 보존');
  }
  console.log('OK — ' + Object.keys(apps).length + '개 앱 통과');
})().catch((e) => { console.error(e); process.exitCode = 1; });
