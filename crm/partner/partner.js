/* WB 파트너 포털 — 연계 학원이 쓰는 화면(외부 사용자). 센터에서 받은 개인 링크(#c=코드)로 한 번 연결하면 이 기기에 토큰이 남는다.
 * 하는 일 셋: 소개 보내기(보호자 동의 필수) · 보내 주신 소개의 진행(거친 단계) · 받은 소개의 상태 표시(연락됨/등록/미등록).
 * 전화·메모 등 가정 정보는 서버가 내려주지 않으므로 여기엔 애초에 없다. API 는 /api/partner/* 만 쓴다. */
'use strict';

const TOKEN_KEY = 'crm.partner.token';
const STATUS_LABEL = { sent: '보냄', contacted: '연락됨', enrolled: '등록', declined: '미등록' };
const STATUS_ORDER = ['sent', 'contacted', 'enrolled', 'declined'];
let me = null, data = { inbound: [], outbound: [] }, err = '', busy = false, tab = 'send';

const $ = s => document.querySelector(s);
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function val(id) { const el = $('#' + id); return el ? String(el.value || '').trim() : ''; }
function toast(msg) { const t = $('#toast'); if (!t) return; t.textContent = msg; t.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 2800); }
function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* 사설 모드 */ } }

async function api(path, body, opts) {
  const o = opts || {};
  const headers = { Accept: 'application/json' };
  if (getToken() && !o.noAuth) headers.Authorization = 'Bearer ' + getToken();
  const init = { method: body ? 'POST' : 'GET', headers, cache: 'no-store' };
  if (body) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, init); } catch (e) { throw Object.assign(new Error('서버에 연결할 수 없습니다'), { code: 'NETWORK' }); }
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  if (res.status === 401) { if (!o.noAuth) { setToken(''); me = null; render(); } throw Object.assign(new Error((json && json.error) || '연결이 필요합니다'), { code: 'AUTH' }); }
  if (!res.ok || !json || json.ok === false) throw Object.assign(new Error((json && (json.error || json.code)) || ('HTTP ' + res.status)), { code: (json && json.code) || 'HTTP' });
  return json;
}

async function load() {
  const m = await api('/api/partner/me');
  me = m;
  data = await api('/api/partner/referrals');
  err = '';
}
async function start() {
  render();
  const code = (location.hash.match(/^#c=([A-Za-z0-9_-]{4,200})$/) || [])[1];
  if (code) {
    try {
      const r = await api('/api/partner/link-exchange', { code }, { noAuth: true });
      setToken(r.token); history.replaceState(null, '', location.pathname);
      toast('이 기기를 연결했습니다');
    } catch (e) { err = '링크 연결 실패 — ' + e.message + ' (링크는 7일 안에 한 번만 쓸 수 있습니다. 센터에 새 링크를 요청해 주세요)'; render(); return; }
  }
  if (!getToken()) { render(); return; }
  try { await load(); } catch (e) { if (e.code !== 'AUTH') err = e.message; }
  render();
}

function render() {
  const who = $('#who'), org = $('#orgName'), view = $('#view');
  if (org) org.textContent = me ? String(me.org || '') : '';
  if (who) who.innerHTML = me ? '<span class="whoami owner">' + esc(me.partner.name) + '</span><button class="btn-bar" data-act="logout">연결 해제</button>' : '';
  if (!me) {
    view.innerHTML = '<div class="login"><div class="logo">W</div><h1 class="page">WB 파트너 포털</h1>' +
      '<div class="card-sub mb14">웩슬러브레인센터와 연계한 학원이 소개를 보내고 진행을 확인하는 곳입니다.</div>' +
      (err ? '<div class="banner bad">' + esc(err) + '</div>' : '') +
      '<div class="card"><div class="card-title">센터에서 받은 링크로 열어 주세요</div><div class="hint mt8">원장님이 보내 드린 개인 링크를 이 기기에서 한 번 열면 연결됩니다. 링크가 없거나 만료됐으면 센터에 요청해 주세요.</div></div></div>';
    return;
  }
  const s = me.stats || {};
  let h = (err ? '<div class="banner bad">' + esc(err) + '</div>' : '');
  h += '<div class="tiles"><div class="tile"><div class="n">' + (s.inbound || 0) + '</div><div class="l">보내 주신 가정</div></div>' +
    '<div class="tile"><div class="n">' + (s.inboundTested || 0) + '</div><div class="l">검사 완료</div></div>' +
    '<div class="tile good"><div class="n">' + (s.inboundWon || 0) + '</div><div class="l">등록</div></div>' +
    '<div class="tile"><div class="n">' + (s.outbound || 0) + '<small>/ 등록 ' + (s.outboundEnrolled || 0) + '</small></div><div class="l">저희가 소개한 가정</div></div></div>';
  if (me.partner.terms && (me.partner.terms.inbound || me.partner.terms.outbound)) {
    h += '<div class="banner ok">' + (me.partner.terms.inbound ? '보내 주신 가정 혜택: <b>' + esc(me.partner.terms.inbound) + '</b>' : '') + (me.partner.terms.outbound ? ' · 소개받은 가정 혜택: <b>' + esc(me.partner.terms.outbound) + '</b>' : '') + '</div>';
  }
  h += '<div class="chips mb14">' + [['send', '소개 보내기'], ['inbound', '보내 주신 소개 ' + data.inbound.length], ['outbound', '받은 소개 ' + data.outbound.length]].map(([k, l]) => '<button class="chip' + (tab === k ? ' on' : '') + '" data-act="tab" data-t="' + k + '">' + esc(l) + '</button>').join('') + '</div>';
  if (tab === 'send') {
    h += '<div class="card"><div class="card-title">소개 보내기</div><div class="card-sub mb8">보호자께 센터 검사 안내와 연락 동의를 받은 뒤 보내 주세요. 센터가 하루 안에 연락드립니다.</div>' +
      '<div class="grid2"><div class="field"><label class="fl" for="f-name">보호자 이름 *</label><input class="in" id="f-name" maxlength="40"></div><div class="field"><label class="fl" for="f-rel">관계</label><select class="in" id="f-rel"><option value="모">어머니</option><option value="부">아버님</option><option value="기타">보호자</option></select></div></div>' +
      '<div class="field"><label class="fl" for="f-phone">보호자 전화 *</label><input class="in" id="f-phone" inputmode="tel" placeholder="010-0000-0000"></div>' +
      '<div class="grid2"><div class="field"><label class="fl" for="f-child">아이 이름</label><input class="in" id="f-child" maxlength="40"></div><div class="field"><label class="fl" for="f-grade">학년</label><input class="in" id="f-grade" placeholder="초3 / 중1"></div></div>' +
      '<div class="field"><label class="fl" for="f-memo">메모(아이의 상황, 검사 희망 시기)</label><textarea class="in" id="f-memo" rows="3" maxlength="300"></textarea><div class="hint">전화번호는 전화 칸에만 적어 주세요 — 메모에 번호가 있으면 접수되지 않습니다.</div></div>' +
      '<label class="check"><input type="checkbox" id="f-consent"> 보호자께 센터 연락 동의를 받았습니다</label>' +
      '<button class="btn btn-primary btn-block mt8" data-act="send"' + (busy ? ' disabled' : '') + '>보내기</button></div>';
  } else if (tab === 'inbound') {
    h += '<div class="card"><div class="card-title">보내 주신 소개</div><div class="card-sub mb8">접수 → 예약 → 검사 완료 → 등록/종료. 자세한 진행은 센터에 문의해 주세요.</div>';
    h += data.inbound.length ? data.inbound.map(r => '<div class="fu"><div class="grow"><b>' + esc(r.name) + '</b>' + (r.childName ? ' · ' + esc(r.childName) : '') + (r.grade ? ' <span class="muted small">' + esc(r.grade) + '</span>' : '') + '<div class="small muted">' + esc(r.createdAt) + '</div></div><span class="pill' + (r.stage === '등록' ? ' ok' : r.stage === '종료' ? '' : ' acc') + '">' + esc(r.stage) + '</span></div>').join('') : '<div class="empty small">아직 보내 주신 소개가 없습니다</div>';
    h += '</div>';
  } else {
    h += '<div class="card"><div class="card-title">센터가 소개한 가정</div><div class="card-sub mb8">가정이 연락해 오면 상태를 표시해 주세요 — 월 정산의 근거가 됩니다.</div>';
    h += data.outbound.length ? data.outbound.map(r => '<div class="fu"><div class="grow"><b>' + esc(r.childName || r.guardian) + '</b>' + (r.grade ? ' <span class="muted small">' + esc(r.grade) + '</span>' : '') + (r.guardian && r.childName ? ' <span class="muted small">· ' + esc(r.guardian) + '</span>' : '') +
      '<div class="small muted">' + esc(r.at) + (r.note ? ' · ' + esc(r.note) : '') + '</div>' + (r.partnerNote ? '<div class="small">' + esc(r.partnerNote) + '</div>' : '') + '</div>' +
      '<select class="in" style="width:auto" data-act="status" data-id="' + esc(r.id) + '">' + STATUS_ORDER.map(k => '<option value="' + k + '"' + (k === r.status ? ' selected' : '') + '>' + STATUS_LABEL[k] + '</option>').join('') + '</select>' +
      '<button class="btn btn-sm btn-ghost" data-act="note" data-id="' + esc(r.id) + '">메모</button></div>').join('') : '<div class="empty small">아직 받은 소개가 없습니다</div>';
    h += '</div>';
  }
  h += '<div class="hint">문의: 센터로 직접 연락해 주세요. 이 화면은 연계 학원 전용이며 가정의 연락처는 보이지 않습니다.</div>';
  view.innerHTML = h;
}

async function send(btn) {
  if (busy) return;
  const body = { name: val('f-name'), relation: val('f-rel'), phone: val('f-phone'), childName: val('f-child'), grade: val('f-grade'), memo: val('f-memo'), consent: !!($('#f-consent') && $('#f-consent').checked) };
  if (!body.name) return toast('보호자 이름을 입력해 주세요');
  if (!body.phone) return toast('보호자 전화를 입력해 주세요');
  if (!body.consent) return toast('보호자 동의 확인을 체크해 주세요');
  busy = true; if (btn) btn.disabled = true;
  try { await api('/api/partner/referrals', body); toast('보냈습니다 — 센터가 연락드립니다'); await load(); tab = 'inbound'; }
  catch (e) { toast('접수 실패 — ' + e.message); }
  finally { busy = false; render(); }
}
async function setStatus(id, status, note) {
  try { await api('/api/partner/referrals/' + encodeURIComponent(id) + '/status', note === undefined ? { status } : { status, note }); toast('표시했습니다'); await load(); render(); }
  catch (e) { toast('실패 — ' + e.message); }
}

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, id = el.dataset.id || '';
  if (act === 'tab') { tab = el.dataset.t; return render(); }
  if (act === 'send') return send(el);
  if (act === 'note') {
    const r = data.outbound.find(x => x.id === id); if (!r) return;
    const note = prompt('메모(전화번호 없이)', r.partnerNote || '');
    if (note === null) return;
    return setStatus(id, r.status, note);
  }
  if (act === 'logout') { if (!confirm('이 기기의 연결을 해제할까요? 다시 쓰려면 센터에 새 링크를 요청해야 합니다.')) return; try { await api('/api/partner/logout', {}); } catch (err) { /* 토큰은 버린다 */ } setToken(''); me = null; return render(); }
});
document.addEventListener('change', e => { const t = e.target; if (t && t.dataset && t.dataset.act === 'status') setStatus(t.dataset.id, t.value); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && me) load().then(render).catch(() => {}); });

start();
