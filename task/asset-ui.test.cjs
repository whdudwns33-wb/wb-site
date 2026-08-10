const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const core = require('./asset-core.js');

test('asset core module is loaded by the app', () => {
  assert.ok(/<script src="\.\/asset-core\.js\?v=/.test(html), 'script tag with cache-busting version');
});

test('devices tab is wired for the director and routed to a view', () => {
  assert.ok(html.includes("['devices', '기기', deviceAlertCount()]"), 'tab entry exists');
  assert.ok(/devices:\s*viewDevices/.test(html), 'route map entry exists');
  assert.ok(html.includes('function viewDevices('), 'view is defined');
});

/* 서버는 개인 링크의 '__프리픽스__<값>' 쓰기를 값 === 본인 staffId 일 때만 허용한다.
   기기 번호는 staffId가 아니므로 대장이 직원 탭에 열리면 저장이 조용히 실패한다. */
test('devices tab is not offered on the staff personal link', () => {
  const staffTabs = html.split('\n').filter(l => l.includes("['today', '오늘 할 일']"));
  assert.equal(staffTabs.length, 1, 'staff tab list found exactly once');
  assert.ok(!staffTabs[0].includes("'devices'"), 'staff link must not expose the ledger');
});

test('staff route allowlist excludes devices', () => {
  const allow = html.match(/const allowed = \[([^\]]*)\]/);
  assert.ok(allow, 'allowlist found');
  assert.ok(!allow[1].includes('devices'));
});

test('asset rows are excluded from per-person check ownership', () => {
  const fn = html.match(/function ownerOfCheck\(key\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'ownerOfCheck found');
  assert.ok(fn[0].includes('isAssetKey'), 'asset keys must not claim a staff id as owner');
  assert.ok(fn[0].indexOf('isAssetKey') < fn[0].indexOf('__[a-zA-Z]+__'),
    'the asset check must run before the generic prefix match');
});

test('every device action in the markup has a handler case', () => {
  const acts = [...html.matchAll(/data-act="(asset[a-z]+)"/g)].map(m => m[1]);
  assert.ok(acts.length >= 6, 'device actions are present');
  [...new Set(acts)].forEach(a => {
    assert.ok(html.includes("case '" + a + "':"), 'missing handler for ' + a);
  });
});

test('every field the save handler reads is rendered by the form', () => {
  const save = html.match(/case 'assetsave': \{[\s\S]*?\n    \}/);
  assert.ok(save, 'assetsave handler found');
  const names = [...new Set([...save[0].matchAll(/assetField\(cur, '([a-z]+)'\)/g)].map(m => m[1]))];
  assert.ok(names.length >= 12, 'handler reads the full form, got ' + names.length);
  names.forEach(n => {
    assert.ok(html.includes('id="as-' + n + '"'), 'form is missing input as-' + n);
  });
});

/* 자세히 칸을 접으면 그 입력들이 DOM에 없다. 직접 읽으면 저장할 때 터진다. */
test('the save handler survives the collapsed detail panel', () => {
  const save = html.match(/case 'assetsave': \{[\s\S]*?\n    \}/)[0];
  assert.ok(!/\$\('#as-[a-z]+'\)\.(value|checked)/.test(save),
    'reading an input directly breaks when the panel is collapsed — go through assetField');
  const helper = html.match(/function assetField\(cur, name\) \{[\s\S]*?\n\}/);
  assert.ok(helper, 'assetField helper found');
  assert.ok(helper[0].includes('if (!el) return cur[name]'), 'falls back to the stored value');
  assert.ok(helper[0].includes("type === 'checkbox'"), 'checkboxes read .checked, not .value');
});

test('one tap marks a device normal straight from the list', () => {
  assert.ok(/data-act="assetquick"/.test(html), 'quick buttons are rendered on the row');
  const row = html.match(/const quick = core\.CONDITIONS\.map[\s\S]*?\.join\(''\);/);
  assert.ok(row, 'quick buttons are built from the shared condition list');
  assert.ok(row[0].includes('data-cond="'), 'each button carries its condition');

  const handler = html.match(/case 'assetquick': \{[\s\S]*?\n    \}/);
  assert.ok(handler, 'assetquick handler found');
  assert.ok(handler[0].includes('checkedAt: now()'), 'a quick tap completes the audit');
});

test('a fault tap asks what is wrong instead of guessing', () => {
  const handler = html.match(/case 'assetquick': \{[\s\S]*?\n    \}/)[0];
  assert.ok(handler.includes('if (!sets)'), 'handles the no-preset case');
  assert.ok(handler.includes('deviceDetail = true'), 'opens the detail panel for the answer');
  assert.equal(core.quickSet('dead'), null, 'core refuses to guess the fault');
});

test('detail panel starts collapsed and has a toggle', () => {
  assert.ok(/let deviceDetail = false/.test(html), 'collapsed by default');
  assert.ok(html.includes("case 'assetdetail':"), 'toggle handler exists');
});

/* 티어 문자와 배치 이름을 함께 띄우면 같은 것을 두 이름으로 부르게 된다. */
test('the row shows placement names, not tier letters', () => {
  const row = html.match(/function deviceRow\(a\) \{[\s\S]*?\n\}\n/);
  assert.ok(row, 'deviceRow found');
  assert.ok(row[0].includes('core.placeLabel('), 'placement is shown by name');
  assert.ok(!/rec\.tier/.test(row[0]), 'tier letters stay out of the operating screen');
});

test('placement and tier are saved together so they cannot drift apart', () => {
  const save = html.match(/case 'assetsave': \{[\s\S]*?\n    \}/)[0];
  assert.ok(save.includes('tier: AC().tierOfPlace(place)'), 'tier is derived from placement');
});

test('deleting a device tombstones the row instead of dropping the key', () => {
  const del = html.match(/case 'assetdel': \{[\s\S]*?\n    \}/);
  assert.ok(del, 'assetdel handler found');
  assert.ok(del[0].includes('deleted: true'),
    'a removed key would be resurrected by the next delta sync');
  assert.ok(/allAssets\(\)[\s\S]{0,240}!a\.deleted/.test(html), 'the list filters tombstones');
});

test('published assignments go through the same path as pasted JSON', () => {
  ['assetaudit', 'assetrepair', 'assetpii'].forEach(a => {
    const block = html.match(new RegExp("case '" + a + "': \\{[\\s\\S]*?\\n    \\}"));
    assert.ok(block, a + ' handler found');
    assert.ok(block[0].includes('applyAssignments('), a + ' must reuse applyAssignments');
  });
});

test('the generated assignment shape matches what applyAssignments consumes', () => {
  const pending = [core.normalizeAsset({ id: 'A001', model: 'SM-T583' })];
  const out = core.buildAuditAssignments(pending, { staff: '김혜지' });
  const a = out[0];
  ['staff', 'title', 'detail', 'guide', 'steps', 'target', 'unit', 'priority', 'repeat'].forEach(k => {
    assert.ok(Object.prototype.hasOwnProperty.call(a, k), 'missing ' + k);
  });
  assert.ok(Array.isArray(a.steps) && a.steps.every(s => typeof s === 'string'),
    'applyAssignments maps steps as strings or {label}');
});
