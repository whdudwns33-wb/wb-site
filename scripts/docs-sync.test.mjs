'use strict';
/* node scripts/docs-sync.test.mjs — 에이전트 안내 문서가 갈라지지 않았는가.
   Codex 는 AGENTS.md 를, Claude Code 는 CLAUDE.md 를 읽는다. 둘이 달라지면 에이전트마다 다른 규칙으로
   같은 저장소를 고치게 되고, 그 차이는 아무도 안 본 채 몇 주를 간다 — 그래서 파일이 같아야 한다. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

console.log('docs-sync — 에이전트 안내 문서');

t('CLAUDE.md 와 AGENTS.md 는 한 글자도 다르지 않다 (다르면: cp CLAUDE.md AGENTS.md)', () => {
  assert.equal(read('AGENTS.md'), read('CLAUDE.md'));
});

t('문서가 가리키는 명령·파일이 실제로 있다 — 죽은 안내는 없는 것만 못하다', () => {
  const doc = read('CLAUDE.md');
  for (const f of ['scripts/check.mjs', 'letter/issue-validate.mjs', '.github/workflows/checks.yml',
                   '.github/workflows/deploy-reading.yml', '.github/workflows/admin-secrets.yml', 'reading-server/admin-auth.mjs']) {
    assert.ok(doc.includes(path.basename(f)) || doc.includes(f), '문서에 ' + f + ' 안내가 없다');
    assert.ok(fs.existsSync(path.join(ROOT, f)), f + ' 가 없는데 문서가 가리킨다');
  }
});

t('앱 지도의 경로가 전부 존재한다', () => {
  const doc = read('CLAUDE.md');
  const rows = doc.split('\n').filter((l) => /^\| `[a-z-]+\/` \|/.test(l));
  assert.ok(rows.length >= 10, '지도 행이 ' + rows.length + '개뿐 — 표 형식이 바뀌었나');
  for (const r of rows) {
    const dir = r.match(/^\| `([a-z-]+)\/` \|/)[1];
    assert.ok(fs.existsSync(path.join(ROOT, dir)), '지도에 있는 ' + dir + '/ 가 저장소에 없다');
  }
});

console.log(`docs-sync: ${passed} passed`);
