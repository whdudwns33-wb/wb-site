'use strict';
/* 관리 화면 원본을 실행한다 — 복사한 렌더러를 검사하면 화면 배선이 끊겨도 통과한다. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const READY = require('./readiness.js');
const COV = require('./coverage.js');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const admin = read('reading-server/public/naesin-admin.html');
const inline = admin.split('<script>')[1].split('</script>')[0];
const stop = inline.indexOf("$('#btnRefresh').onclick=refresh;");
assert.ok(stop > 1000, '관리 화면 초기화 경계를 찾지 못했다');
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

function screen(students = [], exams = null, ready = READY) {
  const area = { innerHTML: '' };
  const chips = ['전체', 'A', 'B'].map(cls => ({ dataset: { cls } }));
  const ctx = vm.createContext({
    localStorage: { getItem: () => null },
    document: { querySelector: () => area, querySelectorAll: () => chips },
    WBNAESINREADY: ready, WBNaesinCoverage: COV,
  });
  vm.runInContext(inline.slice(0, stop) + `
    this.ui={readinessRow,readinessCell,readinessStats,studentRow,renderOverview,loadExams,
      set:(students,exams,filter='전체')=>{OV={students};EXAMS=exams;FILTER=filter;}};`, ctx);
  ctx.ui.set(students, exams);
  return { ...ctx.ui, area, chips, setFetch: fn => { ctx.fetch = fn; } };
}

/* 자체 창작 요약 — 단어만 있는 팩은 남은 축으로 정규화되어 점수와 비율이 같다. */
const words = score => ({ packId: 'sample-L1', word: { total: 100, reached: score, stable: score } });
const student = (code, cls, score) => ({ code, name: code + '학생', cls, summary: words(score) });
const exams = date => Object.assign([{ scope: 'default', examDate: date, packIds: ['sample-L1'] }], { today: '2026-10-12' });

t('관리 모듈이 로컬·배포 양쪽에 연결된다', () => {
  assert.match(admin, /<script src="\/admin\/readiness\.js"><\/script>/);
  assert.match(read('reading-server/build-dist.mjs'), /'naesin', 'readiness\.js'\), path\.join\(DIST, 'admin', 'readiness\.js'\)/);
  assert.match(read('reading-server/server.mjs'), /'\/admin\/readiness\.js'\).*NAESIN_DIR, 'readiness\.js'/);
});

t('머리 숫자는 평균이 아니라 70% 이상 학생 비율이다', () => {
  const ui = screen([student('S1', 'A', 100), student('S2', 'A', 60)]);
  ui.renderOverview();
  const stats = ui.area.innerHTML.split('<h3>시험 준비도')[1];
  assert.match(stats, /<b>50%<\/b>.*?<span>준비도 70% 이상 · 1\/2명<\/span>/s);
  assert.match(stats, /<b>80%<\/b><span>평균 준비도<\/span>/);
  assert.equal(stats.match(/<b>(.*?)<\/b>/)[1], '50%');
});

t('반 칩을 누르면 학생 표와 준비도 집계가 함께 바뀐다', () => {
  const ui = screen([student('S1', 'A', 100), student('S2', 'A', 60), student('S3', 'B', 100)]);
  ui.renderOverview();
  ui.chips.find(b => b.dataset.cls === 'A').onclick();
  assert.match(ui.area.innerHTML, /시험 준비도 · A/);
  assert.match(ui.area.innerHTML, /<b>50%<\/b>/);
  assert.ok(!ui.area.innerHTML.includes('S3학생'));
  ui.chips.find(b => b.dataset.cls === 'B').onclick();
  assert.match(ui.area.innerHTML, /준비도 70% 이상 · 1\/1명/);
  assert.ok(!ui.area.innerHTML.includes('S1학생'));
});

t('범위 전체 요약을 우선하고, 옛 팩 하나 요약도 읽는다', () => {
  const ui = screen();
  const s = student('S1', 'A', 100);
  s.summary.range = { packIds: ['sample-L1', 'sample-L2'], ...words(60) };
  assert.equal(ui.readinessRow(s).summary.word.stable, 60);
  assert.match(ui.readinessCell(s), /<b>60%<\/b>/);
  delete s.summary.range;
  assert.match(ui.readinessCell(s), /<b>100%<\/b>/);
});

t('없는 축은 집계 제외로 표시하고, 실제 미시작 축만 0%로 표시한다', () => {
  const ui = screen();
  const html = ui.readinessCell(student('S1', 'A', 0));
  assert.match(html, /단어 게이트 · 0%/);
  assert.match(html, /내용정리 점검 · 자료·기록 없음 \(집계 제외\)/);
  assert.ok(!html.includes('내용정리 점검 · 0%'));
  assert.ok(!html.includes('문장 해석 · 0%'));
});

t('자료·기록 없는 학생은 0점 대신 미집계이며 반 비율에서 제외된다', () => {
  const students = [student('S1', 'A', 100), { code: 'S2', cls: 'A', summary: null }];
  const ui = screen(students);
  assert.match(ui.readinessCell(students[1]), /미집계/);
  const html = ui.readinessStats(students);
  assert.match(html, /준비도 70% 이상 · 1\/1명/);
  assert.match(html, /준비도 집계 1\/2명 · 미집계 1명/);
  assert.match(ui.readinessStats([]), /<b>—<\/b><span>평균 준비도/);
  assert.ok(!ui.readinessStats([]).includes('<b>0%</b>'));
});

t('확정 미달은 붉게 표시하며 학생과 반 집계의 D-day가 같다', () => {
  const s = student('S1', 'A', 60), ui = screen([s], exams('2026-10-14'));
  assert.equal(ui.readinessRow(s).dday, 2);
  assert.match(ui.readinessCell(s), /class="err">확정 미달<br>미착수 단어 40개/);
  assert.match(ui.readinessCell(s), /안정화 최소 3일 \/ 남은 2일/);
  assert.match(ui.readinessStats([s]), /class="stat warn"><b>1명<\/b>/);
  ui.set([s], exams('2026-10-12'));
  assert.equal(ui.readinessRow(s).dday, 0);
  assert.match(ui.readinessCell(s), /확정 미달/);
});

t('시험일 미확인·종료에는 미달을 단정하지 않고 개별 배정 만료는 공통으로 폴백한다', () => {
  const s = student('S1', 'A', 60), ui = screen([s]);
  for (const ex of [null, exams('2026-10-11'), exams('미정')]) {
    ui.set([s], ex);
    assert.equal(ui.readinessRow(s).dday, null);
    assert.ok(!ui.readinessCell(s).includes('확정 미달'));
  }
  const ex = exams('2026-10-22');
  ex.push({ scope: 'S1', expired: true, examDate: '2026-10-11' });
  ui.set([s], ex);
  assert.equal(ui.readinessRow(s).dday, 10);
  ex[1] = { scope: 'S1', expired: false, examDate: '2026-10-14' };
  assert.equal(ui.readinessRow(s).dday, 2);
});

t('학생의 반 시험일과 범위로 준비도를 계산하고 만료·개별 우선순위도 따른다', () => {
  const s = student('ST1', 'A', 60), ex = exams('2026-10-22');
  ex.push({ scope: 'cls:A', expired: false, examDate: '2026-10-14', packIds: ['sample-L1'] });
  const ui = screen([s], ex);
  assert.equal(ui.readinessRow(s).dday, 2);
  assert.match(ui.readinessCell(s), /확정 미달/);
  ex.push({ scope: 'ST1', expired: false, examDate: '2026-10-17', packIds: ['sample-L1'] });
  assert.equal(ui.readinessRow(s).dday, 5);
  ex[2].expired = true;
  ex[1].packIds = ['sample-L2'];
  assert.equal(ui.readinessRow(s).dday, null);
  assert.match(ui.readinessCell(s), /시험 범위 불일치/);
  ex[1].expired = true;
  assert.equal(ui.readinessRow(s).dday, 10);
  ex[1].expired = false;
  s.cls = 'B';
  assert.equal(ui.readinessRow(s).dday, 10, '다른 반 시험일은 적용하지 않는다');
});

t('학생 문자열을 이스케이프하고 망가진 수치를 HTML에 넣지 않는다', () => {
  const ui = screen(), s = student('S1', '<img src=x onerror=alert(1)>', 100);
  s.name = '<script>alert(1)</script>';
  s.summary.word.stable = '"><img src=x onerror=alert(1)>';
  const html = ui.studentRow(s) + ui.readinessStats([s]);
  assert.ok(!/<script>|<img|NaN|Infinity/.test(html));
  assert.ok(html.includes('&lt;script&gt;') && html.includes('&lt;img'));
});

t('새 시험 범위와 다른 기록에 점수·확정 미달을 붙이지 않는다', () => {
  const s = student('S1', 'A', 60), ex = exams('2026-10-14'), ui = screen([s], ex);
  s.summary.range = { packIds: ['sample-L1', 'sample-L2'], ...words(60) };
  assert.equal(ui.readinessRow(s).dday, null);
  assert.match(ui.readinessCell(s), /시험 범위 불일치/);
  assert.ok(!ui.readinessCell(s).includes('확정 미달'));
  assert.match(ui.readinessStats([s]), /준비도 집계 0\/1명 · 미집계 1명/);
  ex[0].packIds = ['sample-L2', 'sample-L1'];
  assert.equal(ui.readinessRow(s).dday, 2, '같은 범위의 순서만 바뀌면 기록은 유효하다');
  assert.match(ui.readinessCell(s), /확정 미달/);
});

t('모듈을 못 받으면 기존 현황판은 남고 준비도 오류를 알린다', () => {
  const missing = screen([student('S1', 'A', 100)], null, null);
  missing.renderOverview();
  assert.match(missing.area.innerHTML, /준비도 모듈을 불러오지 못했어요/);
  assert.match(missing.area.innerHTML, /S1학생/);
});

(async () => {
  const s = student('S1', 'A', 60), ui = screen([s], exams('2026-10-22'));
  ui.renderOverview();
  assert.ok(!ui.area.innerHTML.includes('class="err">확정 미달'));
  ui.setFetch(async () => ({ status: 200, ok: true, json: async () => ({ exams: exams('2026-10-14'), today: '2026-10-12' }) }));
  await ui.loadExams();
  t('시험 배정 변경·해제 후 새 시험일로 현황판도 다시 그린다', () => {
    assert.match(ui.area.innerHTML, /class="err">확정 미달/);
    assert.match(ui.area.innerHTML, /남은 2일/);
  });
  ui.setFetch(async () => ({ status: 200, ok: true, json: async () => ({ exams: [], today: '2026-10-12' }) }));
  await ui.loadExams();
  assert.ok(!ui.area.innerHTML.includes('class="err">확정 미달'));
  console.log('통과 ' + passed);
})().catch(e => { console.error(e); process.exitCode = 1; });
