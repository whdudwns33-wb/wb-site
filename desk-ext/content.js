/* WB 프로그램데스크 캡처 — 콘텐츠 스크립트. 팝업이 [표 고르기]를 누르면 이 파일을 현재 탭에 넣는다(activeTab 권한, 그 순간만).
 * 하는 일: 화면의 표(행 2개 이상)에 점선 테두리를 씌우고, 클릭한 표의 머리글·행을 글자로 뽑아 백그라운드로 보낸다.
 * 페이지의 다른 것은 읽지 않고, 자동으로 도는 것도 없다. Esc 로 취소. 같은 탭에 두 번 넣어도 한 번만 산다. */
(function () {
  'use strict';
  const MAX_ROWS = 500, MAX_COLS = 40, MAX_CELL = 200;

  function cellText(el) { return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CELL); }

  /** 표 하나 → {header:[…], rows:[[…]]}. 머리글은 th 가 있는 첫 행, 없으면 첫 행. 중첩 표의 행은 세지 않는다. */
  function extract(table) {
    const trs = Array.from(table.querySelectorAll('tr')).filter(tr => tr.closest('table') === table);
    if (!trs.length) return null;
    const headerRow = trs.find(tr => tr.querySelector('th')) || trs[0];
    const header = Array.from(headerRow.children).slice(0, MAX_COLS).map(cellText);
    const rows = trs.filter(tr => tr !== headerRow)
      .map(tr => Array.from(tr.children).slice(0, MAX_COLS).map(cellText))
      .filter(r => r.some(Boolean))
      .slice(0, MAX_ROWS);
    return { header: header, rows: rows };
  }

  if (window.__wbDeskCapture) { window.__wbDeskCapture.start(window.__wbDeskCaptureOpts); return; }

  let opts = {}, picking = false, toastEl = null, toastTimer = null;

  function tables() { return Array.from(document.querySelectorAll('table')).filter(t => t.querySelectorAll('tr').length >= 2); }
  function ensureStyle() {
    if (document.getElementById('wb-desk-capture-style')) return;
    const s = document.createElement('style');
    s.id = 'wb-desk-capture-style';
    s.textContent = '.wb-desk-pick{outline:3px dashed #D9822B !important;outline-offset:2px;cursor:pointer !important}' +
      '.wb-desk-pick:hover{outline-color:#1E3A3F !important;background:rgba(217,130,43,.08) !important}' +
      '#wb-desk-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1E3A3F;color:#fff;padding:10px 18px;border-radius:8px;' +
      'font:14px/1.5 system-ui,sans-serif;z-index:2147483647;box-shadow:0 4px 16px rgba(0,0,0,.25);max-width:90vw}' +
      '#wb-desk-toast.bad{background:#B3261E}';
    document.documentElement.appendChild(s);
  }
  function toast(msg, ok) {
    ensureStyle();
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.id = 'wb-desk-toast'; document.documentElement.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.className = ok ? '' : 'bad';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (toastEl) { toastEl.remove(); toastEl = null; } }, 4500);
  }
  function stop() {
    picking = false;
    tables().forEach(t => t.classList.remove('wb-desk-pick'));
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
  }
  function onKey(ev) { if (ev.key === 'Escape' && picking) { ev.preventDefault(); stop(); toast('취소했습니다', true); } }
  function onClick(ev) {
    if (!picking) return;
    const table = ev.target && ev.target.closest ? ev.target.closest('table') : null;
    if (!table) return;
    ev.preventDefault(); ev.stopPropagation();
    const data = extract(table);
    stop();
    if (!data || !data.rows.length) { toast('표에서 행을 읽지 못했습니다', false); return; }
    toast('데스크로 보내는 중…', true);
    const payload = { program: String(opts.program || ''), page: { host: location.host, title: document.title }, header: data.header, rows: data.rows, capturedAt: Date.now() };
    try {
      chrome.runtime.sendMessage({ type: 'capture', payload: payload }, res => {
        if (chrome.runtime.lastError || !res) { toast('보내지 못했습니다 — 확장 프로그램을 다시 여세요', false); return; }
        toast(res.ok ? '데스크로 보냈습니다 — ' + res.rowCount + '행' + (res.scrubbed ? ' (개인정보 ' + res.scrubbed + '칸 가림)' : '') : '실패 — ' + res.error, !!res.ok);
      });
    } catch (error) { toast('보내지 못했습니다', false); }
  }
  function start(o) {
    opts = o || {};
    const ts = tables();
    if (!ts.length) { toast('이 화면에 표가 없습니다', false); return; }
    ensureStyle();
    ts.forEach(t => t.classList.add('wb-desk-pick'));
    picking = true;
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    toast('보낼 표를 클릭하세요 (' + ts.length + '개 · Esc 취소)', true);
  }

  window.__wbDeskCapture = { start: start, stop: stop, extract: extract };
  if (window.__wbDeskCaptureOpts) start(window.__wbDeskCaptureOpts);
})();
