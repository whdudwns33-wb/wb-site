const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('MetaMath uses fixed official links without storing credentials', () => {
  assert.match(html, /const METAMATH_CENTER_URL = 'https:\/\/www\.mmatht\.co\.kr\/Pages\/home2\/login\.cshtml\?kind=center'/);
  assert.match(html, /const METAMATH_STUDENT_URL = 'https:\/\/www\.mmatht\.co\.kr\/Pages\/home2\/login\.cshtml\?kind=student'/);

  const card = html.match(/function metaMathCard\(me, editable\) \{[\s\S]*?\n}/)?.[0] || '';
  assert.match(card, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(card, /iframe|fetch\(|password/i);
});

test('MetaMath card shows only the selected student tasks and reuses completion checks', () => {
  const list = html.match(/function metaMathTasksFor\(staffId\) \{[\s\S]*?\n}/)?.[0] || '';
  const card = html.match(/function metaMathCard\(me, editable\) \{[\s\S]*?\n}/)?.[0] || '';
  assert.match(list, /t\.staffId === staffId && t\.source === 'metamath'/);
  assert.match(card, /metaMathTasksFor\(me\.id\)/);
  assert.match(card, /taskRow\(t, t\.start, editable, false\)/);
  assert.match(html, /data-act="toggle" data-id=/);
  assert.match(html, /점수·오답 수 메모/);
});

test('only the director can register a MetaMath reminder in existing task sync', () => {
  const card = html.match(/function metaMathCard\(me, editable\) \{[\s\S]*?\n}/)?.[0] || '';
  const save = html.match(/case 'metasave':[\s\S]*?\n\s*break;/)?.[0] || '';
  assert.match(card, /const director = session\.isAdmin/);
  assert.match(card, /director \? '<button[^']*data-act="metaadd"/);
  assert.match(card, /과제 알림 등록은 원장 화면에서/);
  assert.match(save, /if \(!session\.isAdmin\) break/);
  assert.match(save, /state\.tasks\.push\(/);
  assert.match(save, /staffId: me\.id/);
  assert.match(save, /source: 'metamath'/);
  assert.match(save, /repeat: 'once'/);
  assert.match(save, /start: due/);
  assert.match(save, /save\(\); queueSync\(\)/);
});
