const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function functionSource(name) {
  const markers = ['async function ' + name + '(', 'function ' + name + '('];
  let start = -1;
  for (const marker of markers) {
    start = html.indexOf(marker);
    if (start >= 0) break;
  }
  assert.notEqual(start, -1, name + ' function must exist');
  const open = html.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = open; i < html.length; i++) {
    const char = html[i];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  assert.fail(name + ' function is incomplete');
}

function eventCase(name) {
  const marker = "case '" + name + "':";
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, name + ' action must exist');
  const tail = html.slice(start + marker.length);
  const next = tail.match(/\n\s*case '[^']+':/);
  return html.slice(start, next ? start + marker.length + next.index : html.length);
}

function guardianBlock() {
  const start = html.indexOf('/* ── 보호자 읽기 전용 공유 ── */');
  const end = html.indexOf('/* ── 학생 관리 ── */', start);
  assert.ok(start >= 0 && end > start, 'guardian share source block must exist');
  return html.slice(start, end);
}

test('guardian sharing stays inside consult and only appears for real student accounts in director staff management', () => {
  assert.match(html, /const LS_KEY = 'wb_consult_v1'/);
  assert.match(html, /const SYNC_APP = 'consult'/);
  const view = functionSource('viewStaffAdmin');
  assert.match(view, /if \(!session\.isAdmin \|\| session\.isStaffLink\) return ''/);
  assert.match(view, /!s\.owner && !s\.manager[\s\S]*data-act="guardianopen"/);
  assert.match(view, />보호자 공유</);
  assert.doesNotMatch(functionSource('renderTabs'), /guardian|보호자/);
  assert.match(functionSource('guardianOpen'), /staff\.owner \|\| staff\.manager/);
});

test('director requests use consult auth in JSON bodies and never put credentials in a URL', () => {
  const post = functionSource('guardianPost');
  assert.match(post, /!session\.isAdmin \|\| session\.isStaffLink/);
  assert.match(post, /const auth = sync\.auth\(\)/);
  assert.match(post, /sync\.post\('\/consult-guardian'/);
  assert.match(post, /app: SYNC_APP, auth: auth, action: action/);
  assert.doesNotMatch(post, /URLSearchParams|searchParams|\?(?:auth|token|staffId)=/);

  assert.match(functionSource('guardianOpen'), /guardianPost\('access_list'\)/);
  assert.match(functionSource('guardianOpen'), /guardianPost\('preview', \{ staffId: staffId \}\)/);
  assert.match(functionSource('guardianSetAccess'), /guardianPost\('access_set'/);
  assert.match(functionSource('guardianCreateInvite'), /guardianPost\('invite'/);
  assert.match(functionSource('guardianRefreshPreview'), /guardianPost\('preview'/);
});

test('enabling requires confirmed consent and uses optimistic access revision while disabling revokes sessions', () => {
  const modal = functionSource('guardianShareModal');
  const setAccess = functionSource('guardianSetAccess');
  assert.match(modal, /id="guardianConsent"/);
  assert.match(modal, /동의 확인 후 공유 켜기/);
  assert.match(setAccess, /!consent \|\| !consent\.checked/);
  assert.match(setAccess, /consentConfirmed: enabled === true/);
  assert.match(setAccess, /expectedUpdatedAt: Number\(current\.updatedAt\) \|\| 0/);
  assert.match(setAccess, /연결된 보호자 기기도 바로 로그아웃/);
  assert.match(modal, /공유를 끄면 기존 보호자 접속도 즉시 종료/);
});

test('one-time invite prefers a safe server link and otherwise uses the worker guardian hash route', () => {
  const source = functionSource('guardianInviteLink');
  const build = Function('safeHttpsUrl', 'sync', source + '; return guardianInviteLink;')(
    value => /^https:\/\//.test(String(value || '')) ? String(value) : '',
    { url: () => 'https://sync.example/' }
  );
  assert.equal(build({ link: 'https://guardian.example/invite' }), 'https://guardian.example/invite');
  assert.equal(build({ code: 'a b' }), 'https://sync.example/consult-guardian/#code=a%20b');
  assert.match(source, /sync\.url\(\)/);
  assert.match(source, /\/consult-guardian\/#code=/);
  assert.doesNotMatch(source, /location\.(?:search|hash)|history/);
});

test('invite and guardian sessions remain volatile and are cleared when the modal closes', () => {
  const block = guardianBlock();
  assert.match(block, /const guardianShareUi = \{/);
  assert.doesNotMatch(block, /localStorage|sessionStorage|state\.settings/);
  assert.doesNotMatch(block, /guardianShareUi\.(?:code|session|token)/);
  assert.match(functionSource('clearGuardianShareUi'), /invite: null/);
  assert.match(functionSource('closeModal'), /clearGuardianShareUi\(\)/);
  assert.match(functionSource('guardianCreateInvite'), /guardianShareUi\.invite = \{ link: link, expiresAt:/);
});

test('modal exposes loading, failure retry, access, acknowledgement, preview, and offline guidance', () => {
  const source = functionSource('guardianShareModal');
  for (const text of [
    '불러오는 중', '불러오지 못했습니다', '다시 시도', '공유 상태', '연결된 기기',
    '최근 보호자 확인', '일회용 초대 링크', '보호자 화면 미리보기', '미동기화 상태'
  ]) assert.match(source, new RegExp(text));
  assert.match(source, /guardianShareUi\.error/);
  assert.match(source, /reports\.map\(guardianReportCard\)/);
  const report = functionSource('guardianReportCard');
  assert.match(report, /snapshot\.summary/);
  assert.match(report, /fmtDur\(Number\(summary\.studySecs\)/);
});

test('admin preview renders the same nested report DTO used by the guardian portal', () => {
  const render = Function('esc', 'fmtDur', 'guardianDateTime',
    functionSource('guardianReportCard') + '; return guardianReportCard;')(
    value => String(value == null ? '' : value),
    seconds => (Number(seconds) / 3600) + '시간',
    value => '시각 ' + value
  );
  const output = render({
    reportType: 'week', periodStart: '2026-08-17', periodEnd: '2026-08-23',
    publishedAt: 123, acknowledgedAt: 456,
    snapshot: { summary: { pct: 75, studySecs: 3600 } }
  });
  assert.match(output, /주간 리포트/);
  assert.match(output, /2026-08-17 ~ 2026-08-23/);
  assert.match(output, /완료율 <b>75%/);
  assert.match(output, /공부 1시간/);
  assert.match(output, /확인함/);
});

test('every guardian action fails closed outside the director session', () => {
  const actions = [
    'guardianopen', 'guardianretry', 'guardianenable', 'guardiandisable',
    'guardianinvite', 'guardianpreview', 'guardiancopy'
  ];
  for (const action of actions) {
    const source = eventCase(action);
    assert.match(source, /if \(!session\.isAdmin \|\| session\.isStaffLink\) break/,
      action + ' must reject student and manager personal links');
  }
  for (const name of ['guardianOpen', 'guardianSetAccess', 'guardianCreateInvite', 'guardianRefreshPreview']) {
    assert.match(functionSource(name), /!session\.isAdmin \|\| session\.isStaffLink/,
      name + ' must also guard direct calls');
  }
});
