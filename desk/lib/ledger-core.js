(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBLedgerCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  /* 자산 원장(제안 B, Phase 0). 이그잼포유 자료(material) 하나만 다룬다.
     저장은 checks 테이블에 얹는다 — 기기 대장(__asset__)과 같은 수법이라 백엔드를 건드리지 않는다.
       상태 행   '__lic__<assetId>|all'    현재 상태. LWW 로 덮여도 되는 값만 둔다.
       이벤트 행 '__licev__<eventId>|all'  쓴 뒤 불변. 늘 새 키라 LWW 가 이벤트를 덮지 못한다.
       시험 범위 '__licneed__<needId>|all' 학교↔교과서↔학년↔과 매핑의 정본.
     전용 테이블로 옮길 때(Phase 1 D1)를 위해 키 조립·해체를 여기 한곳에 모아 둔다. */
  const LEDGER_PREFIX = '__lic__';
  const EVENT_PREFIX = '__licev__';
  const NEED_PREFIX = '__licneed__';
  const SUFFIX = '|all';

  /* ── 코드표 ──────────────────────────────────────────
     naesin/README.md "원천 자료 인테이크" 절의 표를 그대로 옮긴 것이다.
     드라이브 폴더 이름(label) 과 packId 조각(code) 이 여기서 나오므로, 표가 바뀌면 여기만 고친다. */
  const CURRICULUM = '2022';
  const SOURCE = 'examforyou';

  const TEXTBOOKS = {
    'ne-kimgitaek': { code: 'ne-kimgitaek', label: 'NE능률(김기택)' },
    'ybm-kimeunhyeong': { code: 'ybm-kimeunhyeong', label: 'YBM(김은형)' },
    'ybm-parkjuneon': { code: 'ybm-parkjuneon', label: 'YBM(박준언)' },
    'donga-yunjeongmi': { code: 'donga-yunjeongmi', label: '동아(윤정미)' },
    'donga-leebyeongmin': { code: 'donga-leebyeongmin', label: '동아(이병민)' },
    'visang-hwangjongbae': { code: 'visang-hwangjongbae', label: '비상(황종배)' },
    'jihak-songmijeong': { code: 'jihak-songmijeong', label: '지학사(송미정)' },
    'chunjae-soyeongsun': { code: 'chunjae-soyeongsun', label: '천재(소영순)' },
    'chunjae-leesanggi': { code: 'chunjae-leesanggi', label: '천재(이상기)' },
    'mirae-munyeongin': { code: 'mirae-munyeongin', label: '미래엔(문영인)' }
  };

  const GRADES = { m1: '중1', m2: '중2', m3: '중3' };

  /* 이그잼포유 시리즈 번호. 파일 앞 두 자리가 곧 계약이라(README) 번호를 키로 쓴다.
     file 은 드라이브 파일명의 번호 뒤 이름 — README 트리에 있는 것은 그대로,
     트리에 없는 05·06·09 는 표의 자료명에서 같은 꼴로 만들었다(가정).
     required: 팩이 나오려면 있어야 하는 것(02·03). teacher: 정답이 걸려 교사용을 함께 사는 편이 나은 것(04~06). */
  const SERIES = {
    '00': { no: '00', name: '교과서본문', file: '00_교과서본문', packField: 'sentences[].en 정본 대조', required: false, teacher: false },
    '01': { no: '01', name: '내용정리 플러스', file: '01_내용정리', packField: 'dialogues · sentences.chunks · keyExpressions', required: false, teacher: false },
    '02': { no: '02', name: '본문 10단계 워크북', file: '02_본문워크북', packField: 'sentences(정본) · keywords · tokens · verbForms · grammarChoices · oddOneItems · checkItems', required: true, teacher: false },
    '03': { no: '03', name: 'WORD TEST', file: '03_단어시험', packField: 'words', required: true, teacher: false },
    '04': { no: '04', name: '예상문제 PRE-STEP', file: '04_예상문제_PRE-STEP', packField: 'items', required: false, teacher: true },
    '05': { no: '05', name: '예상문제 1회', file: '05_예상문제_1회', packField: 'items', required: false, teacher: true },
    '06': { no: '06', name: '예상문제 2회', file: '06_예상문제_2회', packField: 'items', required: false, teacher: true },
    '07': { no: '07', name: 'Grammar Build Up 워크북', file: '07_문법워크북', packField: 'patterns', required: false, teacher: false },
    '08': { no: '08', name: 'Grammar Build Up 객관식', file: '08_문법객관식', packField: 'items', required: false, teacher: false },
    '09': { no: '09', name: 'Grammar Build Up 주관식', file: '09_문법주관식', packField: 'items', required: false, teacher: false }
  };
  const SERIES_CODES = Object.keys(SERIES);
  const REQUIRED_SERIES = SERIES_CODES.filter(k => SERIES[k].required);          // ['02','03']
  const TEACHER_SERIES = SERIES_CODES.filter(k => SERIES[k].teacher);            // ['04','05','06']

  /* 시리즈별 예상 단가(원). 브리프의 "파일마다 5~6.5천원, 과 하나 통째로 5만원대" 범위 안에서
     자체 추정한 값이라 커밋해도 된다(가정). 실결제액과의 차이는 priceDiff 로 잡는다.
     교사용은 학생용과 같은 값으로 둔다(가정 — 실결제로 갱신). */
  const PRICE_HINTS = {
    '00': 3000, '01': 5500, '02': 6500, '03': 5000, '04': 5500,
    '05': 5500, '06': 5500, '07': 6000, '08': 5500, '09': 5500
  };
  /* 예상 단가와 실결제액이 이 비율 이상 어긋나면 경고한다(가정). */
  const PRICE_WARN_PCT = 0.2;

  const EDITIONS = { student: '학생용', teacher: '교사용' };

  /* 인테이크 드라이브 루트(README). 팩 하나 = 과 폴더 하나. */
  const DRIVE_ROOT = 'WB 교재스캔/내신브레인_영어';

  const EXAM_TERMS = [
    { key: '1-mid', label: '1학기 중간' },
    { key: '1-final', label: '1학기 기말' },
    { key: '2-mid', label: '2학기 중간' },
    { key: '2-final', label: '2학기 기말' }
  ];

  /* ── 상태·이벤트 ─────────────────────────────────────
     material 기준 전이표(B.2). [등록] 한 번이 purchase+register 두 이벤트를 찍는다 —
     외부 결제와 드라이브 업로드가 한 자리에서 일어나므로 클릭을 둘로 나누지 않는다. */
  const STATUS = ['needed', 'requested', 'approved', 'purchased', 'registered', 'assigned', 'provided', 'revoked', 'rejected'];
  const STATUS_LABELS = {
    needed: '필요', requested: '승인 대기', approved: '승인됨', purchased: '구매', registered: '등록됨',
    assigned: '배정', provided: '제공', revoked: '회수', rejected: '반려'
  };
  /* 보유 판정에 쓰는 순서. purchased 이상이면 "있는 자료"다. rejected 는 순서 밖(-1). */
  const STATUS_RANK = { needed: 0, requested: 1, approved: 2, purchased: 3, registered: 4, assigned: 5, provided: 6, revoked: 7, rejected: -1 };
  const TRANSITIONS = {
    needed: ['requested'],
    requested: ['approved', 'rejected'],
    approved: ['purchased'],
    purchased: ['registered'],
    registered: ['assigned', 'provided'],
    assigned: ['provided', 'revoked'],
    provided: ['revoked'],
    revoked: [],
    rejected: ['requested']   // 반려된 뒤 사정이 바뀌면 다시 요청할 수 있다
  };

  const EVENT_TYPES = ['need', 'request', 'approve', 'reject', 'purchase', 'register', 'assign', 'provide', 'revoke', 'blocked', 'unblocked', 'correct', 'audit'];
  const EVENT_LABELS = {
    need: '필요 산출', request: '구매 요청', approve: '승인', reject: '반려', purchase: '구매', register: '등록',
    assign: '배정', provide: '제공', revoke: '회수', blocked: '막힘', unblocked: '막힘 해제', correct: '정정', audit: '경로 확인'
  };
  /* 이벤트가 상태를 어디로 옮기는지. 표에 없는 이벤트(blocked·audit…)는 상태를 건드리지 않는다. */
  const EVENT_TARGET = {
    request: 'requested', approve: 'approved', reject: 'rejected', purchase: 'purchased',
    register: 'registered', assign: 'assigned', provide: 'provided', revoke: 'revoked'
  };
  const BLOCK_REASONS = {
    not_published: '미출간', payment: '결제 한도·수단', drive_access: '드라이브 권한', other: '기타'
  };
  const CHANNELS = { pack: '내신브레인 팩', print: '인쇄', link: '강사 링크 전달' };

  const NOTE_MAX = 300;
  const ASSET_ID_RE = /^MAT-\d{4,}$/;
  const NEED_ID_RE = /^NEED-\d{4,}$/;
  const SCHOOL_RE = /^SCH-\d{2,3}$/;
  const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
  const UNIT_MIN = 1, UNIT_MAX = 10;

  function str(v) { return v == null ? '' : String(v).trim(); }
  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function pad4(n) { return String(n).padStart(4, '0'); }
  function clipNote(v) { return str(v).slice(0, NOTE_MAX); }
  function uniq(list) { return list.filter((x, i) => list.indexOf(x) === i); }

  /* ── 저장 키 ── */
  function ledgerKey(assetId) { return LEDGER_PREFIX + str(assetId); }
  function eventKey(eventId) { return EVENT_PREFIX + str(eventId); }
  function needKey(needId) { return NEED_PREFIX + str(needId); }
  /* setCheck(taskId, 'all') 가 만드는 전체 키. 화면이 state.checks 를 직접 읽을 때 쓴다. */
  function fullKey(taskId) { return str(taskId) + SUFFIX; }

  function head(key) { return str(key).split('|')[0]; }
  /* 세 접두 중 하나면 원장 행. '|all' 이 붙은 전체 키와 taskId 조각 둘 다 받는다 —
     ownerOfCheck 는 전체 키를, 화면 코드는 조각을 넘기기 때문이다. */
  function kindOfKey(key) {
    const h = head(key);
    if (h.startsWith(EVENT_PREFIX)) return 'event';
    if (h.startsWith(NEED_PREFIX)) return 'need';
    if (h.startsWith(LEDGER_PREFIX)) return 'asset';
    return '';
  }
  function isLedgerKey(key) { return kindOfKey(key) !== ''; }
  function idFromKey(key, prefix) {
    const h = head(key);
    return h.startsWith(prefix) ? h.slice(prefix.length) : '';
  }
  function assetIdFromKey(key) { return kindOfKey(key) === 'asset' ? idFromKey(key, LEDGER_PREFIX) : ''; }
  function eventIdFromKey(key) { return kindOfKey(key) === 'event' ? idFromKey(key, EVENT_PREFIX) : ''; }
  function needIdFromKey(key) { return kindOfKey(key) === 'need' ? idFromKey(key, NEED_PREFIX) : ''; }

  /* ── 표시 ── */
  function textbookLabel(code) { const t = TEXTBOOKS[str(code)]; return t ? t.label : ''; }
  function gradeLabel(grade) { return GRADES[str(grade)] || ''; }
  function unitLabel(unit) { const u = num(unit); return u ? 'L' + pad2(u) : ''; }
  function seriesName(series) { const s = SERIES[str(series)]; return s ? s.name : ''; }
  function editionLabel(edition) { return EDITIONS[str(edition)] || ''; }
  function fmtWon(n) { return num(n).toLocaleString('ko-KR') + '원'; }

  /* 시리즈 하나의 드라이브 파일명. 앞 두 자리 번호 + 이름, 교사용은 '_교사용' 접미(README 계약). */
  function fileName(series, edition) {
    const s = SERIES[str(series)];
    if (!s) return '';
    return s.file + (str(edition) === 'teacher' ? '_교사용' : '') + '.pdf';
  }

  /* ── 자산 ── */
  function normalizeCatalog(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const series = str(c.series);
    return {
      textbookCode: str(c.textbookCode),
      grade: str(c.grade),
      unit: num(c.unit) > 0 ? Math.floor(num(c.unit)) : 0,
      series: /^\d$/.test(series) ? '0' + series : series,
      edition: str(c.edition) === 'teacher' ? 'teacher' : 'student'
    };
  }

  function normalizeAsset(raw) {
    const a = raw && typeof raw === 'object' ? raw : {};
    const catalog = normalizeCatalog(a.catalog);
    const cost = a.cost && typeof a.cost === 'object' ? a.cost : {};
    const storage = a.storage && typeof a.storage === 'object' ? a.storage : {};
    const license = a.license && typeof a.license === 'object' ? a.license : {};
    const links = a.links && typeof a.links === 'object' ? a.links : {};
    const status = STATUS.includes(str(a.status)) ? str(a.status) : 'needed';
    return {
      id: str(a.id),
      kind: 'material',
      source: SOURCE,
      status: status,
      catalog: catalog,
      cost: {
        amount: num(cost.amount),
        hint: cost.hint == null ? priceHint(catalog.series, catalog.edition) : num(cost.hint),
        paidAt: YMD_RE.test(str(cost.paidAt)) ? str(cost.paidAt) : ''
      },
      storage: {
        driveFileId: str(storage.driveFileId),
        drivePath: str(storage.drivePath),
        viewUrl: str(storage.viewUrl)
      },
      /* 라이선스 기본값(가정: 원내 재원생 학습 목적 허용, 재배포 금지). 서면 확인 뒤 값만 바꾼다. */
      license: {
        scope: str(license.scope) || 'enrolled_only',
        redistribution: license.redistribution === true
      },
      links: { packId: str(links.packId), needId: str(links.needId) },
      packConfirmedAt: num(a.packConfirmedAt),
      blockReason: BLOCK_REASONS[str(a.blockReason)] ? str(a.blockReason) : '',
      blockedAt: num(a.blockedAt),
      note: clipNote(a.note),
      deleted: a.deleted === true,
      revision: num(a.revision),
      createdAt: num(a.createdAt),
      updatedAt: num(a.updatedAt)
    };
  }

  function priceHint(series, edition) {
    const v = PRICE_HINTS[str(series)];
    return v == null ? 0 : v;   // 교사용도 같은 값(가정)
  }

  /* 카탈로그 키 — 중복 판정·필요 대조는 전부 이 키로 한다.
     자산(catalog 를 가진 것)도, 맨 catalog 객체도 받는다. */
  function catalogKey(assetOrCatalog) {
    const src = assetOrCatalog && typeof assetOrCatalog === 'object' ? assetOrCatalog : {};
    const c = normalizeCatalog(src.catalog && typeof src.catalog === 'object' ? src.catalog : src);
    if (!c.textbookCode || !c.grade || !c.unit || !c.series) return '';
    return [SOURCE, c.textbookCode, c.grade, c.unit, c.series, c.edition].join('|');
  }

  /* 사람이 읽는 카탈로그 라벨: '03_단어시험 · NE능률(김기택) 중2 L05 · 교사용' */
  function catalogLabel(asset) {
    const c = normalizeCatalog(asset && asset.catalog ? asset.catalog : asset);
    const parts = [];
    const s = SERIES[c.series];
    if (s) parts.push(s.file);
    const place = [textbookLabel(c.textbookCode), gradeLabel(c.grade), unitLabel(c.unit)].filter(Boolean).join(' ');
    if (place) parts.push(place);
    if (c.edition === 'teacher') parts.push('교사용');
    return parts.join(' · ');
  }

  function rankOf(status) { const r = STATUS_RANK[str(status)]; return r == null ? -1 : r; }
  function isOwned(asset) { return rankOf(asset && asset.status) >= STATUS_RANK.purchased; }
  function isPending(asset) { const r = rankOf(asset && asset.status); return r >= 0 && r < STATUS_RANK.purchased; }

  /* 같은 카탈로그 키가 이미 purchased 이상으로 있으면 중복. 승인 화면에서 2단계 확인으로 바꾸는 근거다. */
  function duplicatesOf(asset, assets) {
    const key = catalogKey(asset);
    const id = str(asset && asset.id);
    if (!key) return [];
    return (assets || []).map(normalizeAsset)
      .filter(o => !o.deleted && o.id !== id && catalogKey(o) === key && isOwned(o));
  }
  function isDuplicate(asset, assets) { return duplicatesOf(asset, assets).length > 0; }

  /* 다음 자산 번호. 빈자리를 재사용하지 않고 뒤에 붙인다(지시서·이벤트가 번호를 가리키므로). */
  function nextAssetId(assets) {
    let max = 0;
    (assets || []).forEach(a => {
      const id = str(a && a.id);
      const m = id.match(/^MAT-(\d+)$/);
      if (m && Number(m[1]) > max) max = Number(m[1]);
    });
    return 'MAT-' + pad4(max + 1);
  }
  function nextNeedId(needs) {
    let max = 0;
    (needs || []).forEach(n => {
      const id = str(n && n.id);
      const m = id.match(/^NEED-(\d+)$/);
      if (m && Number(m[1]) > max) max = Number(m[1]);
    });
    return 'NEED-' + pad4(max + 1);
  }

  /* ── 인테이크 경로 · packId ──
     "드라이브 폴더 경로가 곧 packId" 라는 내신브레인 계약을 그대로 쓴다.
     사람이 며칠 뒤 다시 와서 적는 칸을 없애는 것이 이 두 함수의 목적이다. */
  function intakeFolder(assetOrCatalog) {
    const src = assetOrCatalog && typeof assetOrCatalog === 'object' ? assetOrCatalog : {};
    const c = normalizeCatalog(src.catalog && typeof src.catalog === 'object' ? src.catalog : src);
    const tb = textbookLabel(c.textbookCode);
    const gr = gradeLabel(c.grade);
    const un = unitLabel(c.unit);
    if (!tb || !gr || !un) return '';
    return [DRIVE_ROOT, tb, gr, un].join('/');
  }
  function intakePath(asset) {
    const folder = intakeFolder(asset);
    const c = normalizeCatalog(asset && asset.catalog ? asset.catalog : asset);
    const file = fileName(c.series, c.edition);
    return folder && file ? folder + '/' + file : '';
  }

  /* 경로에서 packId. 교과서 폴더는 표시명(NE능률(김기택))이든 코드(ne-kimgitaek)든 받는다.
     학년 '중2' → m2, 과 'L06' → L6. 조각 하나라도 못 읽으면 '' — 추측해서 만들지 않는다. */
  function packIdFromPath(path, revision) {
    const segs = str(path).replace(/\\/g, '/').split('/').map(s => s.trim()).filter(Boolean);
    let code = '', grade = '', unit = 0;
    segs.forEach(seg => {
      if (!code) {
        const byLabel = Object.keys(TEXTBOOKS).find(k => TEXTBOOKS[k].label === seg);
        if (byLabel) { code = byLabel; return; }
        if (TEXTBOOKS[seg]) { code = seg; return; }
      }
      if (code && !grade) {
        const g = seg.match(/^중([123])$/) || seg.match(/^(m[123])$/);
        if (g) { grade = g[1].length === 1 ? 'm' + g[1] : g[1]; return; }
      }
      if (code && grade && !unit) {
        const u = seg.match(/^L(\d{1,2})$/i);
        if (u) { unit = Number(u[1]); }
      }
    });
    if (!code || !grade || !unit) return '';
    return [str(revision) || CURRICULUM, code, grade, 'L' + unit].join('-');
  }
  function packIdOf(asset, revision) {
    const a = asset || {};
    const fromPath = packIdFromPath(a.storage && a.storage.drivePath, revision);
    if (fromPath) return fromPath;
    const c = normalizeCatalog(a.catalog);
    if (!TEXTBOOKS[c.textbookCode] || !GRADES[c.grade] || !c.unit) return '';
    return [str(revision) || CURRICULUM, c.textbookCode, c.grade, 'L' + c.unit].join('-');
  }

  /* ── 전이 ── */
  function canTransition(from, to) {
    const list = TRANSITIONS[str(from)];
    return !!list && list.includes(str(to));
  }
  /* 이벤트를 찍은 뒤의 상태. 전이표 밖이면 상태를 그대로 둔다 —
     이미 제공된 자료에 배정 이벤트를 하나 더 남기는 것은 정상이지 후퇴가 아니다. */
  function statusAfter(status, eventType) {
    const target = EVENT_TARGET[str(eventType)];
    if (!target) return str(status);
    return canTransition(status, target) ? target : str(status);
  }

  /* ── 시험 범위(need_sets) ── */
  function normalizeUnits(list) {
    const arr = Array.isArray(list) ? list : str(list).split(/[,\s·]+/);
    return uniq(arr.map(v => Math.floor(num(v))).filter(u => u >= UNIT_MIN && u <= UNIT_MAX)).sort((a, b) => a - b);
  }
  function normalizeSeries(list, fallback) {
    const arr = Array.isArray(list) ? list.map(str) : (list == null ? fallback.slice() : str(list).split(/[,\s]+/));
    return uniq(arr.map(s => (/^\d$/.test(s) ? '0' + s : s)).filter(s => SERIES[s])).sort();
  }

  function normalizeNeed(raw) {
    const n = raw && typeof raw === 'object' ? raw : {};
    const ref = n.examRef && typeof n.examRef === 'object' ? n.examRef : {};
    return {
      id: str(n.id),
      schoolCode: str(n.schoolCode).toUpperCase(),
      grade: str(n.grade),
      subject: str(n.subject) || '영어',
      textbookCode: str(n.textbookCode),
      units: normalizeUnits(n.units),
      examTerm: EXAM_TERMS.some(t => t.key === str(n.examTerm)) ? str(n.examTerm) : '',
      /* 시험일 정본은 consult academic_event 다. Phase 0 은 examDateCopy 수동 복사를 한시 허용한다. */
      examRef: {
        eventId: str(ref.eventId),
        examDateCopy: YMD_RE.test(str(ref.examDateCopy)) ? str(ref.examDateCopy) : (YMD_RE.test(str(n.examDateCopy)) ? str(n.examDateCopy) : '')
      },
      /* 02·03 은 빠질 수 없다 — 학생 앱이 words·sentences 를 전제로 그리기 때문(README). */
      requiredSeries: uniq(REQUIRED_SERIES.concat(normalizeSeries(n.requiredSeries, REQUIRED_SERIES))).sort(),
      teacherSeries: normalizeSeries(n.teacherSeries, TEACHER_SERIES),
      naesinScope: str(n.naesinScope),
      computedAt: num(n.computedAt),
      deleted: n.deleted === true,
      createdAt: num(n.createdAt),
      updatedAt: num(n.updatedAt)
    };
  }

  /* 입력 검증. 학교명이 아니라 코드만 받는 것이 개인정보 경계다(학교명은 D1 매핑표에만). */
  function validateNeed(input) {
    const raw = input && typeof input === 'object' ? input : {};
    const errors = [];
    const need = normalizeNeed(raw);
    if (!SCHOOL_RE.test(need.schoolCode)) errors.push('학교 코드는 SCH-07 처럼 적습니다 (학교 이름은 넣지 않습니다)');
    if (!GRADES[need.grade]) errors.push('학년은 중1·중2·중3 중 하나입니다');
    if (!TEXTBOOKS[need.textbookCode]) errors.push('교과서를 10종 목록에서 고릅니다');
    if (!need.units.length) errors.push('과(1~10)를 하나 이상 고릅니다');
    else {
      const bad = (Array.isArray(raw.units) ? raw.units : []).map(num).filter(u => !(u >= UNIT_MIN && u <= UNIT_MAX) || u !== Math.floor(u));
      if (bad.length) errors.push('과는 1~10 사이 정수만 됩니다');
    }
    if (!need.examRef.examDateCopy) errors.push('시험일을 YYYY-MM-DD 로 적습니다 (consult 시험 일정의 값을 그대로 복사)');
    if (need.subject !== '영어') errors.push('Phase 0 은 영어만 다룹니다');
    return { ok: errors.length === 0, errors: errors, need: need };
  }

  /* 시험일. 참조값(consult academic_event)이 있으면 그것, 없으면 Phase 0 수동 복사본. */
  function examDateOf(needSet, consultEvents) {
    const n = normalizeNeed(needSet);
    if (n.examRef.eventId && Array.isArray(consultEvents)) {
      const ev = consultEvents.find(e => e && str(e.id) === n.examRef.eventId);
      if (ev && YMD_RE.test(str(ev.examDate))) return str(ev.examDate);
    }
    return n.examRef.examDateCopy;
  }

  function needLabel(needSet) {
    const n = normalizeNeed(needSet);
    return [n.schoolCode, gradeLabel(n.grade), textbookLabel(n.textbookCode), n.units.map(unitLabel).join('·')]
      .filter(Boolean).join(' · ');
  }

  /* 필요 자료 산출 = 시험 범위 × (필수 학생용 + 교사용 권장) − 보유.
     보유(purchased 이상)는 뺀다. 진행 중(needed~approved)은 사야 할 목록에서 빼되 따로 센다 —
     두 번 요청되는 것을 막으면서도 "왜 12개 중 4개만 뜨나"를 화면이 설명할 수 있어야 한다.
     반려(rejected)·없음 은 다시 사야 할 목록에 들어간다. */
  function deriveNeeds(needSet, ownedAssets) {
    const n = normalizeNeed(needSet);
    const pool = (ownedAssets || []).map(normalizeAsset).filter(a => !a.deleted);
    const byKey = {};
    pool.forEach(a => {
      const k = catalogKey(a);
      if (!k) return;
      /* 같은 키가 여럿이면 가장 앞선 상태로 본다. */
      if (!byKey[k] || rankOf(a.status) > rankOf(byKey[k].status)) byKey[k] = a;
    });

    const rows = [];
    let owned = 0, pending = 0, needed = 0, estimate = 0;
    const push = (unit, series, edition, tier) => {
      const catalog = { textbookCode: n.textbookCode, grade: n.grade, unit: unit, series: series, edition: edition };
      const key = catalogKey(catalog);
      if (!key) return;
      needed++;
      const have = byKey[key];
      if (have && isOwned(have)) { owned++; return; }
      if (have && isPending(have)) { pending++; return; }
      const hint = priceHint(series, edition);
      estimate += hint;
      rows.push({
        catalogKey: key,
        catalog: catalog,
        unit: unit, series: series, edition: edition,
        name: SERIES[series].name,
        fileName: fileName(series, edition),
        hint: hint,
        tier: tier,
        why: tier === 'required' ? '팩 필수 (words·sentences)' : '정답·해설 — 교사용을 같이 사는 편이 낫다'
      });
    };
    n.units.forEach(unit => {
      n.requiredSeries.forEach(s => push(unit, s, 'student', SERIES[s].required ? 'required' : 'optional'));
      n.teacherSeries.forEach(s => push(unit, s, 'teacher', 'recommended'));
    });
    return { rows: rows, needed: needed, owned: owned, pending: pending, toBuy: rows.length, estimate: estimate };
  }

  /* 산출 행을 자산 행으로. 요청과 동시에 만들어지므로 needed 를 거치지 않고 requested 로 시작한다
     (needed 상태는 산출 화면에만 존재하고 저장되지 않는다 — 저장하면 원장이 산출 결과로 부풀어 오른다). */
  function assetFromNeedRow(row, needId, id, at) {
    return normalizeAsset({
      id: id,
      status: 'requested',
      catalog: row.catalog,
      cost: { amount: 0, hint: row.hint, paidAt: '' },
      links: { needId: str(needId), packId: '' },
      createdAt: num(at),
      updatedAt: num(at)
    });
  }

  /* ── 날짜 ── */
  function daysBetween(fromYmd, toYmd) {
    if (!YMD_RE.test(str(fromYmd)) || !YMD_RE.test(str(toYmd))) return null;
    const a = str(fromYmd).split('-').map(Number), b = str(toYmd).split('-').map(Number);
    const ms = Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2]);
    return Math.round(ms / 86400000);
  }

  /* 산 채로 잠자는 자료: 시험일 D-7 안인데 registered 에서 멈춘 것(팩 배포·배정 없음).
     시험이 지난 것은 뺀다 — 이제 와서 팩을 만들 일이 아니라 다음 시즌 카탈로그 문제다. */
  function sleeping(assets, needSets, today, consultEvents) {
    const needs = {};
    (needSets || []).map(normalizeNeed).forEach(n => { if (n.id) needs[n.id] = n; });
    const out = [];
    (assets || []).map(normalizeAsset).forEach(a => {
      if (a.deleted || a.status !== 'registered') return;
      const n = needs[a.links.needId];
      if (!n) return;
      const examDate = examDateOf(n, consultEvents);
      const d = daysBetween(today, examDate);
      if (d == null || d < 0 || d > 7) return;
      out.push({ asset: a, need: n, examDate: examDate, daysLeft: d });
    });
    return out.sort((x, y) => x.daysLeft - y.daysLeft || x.asset.id.localeCompare(y.asset.id, 'en'));
  }

  /* ── 이벤트 ── */
  function newEvent(assetId, type, actor, payload, at) {
    const t = str(type);
    if (!EVENT_TYPES.includes(t)) throw new Error('알 수 없는 원장 이벤트: ' + t);
    const when = num(at) || Date.now();
    const p = Object.assign({}, payload && typeof payload === 'object' ? payload : {});
    const note = clipNote(p.note);
    delete p.note;
    if (p.reason != null && !BLOCK_REASONS[str(p.reason)]) p.reason = 'other';
    return {
      id: 'LE-' + when.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      assetId: str(assetId),
      type: t,
      at: when,
      byStaffId: str(actor) || 'admin',
      payload: p,
      note: note
    };
  }
  function normalizeEvent(raw) {
    const e = raw && typeof raw === 'object' ? raw : {};
    return {
      id: str(e.id),
      assetId: str(e.assetId),
      type: EVENT_TYPES.includes(str(e.type)) ? str(e.type) : '',
      at: num(e.at),
      byStaffId: str(e.byStaffId),
      payload: e.payload && typeof e.payload === 'object' ? e.payload : {},
      note: clipNote(e.note)
    };
  }

  /* 리드타임 approve→register. blocked~unblocked 구간은 시계를 멈춘다 —
     미출간·결제·드라이브 권한은 직원 밖 요인이라 개인 지표에 넣지 않는다. */
  function leadTime(events) {
    const list = (events || []).map(normalizeEvent).filter(e => e.at).sort((a, b) => a.at - b.at);
    const approve = list.find(e => e.type === 'approve');
    if (!approve) return null;
    const register = list.find(e => e.type === 'register' && e.at >= approve.at);
    if (!register) return null;
    let blockedMs = 0, openAt = null;
    list.forEach(e => {
      if (e.type === 'blocked' && openAt == null) openAt = e.at;
      if (e.type === 'unblocked' && openAt != null) {
        blockedMs += overlap(openAt, e.at, approve.at, register.at);
        openAt = null;
      }
    });
    if (openAt != null) blockedMs += overlap(openAt, register.at, approve.at, register.at);
    const ms = Math.max(0, register.at - approve.at - blockedMs);
    return { ms: ms, blockedMs: blockedMs, hours: Math.round(ms / 36e5 * 10) / 10 };
  }
  function overlap(a0, a1, b0, b1) {
    const s = Math.max(a0, b0), e = Math.min(a1, b1);
    return e > s ? e - s : 0;
  }

  function priceDiff(hint, actual) {
    const h = num(hint), a = num(actual);
    const diff = a - h;
    const pct = h > 0 ? diff / h : null;
    const warn = h > 0 ? Math.abs(pct) >= PRICE_WARN_PCT : a > 0;
    return { diff: diff, pct: pct, warn: warn };
  }

  /* 규율 위반(B.9): request 없이 purchase 가 찍힌 자산. 승인 전 결제는 앱이 막을 수 없어 사후에 잡는다. */
  function unrequestedPurchases(events) {
    const byAsset = {};
    (events || []).map(normalizeEvent).forEach(e => {
      if (!e.assetId) return;
      byAsset[e.assetId] = byAsset[e.assetId] || { request: false, purchase: false };
      if (e.type === 'request') byAsset[e.assetId].request = true;
      if (e.type === 'purchase') byAsset[e.assetId].purchase = true;
    });
    return Object.keys(byAsset).filter(id => byAsset[id].purchase && !byAsset[id].request).sort();
  }
  /* 중복 구매(B.9): 같은 카탈로그 키가 purchased 이상으로 둘 이상. */
  function duplicatePurchases(assets) {
    const groups = {};
    (assets || []).map(normalizeAsset).filter(a => !a.deleted && isOwned(a)).forEach(a => {
      const k = catalogKey(a);
      if (!k) return;
      (groups[k] = groups[k] || []).push(a.id);
    });
    return Object.keys(groups).filter(k => groups[k].length > 1).map(k => ({ catalogKey: k, ids: groups[k].sort() }));
  }

  function countByStatus(assets) {
    const out = {};
    STATUS.forEach(s => { out[s] = 0; });
    (assets || []).map(normalizeAsset).filter(a => !a.deleted).forEach(a => { out[a.status]++; });
    return out;
  }

  /* ── 업무지시서 연동 ──
     승인된 자산을 직원의 구매·인테이크 지시서로. applyAssignments 가 받는 스키마 그대로라
     검증 경로가 하나로 유지된다(기기 실사 지시서와 같은 수법).
     자산 여러 건을 한 장에 단계로 묶는다 — 하루 8건이면 지시서 8장보다 한 장에 체크 8번이 낫다.
     직원은 결제→이름 바꾸기→업로드를 자산마다 반복하므로 단계 = 자산 이 자연스럽고,
     🚧 막힘도 한 장에서 올린다. 너무 길어지면(perSheet) 끊는다. */
  function buyLink(opts) {
    if (opts && str(opts.buyUrl)) return { url: str(opts.buyUrl), key: str(opts.linkKey) || 'exam4you' };
    const ext = root && root.WBExternalLinks;
    const l = ext && typeof ext.linkFor === 'function' ? ext.linkFor('exam4you') : null;
    return l && str(l.url) ? { url: str(l.url), key: 'exam4you' } : { url: '', key: '' };
  }

  const PURCHASE_GUIDE = [
    '1) 이그잼포유 공식 사이트(새 창)에 로그인해 아래 자료를 결제·다운로드합니다 — 앱에서 승인된 건만 결제합니다',
    '2) 내려받은 파일 이름을 단계에 적힌 파일명으로 바꿉니다 (앞 두 자리 번호가 규칙, 교사용은 _교사용)',
    '3) 드라이브의 적힌 폴더에 올립니다 (폴더가 없으면 같은 규칙으로 만듭니다)',
    '4) 한 건 끝날 때마다 아래 단계를 체크합니다',
    '5) 미출간·결제 한도·드라이브 권한 문제는 🚧 막힘으로 올리고 사유만 적습니다 (학생 이름·학교명은 적지 않습니다)',
    '6) 전부 끝나면 관리 담당에게 알립니다 — 자산 탭의 [등록]은 관리 담당이 누릅니다'
  ].join('\n');

  function purchaseAssignments(assets, needSet, staffName, today, opts) {
    const o = opts || {};
    const staff = str(staffName);
    const list = (assets || []).map(normalizeAsset).filter(a => !a.deleted)
      .sort((a, b) => a.id.localeCompare(b.id, 'en'));
    if (!staff || !list.length) return { assignments: [] };
    const n = needSet ? normalizeNeed(needSet) : null;
    const link = buyLink(o);
    const perSheet = num(o.perSheet) > 0 ? num(o.perSheet) : 12;
    const examDate = n ? examDateOf(n, o.consultEvents) : '';
    const dLeft = daysBetween(today, examDate);
    const groups = [];
    for (let i = 0; i < list.length; i += perSheet) groups.push(list.slice(i, i + perSheet));

    const assignments = groups.map((group, gi) => {
      const first = group[0].id, last = group[group.length - 1].id;
      const total = group.reduce((s, a) => s + (a.cost.hint || 0), 0);
      const lines = [];
      if (n) lines.push(needLabel(n) + (examDate ? ' · 시험 ' + examDate + (dLeft != null ? ' (D-' + dLeft + ')' : '') : ''));
      lines.push('공식 구매: ' + (link.url || '(공식 링크 미설정 — 관리 담당에게 확인)') + ' — 앱에서 승인된 건만 결제');
      lines.push('드라이브 루트: ' + DRIVE_ROOT + '/');
      group.forEach(a => {
        lines.push(a.id + ' → ' + (intakePath(a) || catalogLabel(a) || '(카탈로그 미지정)').replace(DRIVE_ROOT + '/', '') +
          (a.cost.hint ? ' (예상 ' + fmtWon(a.cost.hint) + ')' : ''));
      });
      lines.push('예상 합계 ' + fmtWon(total));
      const steps = group.map(a => {
        const label = a.id + ' · ' + (fileName(a.catalog.series, a.catalog.edition) || catalogLabel(a)) +
          ' → ' + [textbookLabel(a.catalog.textbookCode), gradeLabel(a.catalog.grade), unitLabel(a.catalog.unit)].filter(Boolean).join('/');
        return link.key ? { label: label, ext: link.key } : label;
      });
      return {
        staff: staff,
        title: '[자산] ' + (group.length > 1 ? first + '~' + last : first) + ' 구매·인테이크' +
          (groups.length > 1 ? ' (' + (gi + 1) + '/' + groups.length + ')' : ''),
        detail: lines.join('\n'),
        guide: PURCHASE_GUIDE,
        steps: steps,
        target: group.length,
        unit: '건',
        time: '13:00',
        priority: dLeft != null && dLeft <= 14 ? 'high' : 'normal',
        repeat: 'once',
        start: YMD_RE.test(str(today)) ? str(today) : '',
        carry: true
      };
    });
    return { assignments: assignments };
  }

  return {
    LEDGER_PREFIX: LEDGER_PREFIX, EVENT_PREFIX: EVENT_PREFIX, NEED_PREFIX: NEED_PREFIX,
    CURRICULUM: CURRICULUM, SOURCE: SOURCE, DRIVE_ROOT: DRIVE_ROOT,
    TEXTBOOKS: TEXTBOOKS, GRADES: GRADES, SERIES: SERIES, SERIES_CODES: SERIES_CODES,
    REQUIRED_SERIES: REQUIRED_SERIES, TEACHER_SERIES: TEACHER_SERIES,
    PRICE_HINTS: PRICE_HINTS, PRICE_WARN_PCT: PRICE_WARN_PCT, EDITIONS: EDITIONS, EXAM_TERMS: EXAM_TERMS,
    STATUS: STATUS, STATUS_LABELS: STATUS_LABELS, STATUS_RANK: STATUS_RANK, TRANSITIONS: TRANSITIONS,
    EVENT_TYPES: EVENT_TYPES, EVENT_LABELS: EVENT_LABELS, BLOCK_REASONS: BLOCK_REASONS, CHANNELS: CHANNELS,
    NOTE_MAX: NOTE_MAX, ASSET_ID_RE: ASSET_ID_RE, NEED_ID_RE: NEED_ID_RE, SCHOOL_RE: SCHOOL_RE,
    ledgerKey: ledgerKey, eventKey: eventKey, needKey: needKey, fullKey: fullKey,
    isLedgerKey: isLedgerKey, kindOfKey: kindOfKey,
    assetIdFromKey: assetIdFromKey, eventIdFromKey: eventIdFromKey, needIdFromKey: needIdFromKey,
    textbookLabel: textbookLabel, gradeLabel: gradeLabel, unitLabel: unitLabel, seriesName: seriesName,
    editionLabel: editionLabel, fileName: fileName, fmtWon: fmtWon,
    normalizeAsset: normalizeAsset, normalizeCatalog: normalizeCatalog, priceHint: priceHint,
    catalogKey: catalogKey, catalogLabel: catalogLabel,
    isOwned: isOwned, isPending: isPending, isDuplicate: isDuplicate, duplicatesOf: duplicatesOf,
    nextAssetId: nextAssetId, nextNeedId: nextNeedId,
    intakeFolder: intakeFolder, intakePath: intakePath, packIdFromPath: packIdFromPath, packIdOf: packIdOf,
    canTransition: canTransition, statusAfter: statusAfter,
    normalizeNeed: normalizeNeed, validateNeed: validateNeed, examDateOf: examDateOf, needLabel: needLabel,
    deriveNeeds: deriveNeeds, assetFromNeedRow: assetFromNeedRow,
    daysBetween: daysBetween, sleeping: sleeping,
    newEvent: newEvent, normalizeEvent: normalizeEvent, leadTime: leadTime, priceDiff: priceDiff,
    unrequestedPurchases: unrequestedPurchases, duplicatePurchases: duplicatePurchases, countByStatus: countByStatus,
    purchaseAssignments: purchaseAssignments, PURCHASE_GUIDE: PURCHASE_GUIDE
  };
});
