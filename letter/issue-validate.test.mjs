'use strict';
/* node letter/issue-validate.test.mjs — 저장소에 든 호가 실제로 열리는가.
   파일럿(issue-pilot.json)은 main 에 합치는 순간 가정이 여는 호라, 여기서 막지 못하면 배포가 곧 사고다. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { validateFile } from './issue-validate.mjs';

const require = createRequire(import.meta.url);
const L = require('./letter.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

console.log('issue-validate — 저장소의 브레인레터 호');

t('파일럿·샘플 호는 검증기 오류 0 (경고는 허용)', () => {
  for (const f of ['issue-pilot.json', 'issue-sample.json']) {
    const p = path.join(HERE, f);
    if (f === 'issue-pilot.json' && !fs.existsSync(p)) { console.log('    (파일럿 없음 — 건너뜀)'); continue; }
    const r = validateFile(p);
    assert.deepEqual(r.errors, [], f + ' 오류: ' + JSON.stringify(r.errors));
    assert.ok(r.issue.sections.length >= 5, f + ' 섹션이 너무 적다');
    assert.match(r.issue.source, /자체 창작/, f + ' 는 자체 창작 표시가 있어야 한다');
    assert.match(r.issue.id, /^\d{4}-W\d{2}(-[a-z0-9]{1,12})?$/, f + ' id 형식');
  }
});

t('파일럿은 다섯 학년대를 모두 덮는다 — 한 학년대라도 비면 그 가정은 빈 화면을 본다', () => {
  const p = path.join(HERE, 'issue-pilot.json');
  if (!fs.existsSync(p)) return;
  const issue = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const tier of L.TIER_IDS) {
    const forTier = L.forTier(issue, tier);
    assert.ok(forTier.sections.length >= 3, tier + ' 학년대 섹션이 ' + forTier.sections.length + '개뿐');
  }
});

t('망가진 호는 오류로 잡는다 — 검증기가 통과시키면 이 테스트가 무의미하다', () => {
  const tmp = path.join(HERE, '.issue-validate-tmp.json');
  const broken = { id: 'nope', week: '2026-W40', publishAt: 'x', status: 'published', title: '', sections: [] };
  fs.writeFileSync(tmp, JSON.stringify(broken));
  try {
    const r = validateFile(tmp);
    assert.ok(r.errors.length >= 2, '망가진 호인데 오류가 ' + r.errors.length + '개');
    fs.writeFileSync(tmp, '{ not json');
    assert.match(validateFile(tmp).errors[0].msg, /JSON/);
  } finally { fs.unlinkSync(tmp); }
});

t('CLI — 인자 없이 부르면 저장소 호를 모두 보고 0 으로 끝난다', () => {
  const out = execFileSync(process.execPath, [path.join(HERE, 'issue-validate.mjs')], { encoding: 'utf8' });
  assert.match(out, /issue-sample\.json/);
  assert.match(out, /모두 통과/);
});

console.log(`issue-validate: ${passed} passed`);
