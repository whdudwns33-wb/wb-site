'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('미등원·등원·채팅만 표시하고 종료 버튼과 관리자 팝업을 제공한다', () => {
  assert.doesNotMatch(source, /id="centerChatPresenceStatus"|id="centerChatSummary"/);
  assert.match(functionBlock('saveCenterChatPresence'), /action: 'missing'/);
  assert.match(functionBlock('renderCenterMissing'), /!centerChat.canHandleMissing/);
  assert.doesNotMatch(functionBlock('renderCenterMissing'), /row.handlerName|확인 중/);
  assert.match(functionBlock('renderCenterMissing'), /등원 알림 보내기/);
  assert.match(functionBlock('renderCenterMissing'), /알림 종료/);
  assert.match(functionBlock('renderCenterMissing'), /row.state !== 'resolved'/);
  assert.match(functionBlock('handleCenterMissing'), /'missing_arrived' : 'missing_close'/);
  assert.match(functionBlock('handleCenterMissing'), /confirm\(/);
  assert.match(functionBlock('handleCenterMissing'), /epoch === centerChat.identityEpoch/);
  assert.match(functionBlock('resetCenterChatState'), /missingDismissed: new Set/);
  assert.match(functionBlock('resetCenterChatState'), /centerMissingPopup.*innerHTML = ''/);
});

function block(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0, `${from} 시작 지점이 있어야 한다`);
  assert.ok(end > start, `${to} 종료 지점이 있어야 한다`);
  return source.slice(start, end);
}

function functionBlock(name) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = pattern.exec(source);
  assert.ok(match, `${name} 함수가 있어야 한다`);
  const start = match.index;
  const tail = source.slice(start + match[0].length);
  const next = /\n(?:async\s+)?function\s+[A-Za-z0-9_$]+\s*\(/.exec(tail);
  return source.slice(start, next ? start + match[0].length + next.index : source.length);
}

test('모든 업무 화면의 58px 원형 버튼은 모바일 하단 시트와 PC 오른쪽 drawer를 연다', () => {
  assert.match(source, /id="centerChatLauncher"[\s\S]*data-act="centerchatopen"/);
  assert.match(source, /\.center-chat-launcher\s*\{[\s\S]*position:\s*fixed[\s\S]*width:\s*58px[\s\S]*height:\s*58px[\s\S]*border-radius:\s*50%/);
  assert.match(source, /\.center-chat-panel\s*\{[\s\S]*right:\s*0[\s\S]*bottom:\s*0/);
  assert.match(source, /@media\(max-width:700px\)[\s\S]*\.center-chat-panel\s*\{[\s\S]*top:\s*auto[\s\S]*left:\s*0[\s\S]*width:\s*100%/);
  assert.match(source, /id="centerChatBadge"[^>]*hidden/);
  assert.match(functionBlock('render'), /renderCenterChatChrome\(\)/);
});

test('버튼은 인증된 관리자·일반 직원·기사시설 화면에 공통이고 세 가지 gate에서는 숨는다', () => {
  const visibility = functionBlock('centerChatCanShow');
  assert.match(visibility, /shouldGateStaffWork\(\)/);
  assert.match(visibility, /shouldGatePersonAccess\(\)/);
  assert.match(visibility, /session\.isAdmin/);
  assert.match(visibility, /session\.isStaffLink/);
  assert.doesNotMatch(visibility, /route|isDriverFacilityStaff|accessRole/);
  assert.match(functionBlock('renderCenterChatChrome'), /launcher\.hidden\s*=\s*!show/);
});

test('이전 기록은 보존하되 등하원 인원 집계는 제거한다', () => {
  const apply = functionBlock('applyCenterChatResult');
  const render = functionBlock('renderCenterChatPanel');
  const item = functionBlock('centerChatItemHtml');
  assert.match(apply, /result\.items/);
  assert.match(apply, /row && row\.kind === 'presence' \? 'presence' : 'message'/);
  assert.match(render, /centerChat\.items\.slice\(\)\.sort/);
  assert.match(render, /centerChat\.students\.map\(student => \[student\.id, student\.name, student\.grade\]\)/);
  assert.doesNotMatch(render, /centerChat\.presence\.reduce/);
  assert.match(item, /item\.kind === 'presence'/);
  assert.match(item, /item\.body/);
  assert.match(functionBlock('centerChatCreatedAt'), /day === centerChat\.date \? '' : parts\.month \+ '\/' \+ parts\.day/);
  assert.match(source, /전화번호·검사 결과 등 민감정보는 적지 마세요/);
});

test('센터 소통 API 네 동작은 항상 task app과 현재 auth 및 stable ID 계약을 사용한다', () => {
  const list = functionBlock('loadCenterChat');
  const send = functionBlock('sendCenterChatMessage');
  const presence = functionBlock('saveCenterChatPresence');
  const read = functionBlock('markCenterChatRead');
  assert.match(list, /sync\.post\('\/center-chat', \{ app: SYNC_APP, auth, action: 'list' \}\)/);
  assert.match(source, /draftMessageId:\s*'ccm_' \+ uid\(\)/);
  assert.match(send, /sync\.post\('\/center-chat', \{ app: SYNC_APP, auth, action: 'send', messageId, body \}\)/);
  assert.match(presence, /eventId:\s*'ccm_' \+ uid\(\)/);
  assert.match(presence, /action: 'missing', requestId, studentId/);
  assert.doesNotMatch(presence, /action: 'presence'/);
  assert.match(read, /action: 'read', itemId/);
  assert.match(functionBlock('applyCenterChatResult'), /result && result\.lastItemId/);
});

test('visible 인증 상태에서 5초 폴링하고 복귀·전송·상태 저장 뒤 즉시 다시 조회한다', () => {
  assert.match(source, /setInterval\(\(\) => \{\s*if \(document\.visibilityState === 'visible' && centerChatCanRequest\(\)\) loadCenterChat\(false\);\s*\}, 5000\);/);
  const visibility = block("document.addEventListener('visibilitychange'", '/* ══');
  assert.match(visibility, /loadCenterChat\(true\)/);
  assert.match(functionBlock('startSyncSession'), /loadCenterChat\(true\)/);
  assert.match(functionBlock('sendCenterChatMessage'), /loadCenterChat\(true\)/);
  assert.match(functionBlock('saveCenterChatPresence'), /loadCenterChat\(true\)/);
  assert.match(functionBlock('loadCenterChat'), /if \(centerChat\.loading\) \{ if \(force\) centerChat\.reloadQueued = true/);
  assert.match(functionBlock('loadCenterChat'), /if \(centerChat\.reloadQueued\)[\s\S]*loadCenterChat\(false\)/);
});

test('목록 범위 밖 미확인과 위쪽 탐색 중 새 글은 자동으로 읽음 처리하지 않는다', () => {
  const apply = functionBlock('applyCenterChatResult');
  const maybeRead = functionBlock('maybeMarkCenterChatRead');
  const markRead = functionBlock('markCenterChatRead');
  assert.match(apply, /result && result\.hiddenUnreadCount/);
  assert.match(maybeRead, /centerChat\.hiddenUnreadCount/);
  assert.match(maybeRead, /centerChatTimelineAtBottom\(\)/);
  assert.match(markRead, /centerChat\.hiddenUnreadCount && !allowHidden/);
  assert.match(source, /data-act="centerchatreadall"/);
  assert.match(source, /id="centerChatItems"[\s\S]*addEventListener\('scroll'/);
  assert.doesNotMatch(functionBlock('loadCenterChat'), /markCenterChatRead\(centerChat\.lastItemId\)/);
});

test('작성 draft는 폴링 DOM 교체와 실패에서 보존되고 성공 응답 뒤에만 비운다', () => {
  const render = functionBlock('renderCenterChatPanel');
  const send = functionBlock('sendCenterChatMessage');
  const inputs = block("document.addEventListener('input'", "document.addEventListener('change'");
  assert.match(render, /if \(draft\.value !== centerChat\.draft\) draft\.value = centerChat\.draft/);
  assert.match(inputs, /centerChat\.draft\s*=\s*value/);
  assert.match(inputs, /centerChat\.draftMessageId\s*=\s*'ccm_' \+ uid\(\)/);
  assert.ok(send.indexOf("sync.post('/center-chat'") < send.indexOf("centerChat.draft = ''"),
    '서버 성공 뒤에만 draft를 비워야 한다');
  assert.match(send, /catch \(error\)[\s\S]*centerChat\.error/);
});

test('drawer는 overlay·닫기·ESC를 지원하고 focus를 가둔 뒤 원래 버튼으로 돌려보낸다', () => {
  assert.match(source, /id="centerChatPanel" role="dialog" aria-modal="true" aria-labelledby="centerChatTitle"/);
  assert.match(source, /class="center-chat-backdrop" data-act="centerchatclose"/);
  const keys = block("document.addEventListener('keydown'", '/* 복귀 시 최신화 */');
  assert.match(keys, /centerChat\.open && ev\.key === 'Tab'/);
  assert.match(keys, /ev\.key === 'Escape' && centerChat\.open/);
  assert.match(functionBlock('openCenterChat'), /centerChat\.returnFocus = document\.activeElement/);
  assert.match(functionBlock('closeCenterChat'), /target\.focus\(\)/);
});

test('개인 인증이나 관리자 점검 identity가 바뀌면 숨은 DOM과 진행 응답까지 완전히 폐기한다', () => {
  const reset = functionBlock('resetCenterChatState');
  assert.match(reset, /centerChat\.requestSequence \+= 1/);
  assert.match(reset, /centerChat\.identityEpoch \+= 1/);
  for (const field of ['students', 'presence', 'items']) {
    assert.match(reset, new RegExp(`${field}: \\[\\]`));
  }
  assert.match(reset, /draft: ''/);
  assert.match(reset, /studentId: ''/);
  assert.match(reset, /presenceAttempt: null/);
  assert.match(reset, /loaded: false/);
  assert.match(reset, /host\.hidden = true/);
  assert.match(reset, /items\.innerHTML = ''/);
  assert.match(functionBlock('resetPersonCache'), /resetCenterChatState\(\)/);
  assert.match(functionBlock('clearManagerInspection'), /resetCenterChatState\(\)/);
  assert.match(functionBlock('lockStaffWork'), /resetCenterChatState\(\)/);
  assert.match(functionBlock('logoutStaffWork'), /resetCenterChatState\(\)/);
  assert.match(functionBlock('sendCenterChatMessage'), /JSON\.stringify\(sync\.auth\(\)\) !== authKey/);
  assert.match(functionBlock('saveCenterChatPresence'), /JSON\.stringify\(sync\.auth\(\)\) !== authKey/);
  assert.match(functionBlock('sendCenterChatMessage'), /identityEpoch !== centerChat\.identityEpoch/);
  assert.match(functionBlock('saveCenterChatPresence'), /identityEpoch !== centerChat\.identityEpoch/);
  assert.doesNotMatch(functionBlock('sendCenterChatMessage'), /const requestSequence = centerChat\.requestSequence/);
  assert.doesNotMatch(functionBlock('saveCenterChatPresence'), /const requestSequence = centerChat\.requestSequence/);
});

// 실제 화면의 함수와 이스케이프를 실행해 문자열 검사만으로 놓칠 수 있는 삽입을 확인한다.
const chatRender = new Function('centerChat',
  functionBlock('esc') + functionBlock('centerChatStatusLabel') +
  functionBlock('centerChatBodyHtml') + functionBlock('centerChatItemHtml') +
  '\nfunction centerChatCreatedAt() { return { text: "12:34" }; }' +
  '\nreturn { body: centerChatBodyHtml, item: centerChatItemHtml };')({ students: [] });
const link = url => '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';

test('일반 메시지는 URL 없음·한글·개행을 보존하고 HTTP(S) 여러 주소를 연다', () => {
  assert.equal(chatRender.body('한글 안내\n다음 줄 & 내용'), '한글 안내<br>다음 줄 &amp; 내용');
  assert.equal(chatRender.body(''), '');
  assert.equal(chatRender.body(null), '');
  assert.equal(chatRender.body('자료 https://example.com/\n참고 http://example.org/path'),
    '자료 ' + link('https://example.com/') + '<br>참고 ' + link('http://example.org/path'));
  assert.equal(chatRender.body('HTTPS://example.com/'), link('HTTPS://example.com/'));
  assert.equal(chatRender.body('www.example.com'), 'www.example.com');
  assert.equal(chatRender.body('https://'), 'https://');
  assert.equal(chatRender.body('http://[잘못된주소'), 'http://[잘못된주소');
});

test('쿼리·해시·한글 주소는 보존하고 문장부호와 바깥 괄호는 링크에서 뺀다', () => {
  const query = 'https://example.com/자료?q=한글&amp;page=2#오늘';
  assert.equal(chatRender.body('https://example.com/자료?q=한글&page=2#오늘'), link(query));
  for (const [text, expected] of [
    ['https://example.com/a.', link('https://example.com/a') + '.'],
    ['https://example.com/a,', link('https://example.com/a') + ','],
    ['https://example.com/a!?;:', link('https://example.com/a') + '!?;:'],
    ['(https://example.com/a).', '(' + link('https://example.com/a') + ').'],
    ['[https://example.com/a]', '[' + link('https://example.com/a') + ']'],
    ['「https://example.com/a」。', '「' + link('https://example.com/a') + '」。'],
    ['https://example.com/a_(b)', link('https://example.com/a_(b)')],
    ['(https://example.com/a_(b)).', '(' + link('https://example.com/a_(b)') + ').'],
    ['https://example.com/?q=(a)&x=[b]#part', link('https://example.com/?q=(a)&amp;x=[b]#part')]
  ]) assert.equal(chatRender.body(text), expected, text);
});

test('HTML·속성 삽입과 실행형 스킴은 활성 코드가 되지 않는다', () => {
  assert.equal(chatRender.body('<img src=x onerror=alert(1)>\n<script>alert(1)</script>'),
    '&lt;img src=x onerror=alert(1)&gt;<br>&lt;script&gt;alert(1)&lt;/script&gt;');
  for (const text of [
    'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<svg onload=alert(1)>',
    'vbscript:msgbox(1)', 'file:///test', '//example.com',
    'javascript:https://example.com/', 'xhttps://example.com/'
  ]) assert.doesNotMatch(chatRender.body(text), /<a\b/, text);
  assert.equal(chatRender.body('https://example.com/" onclick="alert(1)'),
    link('https://example.com/') + '&quot; onclick=&quot;alert(1)');
  assert.equal(chatRender.body("https://example.com/?a=1&b=&#39;<svg>"),
    link('https://example.com/?a=1&amp;b=&amp;#39') + ';&lt;svg&gt;');
  assert.equal(chatRender.body('https://example.com/\u0000javascript:alert(1)'),
    link('https://example.com/') + '\u0000javascript:alert(1)');
});

test('일반 메시지만 링크화하고 기존 presence HTML과 원본 항목을 보존한다', () => {
  const item = { id: 'virtual-1', kind: 'message', actorName: '가상 교직원', body: 'https://example.com/', createdAt: '' };
  const before = JSON.stringify(item);
  assert.ok(chatRender.item(item).includes(link(item.body)));
  assert.equal(JSON.stringify(item), before);
  const presence = { ...item, kind: 'presence', studentName: '가상 학생 <A>', grade: '가상 학년', status: 'arrived' };
  assert.equal(chatRender.item(presence),
    '<article class="center-chat-item is-presence" data-center-chat-item="virtual-1">' +
    '<div class="center-chat-item-meta"><b>가상 교직원</b><time>12:34</time></div>' +
    '<div class="center-chat-item-body">가상 학생 &lt;A&gt; <span class="muted">· 가상 학년</span> · 등원</div></article>');
  assert.equal(presence.body, item.body);
});

test('고정 바로가기는 스크롤 밖 헤더에서 일반 주소·새 탭·권한 안내와 키보드 접근을 제공한다', () => {
  const head = block('<header class="center-chat-head">', '</header>');
  const anchors = [...head.matchAll(/<a\b([^>]+)>([^<]+)<\/a>/g)];
  assert.equal(anchors.length, 2);
  for (const [index, [url, title]] of [
    ['https://staff.wbcowork.com/', '통합 데스크'],
    ['https://whdudwns33-wb.github.io/wb-site/consult/', '컨설팅 플래너']
  ].entries()) {
    assert.ok(anchors[index][1].includes('href="' + url + '"'));
    assert.match(anchors[index][1], /target="_blank" rel="noopener noreferrer"/);
    assert.doesNotMatch(anchors[index][1], /data-act|data-go|onclick/);
    assert.equal(anchors[index][2], title);
  }
  assert.match(head, /각 앱의 이용 권한으로 접속합니다/);
  assert.match(source, /\.center-chat-shortcuts\s*\{[^}]*flex-wrap: wrap/);
  assert.match(source, /grid-template-rows: auto auto auto minmax\(0,1fr\) auto/);
  assert.match(source, /panel\.querySelectorAll\('a\[href\], button/);
  assert.match(source, /\.center-chat-panel a:focus-visible/);
  assert.doesNotMatch(functionBlock('centerChatBodyHtml'), /window\.open|sync\.|centerChat\.|data-act|onclick/);
  assert.match(source, /const el = ev\.target\.closest\('\[data-act\]'\);\s*if \(!el\) return;/);
});
