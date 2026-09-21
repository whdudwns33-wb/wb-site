'use strict';
/* 관리 화면 공용 로그인 — 화면 12장이 각자 폼을 그리던 것을 여기 하나로 모은다.
   판정은 서버의 admin-auth.mjs 하나이고, 화면 쪽도 하나여야 갈래가 엇갈리지 않는다.

   두 갈래: 아이디·비밀번호(ADMIN_ID·ADMIN_PASSWORD) 와 PIN(ADMIN_PIN). 서버가 둘 다 받고
   같은 관리 토큰을 돌려준다. 기본은 아이디·비밀번호 — 브라우저 비밀번호 관리자가 기억해 주고,
   PIN 한 칸보다 지키기 쉽다. PIN 갈래는 지우지 않는다: PIN 만 설정된 곳에서 이걸 지우면
   그 화면에 아무도 못 들어간다.

   토큰은 화면마다 두는 자리가 달라(localStorage·sessionStorage, 키 이름도 제각각) 여기서 저장하지
   않고 onToken 으로 넘긴다. */
(function (root) {
  var MODE_KEY = 'wbr.admin.loginMode';
  var ACCOUNT = 'account', PIN = 'pin';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* 저장된 갈래를 읽는다. 저장소를 못 쓰는 브라우저(사생활 보호 모드)에서도 죽지 않는다. */
  function readMode() {
    try {
      var v = localStorage.getItem(MODE_KEY);
      return v === PIN ? PIN : ACCOUNT;
    } catch (e) { return ACCOUNT; }
  }
  function writeMode(m) {
    try { localStorage.setItem(MODE_KEY, m === PIN ? PIN : ACCOUNT); } catch (e) {}
  }

  /* 서버로 보낼 몸통. 아이디 갈래는 id·password, PIN 갈래는 pin 만 보낸다 —
     admin-auth.mjs 가 "id 나 password 가 있으면 아이디 갈래" 로 가른다. */
  function body(mode, v) {
    return mode === PIN
      ? { pin: String(v.pin == null ? '' : v.pin) }
      : { id: String(v.id == null ? '' : v.id), password: String(v.password == null ? '' : v.password) };
  }

  /* 빈 칸을 서버까지 보내지 않는다 — 실패 횟수만 축내고 잠금에 가까워진다 */
  function missing(mode, v) {
    if (mode === PIN) return v.pin ? '' : '관리 PIN 을 입력해 주세요.';
    if (!v.id) return '아이디를 입력해 주세요.';
    if (!v.password) return '비밀번호를 입력해 주세요.';
    return '';
  }

  function formHtml(mode, msg, cls) {
    var btn = (cls && cls.btn) || 'btn';
    var fields = mode === PIN
      ? '<input id="wbaPin" name="pin" type="password" autocomplete="current-password" placeholder="PIN" style="flex:1;min-width:120px">'
      : '<input id="wbaId" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="아이디" style="flex:1;min-width:120px">' +
        '<input id="wbaPw" name="password" type="password" autocomplete="current-password" placeholder="비밀번호" style="flex:1;min-width:120px">';
    /* <form> 으로 두는 이유: 브라우저 비밀번호 관리자가 아이디·비밀번호 칸을 알아보고 저장·자동 입력한다.
       제출은 fetch 로만 하고 기본 동작은 막는다. */
    return '<form id="wbaForm" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' + fields +
      '<button class="' + esc(btn) + '" id="wbaGo" type="submit">로그인</button></form>' +
      (msg ? '<p class="err" id="wbaErr" role="alert">' + esc(msg) + '</p>' : '<p class="err" id="wbaErr" role="alert" hidden></p>') +
      '<p class="muted" style="margin:8px 0 0"><a href="#" id="wbaSwap">' +
      (mode === PIN ? '아이디·비밀번호로 로그인' : 'PIN 으로 로그인') + '</a></p>';
  }

  /* host: 폼을 넣을 요소. onToken(token, via): 로그인 성공. path: 로그인 API(기본 /api/admin/login) */
  function mount(opt) {
    var o = opt || {};
    var host = typeof o.host === 'string' ? document.querySelector(o.host) : o.host;
    if (!host) return null;
    var mode = o.mode === PIN || o.mode === ACCOUNT ? o.mode : readMode();
    var path = o.path || '/api/admin/login';
    var fetchFn = o.fetchFn || (typeof fetch === 'function' ? fetch : null);

    function draw(msg) {
      host.innerHTML = formHtml(mode, msg, o.classes);
      var form = host.querySelector('#wbaForm');
      var err = host.querySelector('#wbaErr');
      form.onsubmit = function (e) {
        e.preventDefault();
        var v = mode === PIN
          ? { pin: (host.querySelector('#wbaPin') || {}).value }
          : { id: (host.querySelector('#wbaId') || {}).value, password: (host.querySelector('#wbaPw') || {}).value };
        var gap = missing(mode, v);
        if (gap) { err.hidden = false; err.textContent = gap; return; }
        var go = host.querySelector('#wbaGo');
        go.disabled = true; err.hidden = true;
        fetchFn(path, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body(mode, v))
        }).then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            if (!r.ok) throw new Error(j.error || ('로그인 실패 (' + r.status + ')'));
            return j;
          });
        }).then(function (j) {
          if (!j || !j.token) throw new Error('토큰을 받지 못했습니다.');
          if (o.onToken) o.onToken(j.token, j.via || '');
        }).catch(function (e2) {
          go.disabled = false;
          err.hidden = false;
          err.textContent = (e2 && e2.message) || '서버에 연결할 수 없습니다.';
        });
      };
      host.querySelector('#wbaSwap').onclick = function (e) {
        e.preventDefault();
        mode = mode === PIN ? ACCOUNT : PIN;
        writeMode(mode);
        draw('');
      };
      var first = host.querySelector(mode === PIN ? '#wbaPin' : '#wbaId');
      if (first && first.focus) { try { first.focus(); } catch (x) {} }
    }

    draw(o.message || '');
    return { redraw: draw, get mode() { return mode; } };
  }

  root.WBAdminLogin = { mount: mount, body: body, missing: missing, readMode: readMode, formHtml: formHtml, ACCOUNT: ACCOUNT, PIN: PIN };
}(typeof window !== 'undefined' ? window : globalThis));

if (typeof module !== 'undefined' && module.exports) module.exports = (typeof window !== 'undefined' ? window : globalThis).WBAdminLogin;
