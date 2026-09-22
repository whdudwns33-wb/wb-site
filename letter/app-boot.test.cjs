'use strict';
/* 학생·가족 앱이 호를 어디서 여는가 (node letter/app-boot.test.cjs)

   파일럿 기간에는 호가 서버(KV)가 아니라 배포본에 있다. 그래서 가족 링크(?t=)로 들어오면 서버는
   멀쩡한 링크에도 "호 없음" 이라고 답한다 — 그 자리에서 빈 화면을 보여 주면 가족은 링크가 고장 난 줄 안다.
   이 검사는 그 배선이 조용히 빠지는 것을 막는다: 호를 여는 곳은 한 군데(loadPilot)여야 하고,
   가족 모드는 "서버에 호 없음" 과 "링크 유효하지 않음" 두 경우 모두 그리로 넘어와야 한다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const script = HTML.slice(HTML.lastIndexOf('<script>') + '<script>'.length, HTML.lastIndexOf('</script>'));

/* 호를 여는 분기만 잘라 본다 — 'MODE === family' 는 기록 저장·알림 쪽에도 나와서 첫 번째를 집으면 엉뚱한 자리다 */
function famBranch() {
  const from = script.indexOf("if (MODE === 'family') return fetchJson('/api/letter/parent?t=");
  const to = script.indexOf("if (MODE === 'admin') return fetchJson(");
  assert.ok(from > 0 && to > from, '가족 모드 분기를 찾지 못했다 — 화면 구조가 바뀌었나');
  return script.slice(from, to);
}

console.log('app-boot — 호를 여는 자리');

t('인라인 스크립트가 문법적으로 성립한다 — 한 줄이 길어 주석 하나로 뒤가 통째로 죽는 일이 있었다', () => {
  assert.doesNotThrow(() => new Function(script));
});

t('호를 여는 곳은 loadPilot 하나 — 목록(issues.json)을 두 군데서 따로 열지 않는다', () => {
  assert.ok(/function loadPilot\(done, fail\)/.test(script), 'loadPilot 함수가 없다');
  const opens = script.match(/fetchJson\('\.\/issues\.json'/g) || [];
  assert.equal(opens.length, 1, `issues.json 을 여는 곳이 ${opens.length} 군데 — 하나여야 한다`);
});

t('가족 링크: 서버가 호를 안 주면 배포본 호로 넘어간다 (빈 화면 금지)', () => {
  const fam = famBranch();
  assert.ok(/!j\.issue/.test(fam) && /return loadPilot\(done, fail\)/.test(fam), '서버에 호가 없을 때 파일럿으로 넘어가지 않는다');
});

t('가족 링크: 유효하지 않은 링크(404)도 이번 주 호를 보여 주되 기록은 그 기기에만', () => {
  const fam = famBranch();
  assert.ok(/e\.status === 404/.test(fam), '404 를 따로 다루지 않는다');
  assert.ok(/MODE = 'demo'/.test(fam) && /FAM_T = ''/.test(fam), '404 일 때 기록이 서버로 나가지 않게 체험 모드로 내려야 한다');
  assert.ok(/return fail\(e\)/.test(fam), '404 가 아닌 오류(서버 장애 등)는 그대로 알려야 한다');
});

t('가족 링크: 응답 모양이 예상과 달라도 터지지 않는다 — 중간 프록시가 엉뚱한 200 을 줄 수 있다', () => {
  const fam = famBranch();
  assert.ok(!/j\.parent\.[a-z]/.test(fam), 'j.parent 를 확인 없이 파고든다 — 가족이 자바스크립트 오류 문구를 보게 된다');
  assert.ok(/j && j\.parent \? j\.parent : null/.test(fam), '응답에 parent 가 없을 때를 다루지 않는다');
});

t('한 번 파일럿으로 넘어오면 지난 호·다른 날짜도 같은 자리에서 연다', () => {
  assert.ok(/if \(PILOT\) return loadPilot\(done, fail\);/.test(script), 'PILOT 일 때 파일럿 경로로 가지 않는다 — 지난 호를 누르면 서버를 다시 부른다');
});

t('체험 호(issue-sample.json)는 "이번 주 호" 라고 말하지 않는다', () => {
  const tail = script.slice(script.indexOf("issue-sample.json"));
  const line = tail.slice(0, tail.indexOf('\n'));
  assert.ok(!/PILOT = true/.test(line), '샘플까지 파일럿으로 표시하면 체험 화면이 이번 주 호인 척한다');
});

console.log(`app-boot: ${passed} passed`);
