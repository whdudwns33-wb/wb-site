const assert = require('node:assert/strict');
const test = require('node:test');
const core = require('./acaflow-import-core.js');

test('아카플로우 SpreadsheetML에서 학생번호·이름·학년·보호자 연락처를 읽는다', () => {
  const xml = `<?xml version="1.0"?><Workbook><Worksheet><Table>
    <Row><Cell><Data>학생번호</Data></Cell><Cell><Data>성명</Data></Cell><Cell><Data>학교</Data></Cell><Cell><Data>학년</Data></Cell><Cell><Data>학부모 연락처</Data></Cell></Row>
    <Row><Cell><Data>A-1</Data></Cell><Cell><Data>테스트학생</Data></Cell><Cell><Data>테스트중</Data></Cell><Cell><Data>2</Data></Cell><Cell><Data>010-1234-5678</Data></Cell></Row>
  </Table></Worksheet></Workbook>`;
  const result = core.parseSpreadsheetText(xml, '전체 수강생 목록.xls');
  assert.deepEqual(result.rows, [{
    sourceRow: 2, externalStudentNo: 'A-1', name: '테스트학생', grade: '2',
    school: '테스트중', phone: '01012345678'
  }]);
});

test('CSV의 따옴표와 쉼표를 안전하게 읽는다', () => {
  const result = core.parseSpreadsheetText('성명,학년,보호자 휴대폰\n"김,학생",중1,01011112222\n', 'students.csv');
  assert.equal(result.rows[0].name, '김,학생');
  assert.equal(result.rows[0].phone, '01011112222');
});

test('Chrome에서 복사한 탭 구분 명부도 같은 규칙으로 읽는다', () => {
  const result = core.parseSpreadsheetText(
    '학생번호\t성명\t학년\t학부모 휴대폰\nA-1\t가학생\t중1\t010-1234-5678',
    'Chrome 클립보드'
  );
  assert.deepEqual(result.rows, [{
    sourceRow: 2, externalStudentNo: 'A-1', name: '가학생', grade: '중1', school: '', phone: '01012345678'
  }]);
});

test('현재 WB stable studentId에 연결해 신규·변경·동일·오류를 구분한다', () => {
  const roster = [
    { id: 's1', name: '가학생', grade: '중2' },
    { id: 's2', name: '나학생', grade: '중1' },
    { id: 's3', name: '동명', grade: '초2' },
    { id: 's4', name: '동명', grade: '초2' }
  ];
  const contacts = new Map([
    ['s1', { phone: '01011112222' }], ['s2', { phone: '01033334444' }]
  ]);
  const rows = [
    { sourceRow: 2, name: '가학생', grade: '2', school: '예시중', phone: '01011112222' },
    { sourceRow: 3, name: '나학생', grade: '중1', school: '', phone: '01099998888' },
    { sourceRow: 4, name: '없는학생', grade: '중1', school: '', phone: '01022223333' },
    { sourceRow: 5, name: '동명', grade: '초2', school: '', phone: '01044445555' },
    { sourceRow: 6, name: '가학생', grade: '중2', school: '', phone: '123' },
    { sourceRow: 7, name: '가학생', grade: '중2', school: '', phone: '01077778888' }
  ];
  const preview = core.buildPreview(rows, roster, contacts);
  assert.deepEqual(preview.entries.map(row => row.status), [
    'unchanged', 'changed', 'unmatched', 'ambiguous', 'invalid_phone', 'duplicate'
  ]);
  assert.equal(preview.entries[1].studentId, 's2');
  assert.equal(preview.entries[1].maskedPhone, '010-****-8888');
});

test('아카플로우 학생번호 연결은 이름·학년·5계정 담당자보다 우선한다', () => {
  const preview = core.buildPreview(
    [{ sourceRow: 2, externalStudentNo: 'A-1', name: '변경된표기', grade: '고3', school: '', phone: '01012345678' }],
    [{ id: 's1', name: '현재WB표기', grade: '중1', teacherIds: ['actual-teacher'] }],
    new Map(), new Map([['A-1', 's1']])
  );
  assert.equal(preview.entries[0].studentId, 's1');
  assert.equal(preview.entries[0].status, 'new');
  assert.equal(preview.entries[0].linkedByStudentNo, true);
  assert.equal(preview.entries[0].rosterNameDiffers, true);
});

test('기존 번호가 같아도 미연결 학생번호는 연결 대상으로 분리하고 동의를 보존한다', () => {
  const preview = core.buildPreview(
    [{ sourceRow: 2, externalStudentNo: 'A-1', name: '가학생', grade: '중1', school: '', phone: '01012345678' }],
    [{ id: 's1', name: '가학생', grade: '중1' }],
    new Map([['s1', { phone: '01012345678', consent: true }]]), new Map()
  );
  assert.equal(preview.entries[0].status, 'link_needed');
  assert.equal(preview.entries[0].currentConsent, true);
});

test('학생번호가 삭제된 WB 학생을 가리키면 이름으로 재추정하지 않는다', () => {
  const preview = core.buildPreview(
    [{ sourceRow: 2, externalStudentNo: 'A-1', name: '가학생', grade: '중1', school: '', phone: '01012345678' }],
    [{ id: 'other', name: '가학생', grade: '중1' }], new Map(), new Map([['A-1', 'missing']])
  );
  assert.equal(preview.entries[0].status, 'link_orphan');
  assert.equal(preview.entries[0].studentId, '');
});

test('원문 전화번호가 마스킹 결과에 노출되지 않는다', () => {
  const masked = core.maskPhone('01012345678');
  assert.equal(masked, '010-****-5678');
  assert.equal(masked.includes('1234'), false);
});

test('필수 열이 없거나 500명을 넘으면 중단한다', () => {
  assert.throws(() => core.parseSpreadsheetText('이름,학년\n학생,2', 'bad.csv'), /연락처 열/);
  const many = ['성명,학부모 연락처'];
  for (let i = 0; i < 501; i += 1) many.push('학생' + i + ',01012345678');
  assert.throws(() => core.parseSpreadsheetText(many.join('\n'), 'many.csv'), /500명/);
});
