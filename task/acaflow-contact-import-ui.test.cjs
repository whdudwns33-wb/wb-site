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
  assert.match(html, /아카플로우 입력용 수업 기록을 복사했습니다/);
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
