'use strict';
/* 자체 임시 파일로만 검사하며 앱 원본·운영 DB는 변경하지 않는다. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stampServiceWorker } from './sw-version.mjs';

const tempRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(tempRoot, 'wb-sw-version-'));
const resolved = fs.realpathSync(directory);
assert.equal(path.dirname(resolved), tempRoot);
const sw = path.join(resolved, 'sw.js'), a = path.join(resolved, 'index.html'), b = path.join(resolved, 'voice.js');
const original = "const VERSION = 'own-shell-dev';\nconst SHELL = ['./index.html', './voice.js'];\n";
fs.writeFileSync(sw, original); fs.writeFileSync(a, '<p>Own sample</p>'); fs.writeFileSync(b, '/* Own voice fixture */');
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };
try {
  const first = stampServiceWorker(sw, [a, b], 'own-shell');
  t('같은 내용·다른 입력 순서는 같은 캐시 이름과 응답을 만든다', () => {
    assert.match(first.tag, /^own-shell-[a-f0-9]{10}$/);
    assert.deepEqual(stampServiceWorker(sw, [b, a], 'own-shell'), first);
    assert.match(first.source, new RegExp("const VERSION = '" + first.tag + "';"));
  });
  t('셸 파일이 바뀌면 캐시 이름이 바뀌고 되돌리면 같은 이름으로 돌아온다', () => {
    const before = fs.readFileSync(a);
    fs.writeFileSync(a, '<p>Own updated sample</p>');
    assert.notEqual(stampServiceWorker(sw, [a, b], 'own-shell').tag, first.tag);
    fs.writeFileSync(a, before);
    assert.deepEqual(stampServiceWorker(sw, [a, b], 'own-shell'), first);
  });
  t('서비스 워커 자신이 바뀌어도 해시가 바뀌며 스탬프는 원본 파일에 쓰지 않는다', () => {
    assert.equal(fs.readFileSync(sw, 'utf8'), original);
    const changed = original + '/* Own changed worker */\n'; fs.writeFileSync(sw, changed);
    assert.notEqual(stampServiceWorker(sw, [a, b], 'own-shell').tag, first.tag);
    assert.equal(fs.readFileSync(sw, 'utf8'), changed);
    assert.equal(fs.readFileSync(a, 'utf8'), '<p>Own sample</p>');
    assert.equal(fs.readFileSync(b, 'utf8'), '/* Own voice fixture */');
  });
  t('VERSION 선언이나 셸 파일이 없으면 쓰기 없이 실패한다', () => {
    const invalid = '/* Own worker without declaration */'; fs.writeFileSync(sw, invalid);
    assert.throws(() => stampServiceWorker(sw, [a, b], 'own-shell'), /VERSION/);
    assert.equal(fs.readFileSync(sw, 'utf8'), invalid);
    fs.writeFileSync(sw, original);
    assert.throws(() => stampServiceWorker(sw, [path.join(resolved, 'missing.js')], 'own-shell'), /ENOENT/);
    assert.equal(fs.readFileSync(sw, 'utf8'), original);
  });
} finally {
  assert.equal(fs.realpathSync(directory), resolved);
  assert.equal(path.dirname(resolved), tempRoot);
  fs.rmSync(resolved, { recursive: true, force: true });
}
console.log('\n통과 ' + passed + '개 — 서비스 워커 내용 버전 검증');
