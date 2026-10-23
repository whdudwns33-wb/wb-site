(() => {
  'use strict';
  let revision, csrf;
  const localKey = 'wb-consulting-v1', marker = 'wb-server-version';
  // shortcut: preserve the app's synchronous save/error contract until its callers can await saves.
  function request(method, path, body) {
    const xhr = new XMLHttpRequest(); xhr.open(method, path, false);
    xhr.setRequestHeader('Content-Type', 'application/json');
    if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf);
    xhr.send(body === undefined ? null : JSON.stringify(body));
    let data;
    try { data = JSON.parse(xhr.responseText); } catch { throw Error('서버 응답을 확인하지 못했습니다. 기기 기록은 보존됩니다.'); }
    if (xhr.status < 200 || xhr.status >= 300) throw Error(data.error || '서버에 저장하지 못했습니다.');
    return data;
  }
  window.WB_SHARED = {
    load() {
      csrf = request('GET', '/api/auth/me').csrf;
      const state = request('GET', '/api/workspace'), local = localStorage.getItem(localKey);
      if (local && !localStorage.getItem(marker) && JSON.stringify(JSON.parse(local)) !== JSON.stringify(state.data)) {
        localStorage.setItem('wb-pre-server-backup-' + Date.now(), local);
        window.addEventListener('DOMContentLoaded', () => {
          document.body.textContent = '';
          const box = document.createElement('div'); box.style.cssText = 'max-width:600px;margin:64px auto;padding:24px;font-family:sans-serif';
          const text = document.createElement('p'); text.textContent = '이 기기에 서버와 다른 상담 기록이 있어 자동으로 덮어쓰지 않았습니다. 기기 사본을 내려받은 뒤 원장님이 확인해 주세요.'; box.append(text);
          const download = document.createElement('button'); download.textContent = '기존 기기 기록 백업 받기';
          download.onclick = () => { const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([local], {type: 'application/json'})); link.download = 'wb-before-shared-server.json'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); }; box.append(download);
          const useServer = document.createElement('button'); useServer.textContent = '기기 사본을 보존하고 서버 자료 열기';
          useServer.onclick = () => { if (confirm('이 기기의 원본 사본은 보존됩니다. 서버 자료를 열까요?')) { localStorage.setItem(marker, String(state.revision)); location.reload(); } }; box.append(useServer);
          const useLocal = document.createElement('button'); useLocal.textContent = '이 기기 기록을 공용 서버로 이전';
          useLocal.onclick = () => { if (confirm('공용 서버의 현재 버전을 보관한 뒤 이 기기 자료를 적용할까요?')) { try { const result = request('PUT', '/api/workspace', {revision: state.revision, data: JSON.parse(local)}); localStorage.setItem(marker, String(result.revision)); location.reload(); } catch (error) { alert(error.message); } } }; box.append(useLocal);
          document.body.append(box);
        }, {once: true});
        throw Error('서로 다른 기기 기록 확인이 필요합니다.');
      }
      revision = state.revision;
      localStorage.setItem(localKey, JSON.stringify(state.data)); localStorage.setItem(marker, String(revision));
      return state.data;
    },
    save(next) {
      const text = JSON.stringify(next), result = request('PUT', '/api/workspace', {revision, data: next});
      revision = result.revision;
      // The server has already retained the snapshot even if this browser's cache is full.
      try { localStorage.setItem(localKey, text); localStorage.setItem(marker, String(revision)); } catch { alert('서버에는 저장됐지만 이 기기의 백업 캐시 공간이 부족합니다.'); }
      return text;
    },
  };
  window.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.querySelector('aside') || document.querySelector('.sidebar');
    const link = document.createElement('a'); link.href = '/account'; link.textContent = '내 계정 · 비밀번호 · API/MCP'; link.style.cssText = 'display:block;padding:12px;color:inherit;font-size:13px';
    if (sidebar) sidebar.append(link);
    else { link.style.cssText += ';position:fixed;right:12px;bottom:12px;background:var(--panel);border:1px solid var(--line);z-index:999'; document.body.append(link); }
  }, {once: true});
})();
