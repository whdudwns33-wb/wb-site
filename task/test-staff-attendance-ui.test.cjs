const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('테스트쌤 수업은 보강 생성 없이 다음날 자동 출석 정책을 안내한다', () => {
  assert.match(html, /function isTestTeacherTask\(task\)/);
  assert.match(html, /테스트쌤 수업은 보강을 생성하지 않습니다/);
  assert.match(html, /다음날 출석으로 자동 처리됩니다/);
  assert.match(html, /result\.skipped && result\.code === 'TEST_STAFF_MAKEUP_DISABLED'/);
  const attendance = html.slice(html.indexOf("case 'latt':"), html.indexOf("case 'fbtext':"));
  assert.match(attendance, /next === 'A' && isTestTeacherTask\(t\)/);
});
