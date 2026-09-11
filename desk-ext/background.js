/* WB 프로그램데스크 캡처 — 백그라운드(서비스 워커).
 * 표 데이터를 데스크로 보내는 유일한 자리. 팝업은 페이지를 클릭하는 순간 닫히므로 콘텐츠 스크립트 → 여기 → 데스크 순으로 간다.
 * 저장하는 것은 데스크 주소·기기 토큰·이름뿐(chrome.storage.local). 페이지 내용은 보내고 남기지 않는다. */
'use strict';

const DEFAULT_BASE = 'https://wb-desk.whdudwns33.workers.dev';

async function config() {
  const s = await chrome.storage.local.get(['base', 'token', 'name']);
  return { base: String(s.base || DEFAULT_BASE).replace(/\/+$/, ''), token: String(s.token || ''), name: String(s.name || '') };
}

async function sendCapture(payload) {
  const c = await config();
  if (!c.token) return { ok: false, error: '먼저 확장 프로그램 아이콘을 눌러 데스크 링크로 연결하세요' };
  try {
    const res = await fetch(c.base + '/api/captures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.token },
      body: JSON.stringify(payload)
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) { await chrome.storage.local.remove(['token', 'name']); return { ok: false, error: '연결이 풀렸습니다 — 아이콘을 눌러 새 링크로 다시 연결하세요' }; }
    if (!res.ok) return { ok: false, error: body.error || ('HTTP ' + res.status) };
    return { ok: true, id: body.id, rowCount: body.rowCount, scrubbed: body.scrubbed };
  } catch (error) {
    return { ok: false, error: '데스크에 연결하지 못했습니다 — 인터넷·주소를 확인하세요' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'capture') return false;
  sendCapture(msg.payload || {}).then(sendResponse);
  return true;   // sendResponse 를 나중에 부른다
});
