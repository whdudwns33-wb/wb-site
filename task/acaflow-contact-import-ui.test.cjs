const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const html = fs.readFileSync(new URL('./index.html', `file://${__filename}`), 'utf8');

test('아카플로우 공식 xls/CSV를 앱 메모리에서 읽어 미리보기한다', () => {
  assert.match(html, /acaflow-import-core\.js/);
  assert.match(html, /accept="\.xls,\.csv/);
  assert.match(html, /WB_AcaFlowImport\.parseSpreadsheetText/);
  assert.match(html, /WB_AcaFlowImport\.buildPreview/);
  assert.match(html, /파일은 이 화면의 메모리에서만 읽고 업로드·기기 저장하지 않으며/);
  assert.doesNotMatch(html, /localStorage\.setItem\([^\n]*acaflow/i);
});

test('Chrome 복사·붙여넣기는 확장 프로그램 없이 같은 미리보기를 재사용한다', () => {
  assert.match(html, /Chrome에서 복사한 명부 붙여넣기/);
  assert.match(html, /navigator\.clipboard\.readText\(\)/);
  assert.match(html, /parseSpreadsheetText\(source, 'Chrome 클립보드'\)/);
  assert.match(html, /case 'acaflowpaste': prepareAcaflowClipboard\(\)/);
  assert.doesNotMatch(html, /localStorage\.setItem\([^\n]*acaflow/i);
});

test('새 번호와 안전한 학생번호 연결만 기본 선택하고 번호 변경은 직접 선택하게 한다', () => {
  assert.match(html, /\['new', 'link_needed'\]\.includes\(row\.status\)/);
  assert.match(html, /changed: \['번호 변경 · 선택 필요'/);
  assert.match(html, /번호 변경 항목은 기본 선택하지 않습니다/);
});

test('저장은 기존 stable-ID 보호자 endpoint를 재사용하고 동의를 끈다', () => {
  assert.match(html, /sync\.post\('\/guardian-contact'/);
  assert.match(html, /studentId: row\.studentId/);
  assert.match(html, /consent: row\.status === 'link_needed' \? row\.currentConsent : false/);
  assert.match(html, /externalStudentNo: row\.externalStudentNo \|\| undefined/);
  assert.match(html, /acaflowStudentLinks\.set\(result\.acaflowLink\.externalStudentNo/);
  assert.match(html, /알림톡 동의는 자동으로 켜지지 않습니다/);
});

test('학생번호 링크를 우선 사용하고 원문 번호 자체는 화면에 표시하지 않는다', () => {
  assert.match(html, /result\.acaflowLinks \|\| \[\]/);
  assert.match(html, /학생번호 연결/);
  assert.match(html, /WB 이름 확인/);
  const view = html.slice(html.indexOf('function viewAcaflowImport'), html.indexOf('function viewRoster'));
  assert.doesNotMatch(view, /externalStudentNo/);
});

test('이름·학년 자동연결과 동명이인 수동 확인 정책을 미리보기에 표시한다', () => {
  assert.match(html, /row\.matchedByNameGrade \? ' <span class="tag ok">이름·학년 자동연결/);
  assert.match(html, /row\.manualNameReview \? ' <span class="tag risk">동명이인 직접 확인/);
  assert.match(html, /명부에 같은 이름이 하나뿐이고 이름·학년이 일치하는 학생만 자동 연결 후보/);
  assert.match(html, /명부에 같은 이름이 둘 이상인 학생은 항상 직접 확인 대상으로 남깁니다/);
});

/* 공개 저장소다(절대 규칙 1). 한때 동명이인 판정이 **코드에 박힌 학생 실명 하나**였고,
   화면 문구에도 그 이름이 그대로 나갔다. 판정을 명부에서 유도하도록 바꿨으니, 그 자리에
   이름이 다시 박히는 것을 막는다 — 특정 이름을 적어 두면 그 이름만 막혀서(그리고 그 이름이
   저장소에 남아서) 관문이 못 된다. 그래서 '한글 이름 목록을 코드에 박는 모양'을 막는다. */
test('동명이인 판정에 사람 이름을 코드·화면에 박지 않는다', () => {
  const core = fs.readFileSync(new URL('./acaflow-import-core.js', `file://${__filename}`), 'utf8');
  assert.match(core, /byName\.get\(key\)/, '판정이 명부에서 유도되지 않는다');
  assert.match(core, /sameName\.length > 1/, '명부 중복 수로 판정하지 않는다');
  /* 한글 이름을 담은 Set·배열 리터럴 — 예전 MANUAL_NAME_REVIEW 모양 */
  assert.doesNotMatch(core, /new Set\(\s*\[\s*'[가-힣]{2,4}'/, '한글 이름 목록이 코드에 박혔다');
  assert.doesNotMatch(core, /NAME_REVIEW\s*=/, '이름 목록 상수가 되살아났다');
  /* 화면 문구의 한글 이름 — '…을 제외하고' 처럼 특정 학생을 지목하는 꼴 */
  assert.doesNotMatch(html, /[가-힣]{3}(?:을|은) (?:제외하고|항상 직접 확인)/, '화면 문구가 특정 학생을 지목한다');
});

test('원문 번호는 미리보기 DOM에 넣지 않고 마스킹 번호만 표시한다', () => {
  const view = html.slice(html.indexOf('function viewAcaflowImport'), html.indexOf('function viewRoster'));
  assert.match(view, /row\.maskedPhone/);
  assert.doesNotMatch(view, /esc\(row\.phone/);
});

test('아카플로우 5개 처리 계정은 실제 WB 담당자를 덮어쓰지 않는다', () => {
  assert.match(html, /담당자 자동 변경 없음/);
  assert.match(html, /5개 처리 계정과 실제 WB 수업 담당자는 별개/);
  const start = html.indexOf('async function importAcaflowContacts(button)');
  const end = html.indexOf('\nfunction viewAcaflowImport()', start);
  const importer = html.slice(start, end);
  assert.doesNotMatch(importer, /teacherIds|담당강사|teacherId\s*:/);
});

test('WB 수업 기록을 실제 담당자 이름과 함께 아카플로우 입력용으로 복사한다', () => {
  assert.match(html, /function acaflowLessonSummary\(t, date\)/);
  assert.match(html, /'실제 담당: ' \+ \(\(staff && staff\.name\)/);
  assert.match(html, /data-act="acaflowlessoncopy"/);
  assert.match(html, /아카플로우 코멘트용 복사/);
  assert.match(html, /학생별 레포트의 코멘트·출결메모 칸에 붙여넣으세요\. 출결은 별도로 선택합니다/);
  const start = html.indexOf('function acaflowLessonSummary(t, date)');
  const end = html.indexOf('\nfunction taskPanel(', start);
  const source = html.slice(start, end);
  assert.doesNotMatch(source, /phone|guardian|localStorage|sessionStorage|console\./i);
  const summary = new Function('getCheck', 'staffById', 'taskSteps', 'studentOf', 'ATT_LABEL',
    source + '; return acaflowLessonSummary;')(
    () => ({ att: 'P', steps: { read: true }, note: '핵심 문장을 확인함' }),
    () => ({ name: '실제담당' }),
    () => [{ id: 'read', label: '본문 읽기' }, { id: 'write', label: '문장 쓰기' }],
    () => '가학생',
    { P: ['출석', 'ok'] }
  )({ id: 'lesson-a', staffId: 'teacher-a', studentName: '가학생', subject: '영어', className: '독해' }, '2026-08-15');
  assert.match(summary, /실제 담당: 실제담당/);
  assert.match(summary, /출결: 출석/);
  assert.match(summary, /진행: 본문 읽기/);
  assert.match(summary, /수업 메모: 핵심 문장을 확인함/);
});
