const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('차량·시설 담당 역할은 별도 두 탭만 제공한다', () => {
  assert.match(html, /staff\.workRole \|\| ''\) === 'driver_facility'/);
  assert.match(html, /\['driver_transport', '오늘 운행'\]/);
  assert.match(html, /\['facility', '청소시설업무'\]/);
  assert.match(html, /driver_transport: viewDriverTransport/);
  assert.match(html, /facility: viewFacility/);
  assert.match(html, /const allowed = \['driver_transport', 'facility'\]/);
});

test('오늘 운행은 개인 노선만 보여주고 날짜 변경 대신 오늘을 고정한다', () => {
  const view = html.match(/function viewTransport\(\) \{[\s\S]*?\n\}/);
  assert.ok(view, 'transport view found');
  assert.match(view[0], /driverMode = isDriverFacilityStaff/);
  assert.match(view[0], /routeRow\.driverId/);
  assert.match(view[0], /driverMode\s*\n\s*\? '<strong>'/);
  assert.match(html, /function viewDriverTransport\(\) \{\s*return viewTransport\(\);/);
});

test('청소시설업무는 기본 항목만 접기 영역으로 시작한다', () => {
  const view = html.match(/function viewFacility\(\) \{[\s\S]*?\n\}/);
  assert.ok(view, 'facility view found');
  ['청소 구역', '청소 완료', '시설 이상 신고', '관리자 요청사항'].forEach(label => assert.match(view[0], new RegExp(label)));
  assert.match(view[0], /data-persist-key="driver-facility-/);
  assert.match(view[0], /세부 항목을 준비 중입니다/);
});

test('관리자는 직원별 차량·시설 담당 역할을 지정할 수 있다', () => {
  assert.match(html, /data-act="toggleworkrole"/);
  assert.match(html, /case 'toggleworkrole':/);
  assert.match(html, /s\.workRole = nextRole/);
});
