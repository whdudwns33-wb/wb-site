/* WB 프로그램데스크 캡처 — 팝업. 연결(개인 링크 → 기기 토큰), 프로그램 고르기, 콘텐츠 스크립트 넣기.
 * 표 데이터는 여기를 거치지 않는다(팝업은 페이지를 클릭하면 닫힌다) — background.js 가 보낸다. */
'use strict';

const DEFAULT_BASE = 'https://wb-desk.whdudwns33.workers.dev';
const HOST_PROGRAM = [[/sfcenter\.co\.kr/i, 'studyforce'], [/classcard\.net/i, 'classcard'], [/mmath|mmatht/i, 'metamath'], [/nelt\.co\.kr|netutor\.co\.kr/i, 'nelt']];
const $ = id => document.getElementById(id);

async function config() {
  const s = await chrome.storage.local.get(['base', 'token', 'name']);
  return { base: String(s.base || DEFAULT_BASE).replace(/\/+$/, ''), token: String(s.token || ''), name: String(s.name || '') };
}
function show(connected, text, bad) {
  $('status').textContent = text;
  $('status').className = bad ? 'bad' : (connected ? 'ok' : 'hint');
  $('linkBox').hidden = connected;
  $('pickBox').hidden = !connected;
}
async function refresh() {
  const c = await config();
  $('base').value = c.base;
  if (!c.token) { show(false, '아직 연결되지 않았습니다.', false); return; }
  try {
    const res = await fetch(c.base + '/api/me', { headers: { Authorization: 'Bearer ' + c.token } });
    if (res.status === 401) { await chrome.storage.local.remove(['token', 'name']); show(false, '연결이 풀렸습니다 — 새 링크로 다시 연결하세요.', true); return; }
    const me = await res.json();
    show(true, '연결됨 · ' + (me.name || c.name || '직원'), false);
  } catch (error) { show(true, '연결됨(오프라인) · ' + (c.name || '직원'), false); }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const host = tab && tab.url ? new URL(tab.url).host : '';
    const hit = HOST_PROGRAM.find(p => p[0].test(host));
    if (hit) $('program').value = hit[1];
  } catch (error) { /* 탭 정보 없음 — 기본값 그대로 */ }
}
async function connect() {
  const raw = String($('link').value || '').trim();
  const m = raw.match(/c=([A-Za-z0-9_-]{4,200})/) || raw.match(/^([A-Za-z0-9_-]{16,200})$/);
  if (!m) { show(false, '링크 형식이 아닙니다 — #c= 뒤의 코드가 필요합니다.', true); return; }
  const c = await config();
  try {
    const res = await fetch(c.base + '/api/link-exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: m[1] }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.token) { show(false, '연결 실패 — ' + (body.error || ('HTTP ' + res.status)), true); return; }
    await chrome.storage.local.set({ token: body.token, name: body.name || '' });
    $('link').value = '';
    await refresh();
  } catch (error) { show(false, '데스크에 연결하지 못했습니다 — 주소를 확인하세요.', true); }
}
async function pick() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !/^https?:/.test(tab.url || '')) { show(true, '이 탭에서는 쓸 수 없습니다 (웹 페이지에서 눌러 주세요).', true); return; }
  const opts = { program: $('program').value };
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: o => { window.__wbDeskCaptureOpts = o; }, args: [opts] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    window.close();
  } catch (error) { show(true, '이 화면에는 넣을 수 없습니다 — ' + (error && error.message || ''), true); }
}
async function disconnect() {
  const c = await config();
  try { await fetch(c.base + '/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + c.token } }); } catch (error) { /* 토큰은 어차피 버린다 */ }
  await chrome.storage.local.remove(['token', 'name']);
  await refresh();
}
async function saveBase() {
  const v = String($('base').value || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/]+/.test(v)) { show(false, '주소는 https:// 로 시작해야 합니다.', true); return; }
  await chrome.storage.local.set({ base: v });
  await refresh();
}

$('connect').addEventListener('click', connect);
$('link').addEventListener('keydown', ev => { if (ev.key === 'Enter') connect(); });
$('pick').addEventListener('click', pick);
$('disconnect').addEventListener('click', disconnect);
$('saveBase').addEventListener('click', saveBase);
refresh();
