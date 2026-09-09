(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBLedgerUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  /* 자산 탭(제안 B, Phase 0). 원장·관리 담당 화면 전용.
     ── 저장은 전부 index.html 의 setCheck(WBLedgerCore.ledgerKey(id), 'all', {...}) 로 한다.
        상태 행(__lic__)은 덮어써도 되고, 이벤트 행(__licev__)은 늘 새 키라 불변이다.
     ── 서버는 개인 링크(staff)의 '__접두__<값>' 쓰기를 값 === 본인 staffId 일 때만 저장한다
        (worker-core.js). 자산 번호는 staffId 가 아니므로 직원 링크에서 눌러도 조용히 버려진다 —
        그래서 저장 버튼은 session.isAdmin(원장·관리 담당)에서만 그린다. 직원은 지시서만 받는다.
     ── rosterDb 는 쓰지 않는다. Phase 0~1 은 scope=exam 이라 학생 조회 자체가 없다. */

  const NOTE_MAX = 300;
  /* 드라이브 보기 링크는 사람이 붙여 넣는 값이라, 새 창으로 여는 것은 구글 드라이브 호스트일 때만이다.
     그 밖의 외부 서비스는 WBExternalLinks 의 공식 링크만 연다(계약 4-2). */
  const DRIVE_HOSTS = ['drive.google.com', 'docs.google.com'];

  /* 화면 상태. 재렌더(동기화 도착 포함)에도 살아남아야 하므로 DOM 이 아니라 여기 둔다. */
  let draft = null;        // 시험 범위 입력 폼(null = 닫힘)
  let openId = '';         // 펼친 자산 행
  let openNeed = '';       // 갭 표를 펼친 시험 범위
  let filter = 'all';      // 카탈로그 필터
  let query = '';          // 카탈로그 검색어

  const core = () => root.WBLedgerCore;

  /* index.html 의 전역(state·session·setCheck…)은 최상위 let/const/function 이라
     window 속성이 아니고 이름으로만 보인다. Node 에서 require 되면 없으므로 typeof 로 막는다. */
  function host() {
    if (typeof state === 'undefined' || typeof session === 'undefined' || typeof setCheck !== 'function') return null;
    return {
      state: state, session: session, setCheck: setCheck,
      esc: esc, toast: toast, modal: modal, closeModal: closeModal, $: $, render: render,
      today: today, now: now, liveStaff: liveStaff, staffById: staffById, applyAssignments: applyAssignments
    };
  }
  function canWrite(h) { return !!(h && h.session && h.session.isAdmin); }
  function actorId(h) {
    return h.session.isStaffLink && h.session.staffId ? String(h.session.staffId) : 'admin';
  }
  function ask(msg) { return typeof root.confirm === 'function' ? root.confirm(msg) : true; }
  function officialLink(key) {
    const ext = root.WBExternalLinks;
    const l = ext && typeof ext.linkFor === 'function' ? ext.linkFor(key) : null;
    return l && /^https:\/\//.test(String(l.url || '')) ? l : null;
  }
  function isDriveUrl(url) {
    const m = String(url || '').match(/^https:\/\/([^/?#]+)/);
    return !!m && DRIVE_HOSTS.includes(m[1].toLowerCase());
  }

  /* ── 읽기 ── */
  function rowsOf(h, kind) {
    const c = core();
    const checks = h.state.checks || {};
    return Object.keys(checks).filter(k => c.kindOfKey(k) === kind).map(k => checks[k]);
  }
  function allAssetRows(h) { return rowsOf(h, 'asset').map(core().normalizeAsset).filter(a => a.id); }
  function assets(h) {
    return allAssetRows(h).filter(a => !a.deleted).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  }
  function needs(h) {
    const c = core();
    return rowsOf(h, 'need').map(c.normalizeNeed).filter(n => n.id && !n.deleted)
      .sort((a, b) => (c.examDateOf(a) || '9999').localeCompare(c.examDateOf(b) || '9999') || a.id.localeCompare(b.id, 'en'));
  }
  function events(h) {
    return rowsOf(h, 'event').map(core().normalizeEvent).filter(e => e.id && e.type).sort((a, b) => b.at - a.at);
  }
  function assetById(h, id) { return assets(h).find(a => a.id === id) || null; }
  function needById(h, id) { return needs(h).find(n => n.id === id) || null; }

  /* ── 쓰기 ── */
  function saveAsset(h, asset) {
    const c = core();
    const a = c.normalizeAsset(asset);
    a.revision = (a.revision || 0) + 1;
    if (!a.createdAt) a.createdAt = h.now();
    h.setCheck(c.ledgerKey(a.id), 'all', a);
    return a;
  }
  function logEvent(h, assetId, type, payload) {
    const c = core();
    const ev = c.newEvent(assetId, type, actorId(h), payload, h.now());
    h.setCheck(c.eventKey(ev.id), 'all', ev);
    return ev;
  }
  function saveNeed(h, need) {
    const c = core();
    const n = c.normalizeNeed(need);
    if (!n.createdAt) n.createdAt = h.now();
    h.setCheck(c.needKey(n.id), 'all', n);
    return n;
  }
  /* 이벤트를 찍고 상태를 전이표대로 옮긴다. 표 밖이면 상태는 그대로(이벤트만 남는다). */
  function apply(h, asset, type, payload, patch) {
    const c = core();
    logEvent(h, asset.id, type, payload || {});
    const next = Object.assign({}, asset, patch || {}, { status: c.statusAfter(asset.status, type) });
    return saveAsset(h, next);
  }

  /* ── 공통 HTML ── */
  function fmtWon(n) { return core().fmtWon(n); }
  function fmtAt(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function staffName(h, id) {
    if (!id || id === 'admin') return '원장';
    const s = h.staffById(id);
    return s ? s.name : '직원';
  }
  function statusPill(h, a) {
    const c = core();
    const cls = a.blockReason ? 'pill bad'
      : a.status === 'requested' ? 'pill warn'
      : (a.status === 'rejected' || a.status === 'revoked') ? 'pill bad' : 'pill';
    return '<span class="' + cls + '">' + h.esc(c.STATUS_LABELS[a.status] || a.status) +
      (a.blockReason ? ' · 막힘' : '') + '</span>';
  }
  function extBtn(h, url, text) {
    return '<a class="btn btn-sm btn-ghost" href="' + h.esc(url) + '" target="_blank" rel="noopener noreferrer">' + h.esc(text) + ' ↗</a>';
  }
  function noteField(h, id, value) {
    return '<div class="field"><label class="fl" for="' + id + '">메모 (선택)</label>' +
      '<textarea class="in" id="' + id + '" rows="2" maxlength="' + NOTE_MAX + '" placeholder="자산 번호·과로만 지칭 — 학생 이름·학교명은 적지 않습니다">' + h.esc(value || '') + '</textarea></div>';
  }
  function readNote(h, id) {
    const el = h.$('#' + id);
    return el ? String(el.value || '').slice(0, NOTE_MAX) : '';
  }
  function val(h, id) { const el = h.$('#' + id); return el ? String(el.value || '').trim() : ''; }

  /* ── ① 승인 대기 ── */
  function pendingCard(h, all, ns, admin) {
    const c = core();
    const pending = all.filter(a => a.status === 'requested');
    let html = '<div class="card mt14"><div class="card-title">승인 대기 · ' + pending.length + '건</div>';
    if (!pending.length) {
      return html + '<div class="card-sub">승인을 기다리는 구매 요청이 없습니다. 시험 범위에서 [구매 요청]을 누르면 여기 쌓입니다.</div></div>';
    }
    html += '<div class="card-sub mb8">승인하면 담당 직원의 오늘 할 일에 구매·인테이크 지시서가 바로 내려갑니다. 앱에서 승인된 건만 결제합니다.</div>';
    const groups = {};
    pending.forEach(a => { (groups[a.links.needId || ''] = groups[a.links.needId || ''] || []).push(a); });
    Object.keys(groups).forEach(needId => {
      const list = groups[needId];
      const n = needById(h, needId);
      const total = list.reduce((s, a) => s + (a.cost.hint || 0), 0);
      const dups = list.filter(a => c.isDuplicate(a, all));
      html += '<div class="sect">' + (n ? h.esc(c.needLabel(n)) + (c.examDateOf(n) ? ' · 시험 ' + h.esc(c.examDateOf(n)) : '') : '시험 범위 없음') + '</div>';
      list.forEach(a => {
        const dup = c.duplicatesOf(a, all);
        html += '<div class="task"><div class="task-body">' +
          '<div class="task-t">' + h.esc(a.id) + ' · ' + h.esc(c.catalogLabel(a)) + '</div>' +
          '<div class="meta"><span class="tag">' + h.esc(a.catalog.edition === 'teacher' ? '교사용 권장' : (c.SERIES[a.catalog.series] && c.SERIES[a.catalog.series].required ? '팩 필수' : '선택')) + '</span>' +
            '<span class="tag time">예상 ' + h.esc(fmtWon(a.cost.hint)) + '</span>' +
            (dup.length ? '<span class="tag high">중복 — ' + h.esc(dup.map(d => d.id).join(', ')) + ' 보유</span>' : '') +
          '</div>' +
          (admin ? '<div class="row" style="margin-top:8px"><button class="btn btn-sm btn-ghost" data-act="lg-reject" data-id="' + h.esc(a.id) + '">반려</button></div>' : '') +
        '</div></div>';
      });
      html += '<div class="between mt14 mb8"><div class="small muted">' + list.length + '건 · 예상 합계 <b>' + h.esc(fmtWon(total)) + '</b>' +
        (dups.length ? ' · <b style="color:var(--coral)">중복 ' + dups.length + '건</b>' : '') + '</div>' +
        (admin ? '<button class="btn btn-sm btn-primary" data-act="lg-approve" data-id="' + h.esc(needId) + '">승인 → 지시서 발행</button>' : '') +
      '</div>';
    });
    if (!admin) html += '<div class="hint">승인·반려는 원장·관리 담당 화면에서만 됩니다.</div>';
    return html + '</div>';
  }

  /* ── ② 시험 범위·갭 표 ── */
  function blankDraft() {
    const c = core();
    return { schoolCode: '', grade: 'm2', textbookCode: '', units: [], examDateCopy: '', examTerm: '',
      requiredSeries: c.REQUIRED_SERIES.slice(), teacherSeries: c.TEACHER_SERIES.slice() };
  }
  function needForm(h) {
    const c = core();
    const d = draft;
    const opt = (v, t, cur) => '<option value="' + h.esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + h.esc(t) + '</option>';
    const unitChips = [];
    for (let u = 1; u <= 10; u++) {
      unitChips.push('<button class="chip' + (d.units.includes(u) ? ' on' : '') + '" data-act="lg-unit" data-id="' + u + '">L' + String(u).padStart(2, '0') + '</button>');
    }
    const sChips = c.SERIES_CODES.map(s => {
      const fixed = c.SERIES[s].required;
      const on = d.requiredSeries.includes(s);
      return '<button class="chip' + (on ? ' on' : '') + '"' + (fixed ? ' disabled title="팩 필수"' : ' data-act="lg-series" data-id="' + s + '"') + '>' +
        h.esc(c.SERIES[s].file) + (fixed ? ' ★' : '') + '</button>';
    }).join('');
    const tChips = c.TEACHER_SERIES.map(s =>
      '<button class="chip' + (d.teacherSeries.includes(s) ? ' on' : '') + '" data-act="lg-tseries" data-id="' + s + '">' +
        h.esc(c.SERIES[s].file) + '_교사용</button>').join('');
    return '<div class="card mt14"><div class="card-title">시험 범위 추가</div>' +
      '<div class="card-sub mb14">학교는 <b>코드</b>로만 적습니다(학교 이름 금지). 시험일은 consult 시험 일정의 값을 그대로 복사합니다 — Phase 0 한시.</div>' +
      '<div class="grid2">' +
        '<div class="field"><label class="fl" for="lg-n-school">학교 코드</label><input class="in" id="lg-n-school" data-lg-field="schoolCode" value="' + h.esc(d.schoolCode) + '" placeholder="SCH-07" autocapitalize="characters"></div>' +
        '<div class="field"><label class="fl" for="lg-n-grade">학년</label><select class="in" id="lg-n-grade" data-lg-field="grade">' +
          Object.keys(c.GRADES).map(g => opt(g, c.GRADES[g], d.grade)).join('') + '</select></div>' +
      '</div>' +
      '<div class="field"><label class="fl" for="lg-n-book">교과서</label><select class="in" id="lg-n-book" data-lg-field="textbookCode">' +
        opt('', '교과서 —', d.textbookCode) + Object.keys(c.TEXTBOOKS).map(k => opt(k, c.TEXTBOOKS[k].label, d.textbookCode)).join('') + '</select></div>' +
      '<div class="field"><div class="fl">과 (시험 범위)</div><div class="chips">' + unitChips.join('') + '</div></div>' +
      '<div class="grid2">' +
        '<div class="field"><label class="fl" for="lg-n-date">시험일 (consult 복사)</label><input class="in" id="lg-n-date" type="date" data-lg-field="examDateCopy" value="' + h.esc(d.examDateCopy) + '"></div>' +
        '<div class="field"><label class="fl" for="lg-n-term">시험 구분</label><select class="in" id="lg-n-term" data-lg-field="examTerm">' +
          opt('', '구분 —', d.examTerm) + c.EXAM_TERMS.map(t => opt(t.key, t.label, d.examTerm)).join('') + '</select></div>' +
      '</div>' +
      '<div class="field"><div class="fl">학생용 시리즈 (★ 필수는 뺄 수 없음)</div><div class="chips">' + sChips + '</div></div>' +
      '<div class="field"><div class="fl">교사용 함께 (정답·해설 — 권장)</div><div class="chips">' + tChips + '</div></div>' +
      '<button class="btn btn-primary btn-block mb8" data-act="lg-need-save">저장하고 필요 자료 산출</button>' +
      '<button class="btn btn-ghost btn-block" data-act="lg-need-cancel">닫기</button>' +
    '</div>';
  }
  function gapTable(h, d) {
    const c = core();
    if (!d.rows.length) return '<div class="hint">사야 할 자료가 없습니다 — 필요한 것은 모두 보유 중이거나 진행 중입니다.</div>';
    return d.rows.map(r =>
      '<div class="task"><div class="task-body">' +
        '<div class="task-t" style="font-size:14px">' + h.esc(c.unitLabel(r.unit)) + ' · ' + h.esc(r.fileName) + '</div>' +
        '<div class="meta"><span class="tag ' + (r.tier === 'required' ? 'high' : r.tier === 'recommended' ? 'doing' : '') + '">' +
          h.esc(r.tier === 'required' ? '팩 필수' : r.tier === 'recommended' ? '교사용 권장' : '선택') + '</span>' +
          '<span class="tag">' + h.esc(c.editionLabel(r.edition)) + '</span>' +
          '<span class="tag time">예상 ' + h.esc(fmtWon(r.hint)) + '</span></div>' +
      '</div></div>').join('');
  }
  function needsCard(h, all, ns, admin) {
    const c = core();
    let html = '<div class="card mt14"><div class="between mb8"><div class="card-title">시험 범위 · ' + ns.length + '건</div>' +
      (admin && !draft ? '<button class="btn btn-sm btn-primary" data-act="lg-need-new">＋ 시험 범위</button>' : '') + '</div>';
    html += '<div class="card-sub mb8">시험 범위를 넣으면 사야 할 자료(필요 − 보유)와 예상 금액이 산출됩니다. 시험 범위 매핑의 정본은 여기입니다.</div>';
    if (!ns.length) html += '<div class="empty"><b>📚</b>등록된 시험 범위가 없습니다.</div>';
    ns.forEach(n => {
      const d = c.deriveNeeds(n, all);
      const examDate = c.examDateOf(n);
      const left = c.daysBetween(h.today(), examDate);
      const open = openNeed === n.id;
      html += '<div class="task"><div class="task-body">' +
        '<div class="task-t" data-act="lg-need-open" data-id="' + h.esc(n.id) + '" style="cursor:pointer">' + h.esc(c.needLabel(n)) + '</div>' +
        '<div class="meta">' +
          (examDate ? '<span class="tag time">시험 ' + h.esc(examDate) + (left != null ? ' (D' + (left >= 0 ? '-' : '+') + Math.abs(left) + ')' : '') + '</span>' : '<span class="tag high">시험일 없음</span>') +
          (n.examTerm ? '<span class="tag">' + h.esc((c.EXAM_TERMS.find(t => t.key === n.examTerm) || {}).label || '') + '</span>' : '') +
          '<span class="tag">필요 ' + d.needed + '</span><span class="tag ok">보유 ' + d.owned + '</span>' +
          (d.pending ? '<span class="tag doing">진행 ' + d.pending + '</span>' : '') +
          '<span class="tag ' + (d.toBuy ? 'high' : '') + '">사야 할 ' + d.toBuy + '</span>' +
          (d.toBuy ? '<span class="tag time">예상 ' + h.esc(fmtWon(d.estimate)) + '</span>' : '') +
        '</div>' +
        (open
          ? '<div class="mt14 mb8 small muted">사야 할 자료 (필요 − 보유 − 진행 중)</div>' + gapTable(h, d) +
            '<div class="row mt14" style="flex-wrap:wrap">' +
              (admin && d.toBuy ? '<button class="btn btn-sm btn-primary" data-act="lg-request" data-id="' + h.esc(n.id) + '">구매 요청 ' + d.toBuy + '건</button>' : '') +
              (admin ? '<button class="btn btn-sm btn-ghost" data-act="lg-need-del" data-id="' + h.esc(n.id) + '">삭제</button>' : '') +
              '<button class="btn btn-sm btn-ghost" data-act="lg-need-open" data-id="">접기</button>' +
            '</div>'
          : '') +
      '</div></div>';
    });
    html += '</div>';
    if (draft && admin) html += needForm(h);
    return html;
  }

  /* ── ③ 잠자는 자료 ── */
  function sleepingCard(h, all, ns) {
    const c = core();
    const list = c.sleeping(all, ns, h.today());
    let html = '<div class="card mt14"><div class="card-title">잠자는 자료 · ' + list.length + '건</div>' +
      '<div class="card-sub' + (list.length ? ' mb8' : '') + '">시험일 D-7 안인데 등록만 되고 팩 배포·배정이 없는 자료입니다. 팩 제작 우선순위를 여기서 정합니다.</div>';
    list.forEach(x => {
      html += '<div class="task"><div class="task-body">' +
        '<div class="task-t" data-act="lg-open" data-id="' + h.esc(x.asset.id) + '" style="cursor:pointer">' + h.esc(x.asset.id) + ' · ' + h.esc(c.catalogLabel(x.asset)) + '</div>' +
        '<div class="meta"><span class="tag high">D-' + x.daysLeft + '</span><span class="tag">' + h.esc(c.needLabel(x.need)) + '</span>' +
          (x.asset.links.packId ? '<span class="tag time">' + h.esc(x.asset.links.packId) + '</span>' : '') + '</div>' +
      '</div></div>';
    });
    return html + '</div>';
  }

  /* ── ④ 카탈로그 ── */
  const FILTERS = [
    ['all', '전체', () => true],
    ['requested', '승인 대기', a => a.status === 'requested'],
    ['approved', '구매 대기', a => a.status === 'approved' || a.status === 'purchased'],
    ['registered', '등록됨', a => a.status === 'registered'],
    ['live', '배정·제공', a => a.status === 'assigned' || a.status === 'provided'],
    ['blocked', '막힘', a => !!a.blockReason],
    ['closed', '반려·회수', a => a.status === 'rejected' || a.status === 'revoked']
  ];
  function matchesQuery(a) {
    const c = core();
    if (!query) return true;
    const q = query.toLowerCase();
    return [a.id, c.catalogKey(a), c.catalogLabel(a), a.storage.drivePath, a.links.packId, a.links.needId]
      .some(s => String(s || '').toLowerCase().includes(q));
  }
  function catalogList(h, all, admin) {
    const f = FILTERS.find(x => x[0] === filter) || FILTERS[0];
    const shown = all.filter(f[2]).filter(matchesQuery);
    if (!shown.length) return '<div class="card-sub">' + (all.length ? '해당하는 자료가 없습니다.' : '아직 자산이 없습니다. 시험 범위에서 [구매 요청]으로 시작하세요.') + '</div>';
    return shown.map(a => assetRow(h, a, all, admin)).join('');
  }
  function assetRow(h, a, all, admin) {
    const c = core();
    const open = openId === a.id;
    const diff = a.cost.amount ? c.priceDiff(a.cost.hint, a.cost.amount) : null;
    let html = '<div class="task"><div class="task-body">' +
      '<div class="task-t" data-act="lg-open" data-id="' + h.esc(a.id) + '" style="cursor:pointer">' + h.esc(a.id) + ' · ' + h.esc(c.catalogLabel(a)) + ' ' + statusPill(h, a) + '</div>' +
      '<div class="meta">' +
        (a.links.packId ? '<span class="tag time">' + h.esc(a.links.packId) + '</span>' : '') +
        (a.cost.amount ? '<span class="tag' + (diff && diff.warn ? ' high' : ' ok') + '">결제 ' + h.esc(fmtWon(a.cost.amount)) + (diff && diff.warn ? ' (예상 ' + h.esc(fmtWon(a.cost.hint)) + ')' : '') + '</span>'
          : '<span class="tag">예상 ' + h.esc(fmtWon(a.cost.hint)) + '</span>') +
        (a.blockReason ? '<span class="tag blk">' + h.esc(c.BLOCK_REASONS[a.blockReason]) + '</span>' : '') +
        (a.packConfirmedAt ? '<span class="tag ok">팩 확인</span>' : '') +
        (a.links.needId ? '<span class="tag">' + h.esc(a.links.needId) + '</span>' : '') +
      '</div>' +
      '<div class="hint small" style="margin-top:6px">' + h.esc(c.catalogKey(a)) + (a.storage.drivePath ? '<br>' + h.esc(a.storage.drivePath) : '') + '</div>';
    if (open) html += assetActions(h, a, all, admin);
    return html + '</div></div>';
  }
  function assetActions(h, a, all, admin) {
    const c = core();
    const btn = (act, text, cls) => '<button class="btn btn-sm ' + (cls || 'btn-ghost') + '" data-act="' + act + '" data-id="' + h.esc(a.id) + '">' + text + '</button>';
    const links = [];
    const buy = officialLink('exam4you');
    if (buy) links.push(extBtn(h, buy.url, buy.label || '이그잼포유'));
    if (isDriveUrl(a.storage.viewUrl)) links.push(extBtn(h, a.storage.viewUrl, '드라이브 보기'));
    let html = '<div class="hint" style="margin-top:8px">인테이크 경로: ' + h.esc(c.intakePath(a) || '(카탈로그 미지정)') +
      (a.note ? '<br>메모: ' + h.esc(a.note) : '') + '</div>';
    if (links.length) html += '<div class="row" style="margin-top:8px;flex-wrap:wrap">' + links.join('') + '</div>';
    if (!admin) return html + '<div class="hint" style="margin-top:8px">기록은 원장·관리 담당 화면에서만 됩니다.</div>';
    const acts = [];
    const s = a.status;
    if (s === 'approved' || s === 'purchased') acts.push(btn('lg-register', '등록 (구매+드라이브)', 'btn-primary'));
    if (s === 'registered' || s === 'assigned' || s === 'provided') {
      if (!a.packConfirmedAt) acts.push(btn('lg-packok', '팩 배포 확인', 'btn-navy'));
      acts.push(btn('lg-provide', '배정·제공 기록'));
      acts.push(btn('lg-audit', '경로 확인'));
    }
    if (s === 'assigned' || s === 'provided') acts.push(btn('lg-revoke', '회수'));
    if (s === 'rejected') acts.push(btn('lg-rerequest', '다시 요청'));
    if (s === 'requested') acts.push(btn('lg-reject', '반려'));
    if (s !== 'revoked' && s !== 'rejected') acts.push(a.blockReason ? btn('lg-unblock', '막힘 해제', 'btn-navy') : btn('lg-block', '🚧 막힘 표시'));
    acts.push(btn('lg-del', '삭제 표시', 'btn-danger'));
    acts.push('<button class="btn btn-sm btn-ghost" data-act="lg-open" data-id="">닫기</button>');
    return html + '<div class="row" style="margin-top:8px;flex-wrap:wrap">' + acts.join('') + '</div>';
  }
  function catalogCard(h, all, admin) {
    const counts = {};
    FILTERS.forEach(f => { counts[f[0]] = all.filter(f[2]).length; });
    return '<div class="card mt14"><div class="card-title">카탈로그 · ' + all.length + '건</div>' +
      '<div class="card-sub mb8">교과서·학년·과로 찾습니다. 있으면 드라이브 보기 링크와 packId, 없으면 시험 범위에서 요청합니다.</div>' +
      '<div class="field"><input class="in" id="lg-search" data-lg-search="1" value="' + h.esc(query) + '" placeholder="검색 — MAT-0107, ne-kimgitaek, 중2, L05, packId"></div>' +
      '<div class="row mb8" style="flex-wrap:wrap">' + FILTERS.map(f =>
        '<button class="btn btn-sm ' + (filter === f[0] ? 'btn-primary' : 'btn-ghost') + '" data-act="lg-filter" data-id="' + f[0] + '">' + f[1] + ' ' + counts[f[0]] + '</button>').join('') + '</div>' +
      '<div id="lg-catalog-list">' + catalogList(h, all, admin) + '</div>' +
    '</div>';
  }

  /* ── ⑤ 이벤트 이력 ── */
  function payloadText(h, e) {
    const c = core();
    const p = e.payload || {};
    const bits = [];
    if (p.reason) bits.push(c.BLOCK_REASONS[p.reason] || p.reason);
    if (p.channel) bits.push(c.CHANNELS[p.channel] || p.channel);
    if (p.copies) bits.push(p.copies + '부');
    if (p.amount != null && e.type === 'purchase') bits.push(fmtWon(p.amount));
    if (p.to === 'staff' && p.staffId) bits.push('→ ' + staffName(h, p.staffId));
    if (p.needId) bits.push(p.needId);
    return bits.join(' · ');
  }
  function historyCard(h, all, evs) {
    const c = core();
    const recent = evs.slice(0, 30);
    const warnDup = c.duplicatePurchases(all);
    const warnReq = c.unrequestedPurchases(evs);
    let html = '<div class="card mt14"><div class="card-title">이벤트 이력 · 최근 ' + recent.length + '건</div>' +
      '<div class="card-sub' + (recent.length || warnDup.length || warnReq.length ? ' mb8' : '') + '">이벤트 행은 쓴 뒤 바뀌지 않습니다. 정정은 새 이벤트로 남깁니다.</div>';
    if (warnDup.length) html += '<div class="guide mb8" style="color:var(--coral)"><b>중복 구매</b>' + warnDup.map(d => h.esc(d.ids.join(', '))).join(' / ') + '</div>';
    if (warnReq.length) html += '<div class="guide mb8" style="color:var(--coral)"><b>요청 없이 구매됨 (규율 위반)</b>' + h.esc(warnReq.join(', ')) + '</div>';
    recent.forEach(e => {
      html += '<div class="task" style="padding:8px 4px"><div class="task-body small">' +
        '<span class="muted">' + h.esc(fmtAt(e.at)) + '</span> · <b>' + h.esc(e.assetId) + '</b> · ' + h.esc(c.EVENT_LABELS[e.type] || e.type) +
        ' · ' + h.esc(staffName(h, e.byStaffId)) +
        (payloadText(h, e) ? ' · ' + h.esc(payloadText(h, e)) : '') +
        (e.note ? '<div class="muted">' + h.esc(e.note) + '</div>' : '') +
      '</div></div>';
    });
    return html + '</div>';
  }

  /* ── 탭 전체 ── */
  function view() {
    const h = host(), c = core();
    if (!h || !c) {
      return '<div class="card mt14"><div class="card-title">자산 원장을 불러오지 못했습니다</div>' +
        '<div class="card-sub">새로고침해도 같으면 원장님께 알려주세요.</div></div>';
    }
    const all = assets(h), ns = needs(h), evs = events(h);
    const admin = canWrite(h);
    const cnt = c.countByStatus(all);
    let html = '<div class="card mt14"><div class="card-title">자산 원장 · 이그잼포유 자료 ' + all.length + '건</div>' +
      '<div class="card-sub">승인 대기 ' + cnt.requested + ' · 구매 대기 ' + (cnt.approved + cnt.purchased) + ' · 등록 ' + cnt.registered +
        ' · 배정·제공 ' + (cnt.assigned + cnt.provided) + ' · 반려·회수 ' + (cnt.rejected + cnt.revoked) + '</div>' +
      (admin ? '' : '<div class="hint" style="margin-top:8px">개인 링크에서는 읽기만 됩니다. 승인·등록·배정은 원장·관리 담당 화면에서 합니다.</div>') +
    '</div>';
    html += pendingCard(h, all, ns, admin);
    html += needsCard(h, all, ns, admin);
    html += sleepingCard(h, all, ns);
    html += catalogCard(h, all, admin);
    html += historyCard(h, all, evs);
    return html;
  }

  /* 탭 배지 — 원장이 눌러야 하는 것(승인 대기)만 센다. */
  function alertCount() {
    const h = host();
    if (!h || !core()) return 0;
    return assets(h).filter(a => a.status === 'requested').length;
  }

  /* ── 모달 ── */
  function staffSelect(h, id, withNone) {
    const list = h.liveStaff().filter(s => !s.owner);
    const def = list.find(s => s.manager) || list[0];
    return '<select class="in" id="' + id + '">' +
      (withNone ? '<option value="">지시서 없이 승인만</option>' : '') +
      list.map(s => '<option value="' + h.esc(s.id) + '"' + (def && s.id === def.id ? ' selected' : '') + '>' + h.esc(s.name) + (s.manager ? ' (관리 담당)' : '') + '</option>').join('') +
      '</select>';
  }
  function approveModal(h, needId, list) {
    const c = core();
    const total = list.reduce((s, a) => s + (a.cost.hint || 0), 0);
    h.modal('구매 승인 · ' + list.length + '건',
      '<div class="card-sub mb8">예상 합계 <b>' + h.esc(fmtWon(total)) + '</b>. 승인하면 아래 직원의 오늘 할 일에 구매·인테이크 지시서가 내려갑니다 — 공식 구매 링크·드라이브 폴더·파일명이 적혀 있습니다.</div>' +
      '<div class="small muted mb8">' + list.map(a => h.esc(a.id + ' · ' + c.catalogLabel(a))).join('<br>') + '</div>' +
      '<div class="field"><label class="fl" for="lg-m-staff">담당 직원</label>' + staffSelect(h, 'lg-m-staff', true) + '</div>',
      '<button class="btn btn-primary btn-block" data-act="lg-approve-go" data-id="' + h.esc(needId) + '">승인하고 지시서 발행</button>');
  }
  function rejectModal(h, id) {
    h.modal('반려 · ' + id,
      noteField(h, 'lg-m-note', ''),
      '<button class="btn btn-danger btn-block" data-act="lg-reject-go" data-id="' + h.esc(id) + '">반려</button>');
  }
  function registerModal(h, a) {
    const c = core();
    h.modal('등록 · ' + a.id,
      '<div class="card-sub mb8">' + h.esc(c.catalogLabel(a)) + '. 결제와 드라이브 업로드가 끝났으면 한 번에 기록합니다 (구매+등록 두 이벤트).</div>' +
      '<div class="field"><label class="fl" for="lg-m-path">드라이브 경로 (규칙에서 자동)</label><input class="in" id="lg-m-path" value="' + h.esc(a.storage.drivePath || c.intakePath(a)) + '"></div>' +
      '<div class="field"><label class="fl" for="lg-m-url">드라이브 보기 URL</label><input class="in" id="lg-m-url" inputmode="url" value="' + h.esc(a.storage.viewUrl) + '" placeholder="https://drive.google.com/file/d/…"></div>' +
      '<div class="grid2">' +
        '<div class="field"><label class="fl" for="lg-m-amount">실결제액 (원)</label><input class="in" id="lg-m-amount" inputmode="numeric" value="' + h.esc(a.cost.amount || a.cost.hint) + '"></div>' +
        '<div class="field"><label class="fl" for="lg-m-paid">결제일</label><input class="in" id="lg-m-paid" type="date" value="' + h.esc(a.cost.paidAt || h.today()) + '"></div>' +
      '</div>' +
      '<div class="hint mb8">packId 는 경로에서 파생됩니다: <b>' + h.esc(c.packIdOf(a) || '—') + '</b></div>' +
      noteField(h, 'lg-m-note', a.note),
      '<button class="btn btn-primary btn-block" data-act="lg-register-go" data-id="' + h.esc(a.id) + '">등록</button>');
  }
  function provideModal(h, a) {
    const c = core();
    h.modal('배정·제공 기록 · ' + a.id,
      '<div class="card-sub mb8">학생 제공 경로는 팩·인쇄 둘입니다. 링크는 원내 강사에게만 전달합니다(라이선스 규칙).</div>' +
      '<div class="field"><label class="fl" for="lg-m-kind">기록 종류</label><select class="in" id="lg-m-kind">' +
        '<option value="assign-pack">팩 배정 (내신브레인 시험 범위)</option>' +
        '<option value="assign-print">인쇄 배정 (부수 기록)</option>' +
        '<option value="provide-exam">학생 제공 완료 (시험 범위 단위)</option>' +
        '<option value="provide-staff">강사에게 보기 링크 전달</option>' +
      '</select></div>' +
      '<div class="grid2">' +
        '<div class="field"><label class="fl" for="lg-m-copies">인쇄 부수 (인쇄일 때)</label><input class="in" id="lg-m-copies" inputmode="numeric" value="0"></div>' +
        '<div class="field"><label class="fl" for="lg-m-staff">받는 강사 (링크일 때)</label>' + staffSelect(h, 'lg-m-staff', false) + '</div>' +
      '</div>' +
      '<div class="hint mb8">시험 범위: ' + h.esc(a.links.needId || '없음') + ' · ' + h.esc(c.CHANNELS.pack) + '은 [팩 배포 확인]으로도 남습니다.</div>' +
      noteField(h, 'lg-m-note', ''),
      '<button class="btn btn-primary btn-block" data-act="lg-provide-go" data-id="' + h.esc(a.id) + '">기록</button>');
  }
  function blockModal(h, a) {
    const c = core();
    h.modal('🚧 막힘 · ' + a.id,
      '<div class="card-sub mb8">미출간·결제·드라이브 권한은 직원 밖 요인이라 리드타임 시계를 멈춥니다.</div>' +
      '<div class="field"><label class="fl" for="lg-m-reason">사유</label><select class="in" id="lg-m-reason">' +
        Object.keys(c.BLOCK_REASONS).map(k => '<option value="' + k + '">' + h.esc(c.BLOCK_REASONS[k]) + '</option>').join('') + '</select></div>' +
      noteField(h, 'lg-m-note', ''),
      '<button class="btn btn-primary btn-block" data-act="lg-block-go" data-id="' + h.esc(a.id) + '">막힘 기록</button>');
  }

  /* ── 동작 ── */
  function handle(h, act, id, el) {
    const c = core();
    const admin = canWrite(h);
    const needAdmin = () => { if (!admin) { h.toast('원장·관리 담당 화면에서만 됩니다'); return true; } return false; };
    const asset = () => assetById(h, id);

    switch (act) {
      /* 보기 상태 */
      case 'lg-open': openId = openId === id ? '' : id; h.render(); return;
      case 'lg-need-open': openNeed = openNeed === id ? '' : id; h.render(); return;
      case 'lg-filter': filter = id || 'all'; h.render(); return;

      /* 시험 범위 폼 */
      case 'lg-need-new': if (needAdmin()) return; draft = blankDraft(); h.render(); return;
      case 'lg-need-cancel': draft = null; h.render(); return;
      case 'lg-unit': {
        if (!draft) return;
        const u = Number(id);
        draft.units = draft.units.includes(u) ? draft.units.filter(x => x !== u) : draft.units.concat(u);
        h.render(); return;
      }
      case 'lg-series': {
        if (!draft || (c.SERIES[id] && c.SERIES[id].required)) return;
        draft.requiredSeries = draft.requiredSeries.includes(id) ? draft.requiredSeries.filter(x => x !== id) : draft.requiredSeries.concat(id);
        h.render(); return;
      }
      case 'lg-tseries': {
        if (!draft) return;
        draft.teacherSeries = draft.teacherSeries.includes(id) ? draft.teacherSeries.filter(x => x !== id) : draft.teacherSeries.concat(id);
        h.render(); return;
      }
      case 'lg-need-save': {
        if (needAdmin() || !draft) return;
        const r = c.validateNeed(Object.assign({}, draft, { examRef: { examDateCopy: draft.examDateCopy } }));
        if (!r.ok) { h.toast(r.errors[0]); return; }
        const n = r.need;
        n.id = c.nextNeedId(rowsOf(h, 'need').map(c.normalizeNeed));
        n.computedAt = h.now();
        saveNeed(h, n);
        draft = null; openNeed = n.id;
        h.render(); h.toast(n.id + ' 저장 — 사야 할 자료를 확인하세요');
        return;
      }
      case 'lg-need-del': {
        if (needAdmin()) return;
        const n = needById(h, id);
        if (!n || !ask(c.needLabel(n) + ' 시험 범위를 지울까요? 이미 요청된 자산은 남습니다.')) return;
        saveNeed(h, Object.assign({}, n, { deleted: true }));
        if (openNeed === id) openNeed = '';
        h.render(); h.toast('지웠습니다');
        return;
      }

      /* 구매 요청 → 승인 대기 */
      case 'lg-request': {
        if (needAdmin()) return;
        const n = needById(h, id);
        if (!n) return;
        const all = assets(h);
        const d = c.deriveNeeds(n, all);
        if (!d.rows.length) { h.toast('사야 할 자료가 없습니다'); return; }
        /* 번호는 지움 표시된 행까지 포함해 매긴다 — 지시서·이벤트가 번호를 가리키므로 재사용하지 않는다. */
        const pool = allAssetRows(h);
        d.rows.forEach(row => {
          const newId = c.nextAssetId(pool);
          const a = c.assetFromNeedRow(row, n.id, newId, h.now());
          pool.push(a);
          saveAsset(h, a);
          logEvent(h, newId, 'need', { needId: n.id });
          logEvent(h, newId, 'request', { needId: n.id, hint: row.hint });
        });
        saveNeed(h, Object.assign({}, n, { computedAt: h.now() }));
        h.render(); h.toast(d.rows.length + '건 구매 요청 — 승인 대기에 올랐습니다');
        return;
      }

      /* 승인·반려 */
      case 'lg-approve': {
        if (needAdmin()) return;
        const all = assets(h);
        const list = all.filter(a => a.status === 'requested' && (a.links.needId || '') === id);
        if (!list.length) return;
        const dups = list.filter(a => c.isDuplicate(a, all));
        /* 같은 카탈로그 키가 이미 있으면 승인을 2단계 확인으로 바꾼다(B.4). */
        if (dups.length && !ask('이미 보유한 자료와 같은 것이 ' + dups.length + '건 있습니다: ' + dups.map(a => a.id).join(', ') + '\n그래도 승인할까요?')) return;
        approveModal(h, id, list);
        return;
      }
      case 'lg-approve-go': {
        if (needAdmin()) return;
        const all = assets(h);
        const list = all.filter(a => a.status === 'requested' && (a.links.needId || '') === id);
        if (!list.length) { h.closeModal(); return; }
        const staffId = val(h, 'lg-m-staff');
        const staff = staffId ? h.staffById(staffId) : null;
        const n = needById(h, id);
        const approved = list.map(a => apply(h, a, 'approve', { needId: id }));
        if (!staff) { h.closeModal(); h.render(); h.toast(approved.length + '건 승인 (지시서 없음)'); return; }
        const buy = officialLink('exam4you');
        const sheet = c.purchaseAssignments(approved, n, staff.name, h.today(), buy ? { buyUrl: buy.url, linkKey: 'exam4you' } : {});
        /* applyAssignments 가 모달을 닫고 다시 그린다. preConfirmed=true — 직원은 이미 명단에서 골랐다. */
        h.applyAssignments(sheet, true);
        return;
      }
      case 'lg-reject': if (needAdmin()) return; if (asset()) rejectModal(h, id); return;
      case 'lg-reject-go': {
        if (needAdmin()) return;
        const a = asset();
        if (!a) { h.closeModal(); return; }
        apply(h, a, 'reject', { note: readNote(h, 'lg-m-note') });
        h.closeModal(); h.render(); h.toast(a.id + ' 반려');
        return;
      }
      case 'lg-rerequest': {
        if (needAdmin()) return;
        const a = asset();
        if (!a) return;
        apply(h, a, 'request', { needId: a.links.needId, hint: a.cost.hint });
        h.render(); h.toast(a.id + ' 다시 요청 — 승인 대기');
        return;
      }

      /* [등록] = purchase + register */
      case 'lg-register': if (needAdmin()) return; if (asset()) registerModal(h, asset()); return;
      case 'lg-register-go': {
        if (needAdmin()) return;
        const a = asset();
        if (!a) { h.closeModal(); return; }
        const url = val(h, 'lg-m-url');
        if (url && !/^https:\/\//.test(url)) { h.toast('보기 URL 은 https:// 로 시작해야 합니다'); return; }
        const amount = Number(String(val(h, 'lg-m-amount')).replace(/[^\d]/g, ''));
        if (!Number.isFinite(amount) || amount < 0) { h.toast('실결제액을 숫자로 적어 주세요'); return; }
        const drivePath = val(h, 'lg-m-path') || c.intakePath(a);
        const paidAt = /^\d{4}-\d{2}-\d{2}$/.test(val(h, 'lg-m-paid')) ? val(h, 'lg-m-paid') : h.today();
        const note = readNote(h, 'lg-m-note');
        const afterBuy = apply(h, a, 'purchase', { amount: amount, hint: a.cost.hint, paidAt: paidAt },
          { cost: { amount: amount, hint: a.cost.hint, paidAt: paidAt }, note: note });
        const packId = c.packIdFromPath(drivePath) || c.packIdOf(a);
        apply(h, afterBuy, 'register', { drivePath: drivePath, viewUrl: url, packId: packId, note: note },
          { storage: { driveFileId: a.storage.driveFileId, drivePath: drivePath, viewUrl: url }, links: { needId: a.links.needId, packId: packId } });
        const diff = c.priceDiff(a.cost.hint, amount);
        h.closeModal(); h.render();
        h.toast(a.id + ' 등록' + (diff.warn ? ' · 예상 단가와 ' + fmtWon(Math.abs(diff.diff)) + ' 차이' : ''));
        return;
      }

      /* 배정·제공·확인 */
      case 'lg-packok': {
        if (needAdmin()) return;
        const a = asset();
        if (!a) return;
        apply(h, a, 'assign', { channel: 'pack', scope: 'exam', needId: a.links.needId, packId: a.links.packId }, { packConfirmedAt: h.now() });
        h.render(); h.toast(a.id + ' 팩 배포 확인');
        return;
      }
      case 'lg-provide': if (needAdmin()) return; if (asset()) provideModal(h, asset()); return;
      case 'lg-provide-go': {
        if (needAdmin()) return;
        const a = asset();
        if (!a) { h.closeModal(); return; }
        const kind = val(h, 'lg-m-kind');
        const note = readNote(h, 'lg-m-note');
        if (kind === 'assign-pack') apply(h, a, 'assign', { channel: 'pack', scope: 'exam', needId: a.links.needId, note: note }, { packConfirmedAt: a.packConfirmedAt || h.now() });
        else if (kind === 'assign-print') {
          const copies = Number(String(val(h, 'lg-m-copies')).replace(/[^\d]/g, '')) || 0;
          if (!copies) { h.toast('인쇄 부수를 적어 주세요'); return; }
          apply(h, a, 'assign', { channel: 'print', scope: 'exam', needId: a.links.needId, copies: copies, note: note });
        } else if (kind === 'provide-staff') {
          const staffId = val(h, 'lg-m-staff');
          if (!staffId) { h.toast('받는 강사를 골라 주세요'); return; }
          apply(h, a, 'provide', { to: 'staff', staffId: staffId, channel: 'link', note: note });
        } else apply(h, a, 'provide', { to: 'exam', scope: 'exam', needId: a.links.needId, note: note });
        h.closeModal(); h.render(); h.toast(a.id + ' 기록했습니다');
        return;
      }
      case 'lg-audit': {
        if (needAdmin()) return;
        const a = asset();
        if (!a) return;
        logEvent(h, a.id, 'audit', { drivePath: a.storage.drivePath });
        h.render(); h.toast(a.id + ' 경로 확인 기록');
        return;
      }
      case 'lg-revoke': {
        if (needAdmin()) return;
        const a = asset();
        if (!a || !ask(a.id + ' 를 회수 처리할까요? 되돌리려면 새 요청이 필요합니다.')) return;
        apply(h, a, 'revoke', { needId: a.links.needId });
        h.render(); h.toast(a.id + ' 회수');
        return;
      }

      /* 막힘 */
      case 'lg-block': if (needAdmin()) return; if (asset()) blockModal(h, asset()); return;
      case 'lg-block-go': {
        if (needAdmin()) return;
        const a = asset();
        if (!a) { h.closeModal(); return; }
        const reason = val(h, 'lg-m-reason') || 'other';
        apply(h, a, 'blocked', { reason: reason, note: readNote(h, 'lg-m-note') }, { blockReason: reason, blockedAt: h.now() });
        h.closeModal(); h.render(); h.toast(a.id + ' 막힘 기록');
        return;
      }
      case 'lg-unblock': {
        if (needAdmin()) return;
        const a = asset();
        if (!a) return;
        apply(h, a, 'unblocked', { reason: a.blockReason }, { blockReason: '', blockedAt: 0 });
        h.render(); h.toast(a.id + ' 막힘 해제');
        return;
      }

      /* 삭제는 표시만 — 키를 지우면 델타 동기화로 되살아난다(README 7-5). */
      case 'lg-del': {
        if (needAdmin()) return;
        const a = asset();
        if (!a || !ask(a.id + ' 를 카탈로그에서 지울까요? 이벤트 이력은 남습니다.')) return;
        logEvent(h, a.id, 'correct', { deleted: true });
        saveAsset(h, Object.assign({}, a, { deleted: true }));
        if (openId === id) openId = '';
        h.render(); h.toast(a.id + ' 지움 표시');
        return;
      }
      default: return;
    }
  }

  function onClick(ev) {
    const el = ev.target && ev.target.closest ? ev.target.closest('[data-act^="lg-"]') : null;
    if (!el) return;
    if (typeof sync !== 'undefined' && sync && sync.recovering) return;
    const h = host();
    if (!h || !core()) return;
    try {
      handle(h, el.dataset.act, el.dataset.id || '', el);
    } catch (e) {
      if (root.console) root.console.warn('ledger', e);
      h.toast('자산 원장 오류: ' + (e && e.message ? e.message : e));
    }
  }
  /* 폼 값은 draft 에 즉시 반영한다 — 동기화가 도착해 다시 그려도 입력이 남는다. */
  function onInput(ev) {
    const t = ev.target;
    if (!t || !t.dataset) return;
    if (t.dataset.lgField && draft) { draft[t.dataset.lgField] = String(t.value || ''); return; }
    if (t.dataset.lgSearch) {
      query = String(t.value || '').trim();
      const h = host();
      const list = h && h.$('#lg-catalog-list');
      if (list) list.innerHTML = catalogList(h, assets(h), canWrite(h));
    }
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onInput);
  }

  return { view: view, alertCount: alertCount };
});
