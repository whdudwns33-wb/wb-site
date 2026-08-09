(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBAssetCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 기기 대장은 checks 테이블에 '__asset__<id>|all' 키로 얹는다.
     출결(__st__)·온라인프로그램(__op__)이 이미 같은 방식이라 백엔드를 건드리지 않는다.
     전용 테이블로 옮길 때를 위해 키 조립·해체를 여기 한곳에 모아 둔다. */
  const ASSET_PREFIX = '__asset__';
  const ASSET_SUFFIX = '|all';
  const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

  const KINDS = {
    adv2: { key: 'adv2', label: '갤럭시탭 Advanced2', os: '8.0', spen: true, chromeMax: 138 },
    a7: { key: 'a7', label: '갤럭시탭 A7', os: '12', spen: false, chromeMax: 0 },
    other: { key: 'other', label: '기타', os: '', spen: false, chromeMax: 0 }
  };

  /* 배치유형. 앱을 용도별로 나누지 않고 기기 속성 하나로 다룬다. */
  const PLACES = [
    { key: 'teacher', label: '교사', tier: 'T' },
    { key: 'student', label: '학생', tier: 'S' },
    { key: 'center', label: '센터', tier: 'B' },
    { key: 'shared', label: '공용', tier: 'B' },
    { key: 'quarantine', label: '격리', tier: 'C' }
  ];

  const TIERS = [
    { key: 'T', label: '교사 단말' },
    { key: 'S', label: '학생 학습존' },
    { key: 'B', label: '단일 목적' },
    { key: 'C', label: '격리' }
  ];

  /* 실사에서 기기를 못 쓰게 만드는 조건. 부푼 배터리는 안전 문제라 즉시 격리한다. */
  const FATAL = [
    { field: 'battery', value: 'swollen', why: '배터리 부풀음 — 즉시 격리' },
    { field: 'charge', value: 'fail', why: '충전 불가' },
    { field: 'screen', value: 'crack', why: '화면 파손' }
  ];

  const WATCH = [
    { field: 'battery', value: 'weak', why: '배터리 성능 저하' },
    { field: 'screen', value: 'touch', why: '터치 불량' },
    { field: 'locked', value: 'mbest', why: '엠베스트 런처 잠금 — 1544-2300 문의 필요' },
    { field: 'locked', value: 'other', why: '알 수 없는 런처 잠금' }
  ];

  function str(v) { return v == null ? '' : String(v).trim(); }
  function pad3(n) { return String(n).padStart(3, '0'); }

  function assetKey(id) { return ASSET_PREFIX + str(id) + ASSET_SUFFIX; }

  function isAssetKey(key) {
    const k = str(key);
    return k.startsWith(ASSET_PREFIX) && k.endsWith(ASSET_SUFFIX);
  }

  function assetIdFromKey(key) {
    if (!isAssetKey(key)) return '';
    return str(key).slice(ASSET_PREFIX.length, str(key).length - ASSET_SUFFIX.length);
  }

  /* 모델명으로 기종을 가른다. 실사에서 사람이 적는 값이라 공백·대소문자를 흡수한다. */
  function kindOfModel(model) {
    const m = str(model).toUpperCase().replace(/[\s-]/g, '');
    if (m.indexOf('T583') >= 0) return 'adv2';
    if (m.indexOf('T500') >= 0 || m.indexOf('T505') >= 0) return 'a7';
    return 'other';
  }

  function kindInfo(kind) { return KINDS[kind] || KINDS.other; }

  function normalizeAsset(raw) {
    const a = raw && typeof raw === 'object' ? raw : {};
    const model = str(a.model);
    const kind = str(a.kind) || kindOfModel(model);
    return {
      id: str(a.id),
      label: str(a.label),
      serial: str(a.serial),
      model: model,
      kind: KINDS[kind] ? kind : 'other',
      os: str(a.os),
      chrome: str(a.chrome),
      battery: str(a.battery),
      charge: str(a.charge),
      screen: str(a.screen),
      locked: str(a.locked),
      tier: str(a.tier),
      place: str(a.place),
      holder: str(a.holder),
      spot: str(a.spot),
      pii: !!a.pii,
      note: str(a.note),
      checkedAt: Number(a.checkedAt) || 0,
      checkedBy: str(a.checkedBy),
      updatedAt: Number(a.updatedAt) || 0
    };
  }

  /* 실사를 했는지. 상태 3종이 다 채워져야 점검한 것으로 본다. */
  function isAudited(asset) {
    const a = normalizeAsset(asset);
    return !!(a.checkedAt && a.battery && a.charge && a.screen);
  }

  /* ok | watch | dead + 사유. 사유는 화면에 그대로 보여준다. */
  function healthOf(asset) {
    const a = normalizeAsset(asset);
    const reasons = [];
    let level = 'ok';

    FATAL.forEach(rule => {
      if (a[rule.field] === rule.value) { level = 'dead'; reasons.push(rule.why); }
    });
    WATCH.forEach(rule => {
      if (a[rule.field] === rule.value) {
        if (level !== 'dead') level = 'watch';
        reasons.push(rule.why);
      }
    });

    /* 크롬이 138보다 낮은 Advanced2는 학습존·키오스크로 못 쓴다. 업데이트하면 풀린다. */
    if (a.kind === 'adv2' && a.chrome) {
      const v = parseInt(a.chrome, 10);
      if (Number.isFinite(v) && v < KINDS.adv2.chromeMax) {
        if (level !== 'dead') level = 'watch';
        reasons.push('크롬 ' + v + ' — 138로 업데이트 필요');
      }
    }

    if (!isAudited(a)) {
      if (level === 'ok') level = 'watch';
      reasons.push('실사 미완료');
    }

    return { level: level, reasons: reasons };
  }

  /* 티어 추천. 확정은 원장이 하고, 여기서는 근거만 만든다. */
  function recommendTier(asset) {
    const a = normalizeAsset(asset);
    if (healthOf(a).level === 'dead') return { tier: 'C', why: '상태 불량 — 격리' };
    if (a.kind === 'a7') return { tier: 'T', why: 'Android 12 · 크롬 계속 수신 — 교사 상시 업무용' };
    if (a.kind === 'adv2') return { tier: 'B', why: '크롬 138 동결 — 단일 목적. 웹 구동 확인되면 S로 올림' };
    return { tier: '', why: '기종 확인 필요' };
  }

  /* 배치유형을 정하면 티어가 따라온다. 둘을 따로 적게 하면 어긋난다. */
  function tierOfPlace(place) {
    const found = PLACES.filter(p => p.key === str(place))[0];
    return found ? found.tier : '';
  }

  function placeLabel(place) {
    const found = PLACES.filter(p => p.key === str(place))[0];
    return found ? found.label : '';
  }

  /* 다음 라벨 번호. 기기에 스티커로 붙는 번호라 빈자리를 재사용하지 않고 뒤에 붙인다. */
  function nextId(assets, prefix) {
    const pre = str(prefix) || 'A';
    let max = 0;
    (assets || []).forEach(a => {
      const id = str(normalizeAsset(a).id);
      if (id.slice(0, pre.length).toUpperCase() !== pre.toUpperCase()) return;
      const n = parseInt(id.slice(pre.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    });
    return pre + pad3(max + 1);
  }

  function auditProgress(assets) {
    const list = (assets || []).map(normalizeAsset);
    let done = 0, dead = 0, watch = 0;
    list.forEach(a => {
      if (isAudited(a)) done++;
      const h = healthOf(a);
      if (h.level === 'dead') dead++;
      else if (h.level === 'watch') watch++;
    });
    const total = list.length;
    return {
      total: total,
      done: done,
      left: total - done,
      dead: dead,
      watch: watch,
      pct: total ? Math.round((done / total) * 100) : 0
    };
  }

  function countBy(assets, field) {
    const out = {};
    (assets || []).map(normalizeAsset).forEach(a => {
      const k = str(a[field]) || '(미지정)';
      out[k] = (out[k] || 0) + 1;
    });
    return out;
  }

  /* 담당자에게 배정된 기기. 개인 링크로 들어온 직원은 이것만 본다. */
  function assetsOfHolder(assets, holderId) {
    const h = str(holderId);
    if (!h) return [];
    return (assets || []).map(normalizeAsset).filter(a => a.holder === h);
  }

  /* 여러 줄 붙여넣기로 일괄 등록.
     '번호, 모델명, 일련번호' 순서이며 쉼표·탭 어느 쪽으로 구분해도 받는다.
     번호를 비우면 자동으로 채운다. */
  function parseBulk(text, existing) {
    /* 줄 전체를 trim하면 앞칸을 비운 줄('  , SM-T583')의 빈 번호 칸이 사라져
       모델명이 번호로 밀린다. 줄이 아니라 칸을 다듬는다. */
    const rows = str(text).split('\n')
      .map(s => s.replace(/\r$/, ''))
      .filter(s => s.trim());
    const pool = (existing || []).map(normalizeAsset);
    const taken = {};
    pool.forEach(a => { if (a.id) taken[a.id.toUpperCase()] = true; });

    const added = [];
    const errors = [];

    rows.forEach((line, i) => {
      const cols = line.split(/[,\t]/).map(s => s.trim());
      let id = cols[0] || '';
      let model = cols[1] || '';
      let serial = cols[2] || '';

      /* 구분자도 없이 모델부터 적은 줄을 받아준다. 라벨 번호는 모델코드와 겹치지 않는다. */
      if (id && kindOfModel(id) !== 'other') {
        serial = model;
        model = id;
        id = '';
      }

      if (!model) { errors.push({ line: i + 1, text: line, why: '모델명이 없습니다' }); return; }

      if (!id) {
        id = nextId(pool.concat(added), 'A');
      } else if (!ID_RE.test(id)) {
        errors.push({ line: i + 1, text: line, why: '번호에 쓸 수 없는 문자가 있습니다' });
        return;
      } else if (taken[id.toUpperCase()]) {
        errors.push({ line: i + 1, text: line, why: '이미 있는 번호입니다 (' + id + ')' });
        return;
      }

      taken[id.toUpperCase()] = true;
      const kind = kindOfModel(model);
      added.push(normalizeAsset({
        id: id,
        model: model,
        serial: serial,
        kind: kind,
        os: kindInfo(kind).os
      }));
    });

    return { added: added, errors: errors };
  }

  /* ── 업무지시서 연동 ──────────────────────────────────
     기기 목록을 앱이 그대로 받는 assignments 형태로 바꾼다.
     지시서 화면의 JSON 붙여넣기와 같은 스키마라 검증 경로가 하나로 유지된다. */

  function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  const AUDIT_GUIDE = [
    '1) 태블릿을 한 대씩 켭니다',
    '2) 설정 > 휴대전화 정보에서 모델명과 안드로이드 버전을 확인합니다',
    '3) 배터리가 부풀어 뒷판이 뜬 기기는 즉시 별도 박스로 분리합니다 (안전 문제)',
    '4) 충전 케이블을 꽂아 충전이 되는지 확인합니다',
    '5) 화면 깨짐·터치 불량을 확인합니다',
    '6) 크롬 > 설정 > Chrome 정보에서 버전을 확인합니다',
    '7) 잠금화면에 엠베스트 등 전용 앱이 뜨는지 확인합니다',
    '8) 기기 탭에서 해당 번호를 열어 결과를 그대로 입력합니다'
  ].join('\n');

  /* 미실사 기기를 실사 업무로 발행한다. 한 건이 너무 커지지 않게 끊는다. */
  function buildAuditAssignments(assets, opts) {
    const o = opts || {};
    const staff = str(o.staff);
    const perTask = Number(o.perTask) > 0 ? Number(o.perTask) : 25;
    const pending = (assets || []).map(normalizeAsset).filter(a => !isAudited(a));
    if (!staff || !pending.length) return [];

    const groups = chunk(pending, perTask);
    return groups.map((group, i) => ({
      staff: staff,
      title: '태블릿 실사' + (groups.length > 1 ? ' (' + (i + 1) + '/' + groups.length + ')' : ''),
      detail: group[0].id + '~' + group[group.length - 1].id + ' · ' + group.length + '대',
      guide: AUDIT_GUIDE,
      steps: group.map(a => a.id + ' ' + (a.model || '기종 확인')),
      target: group.length,
      unit: '대',
      priority: 'high',
      repeat: 'once',
      carry: true
    }));
  }

  /* 이상 기기를 조치 업무로 발행한다. 사유를 단계로 풀어 무엇을 볼지 남긴다. */
  function buildRepairAssignment(assets, opts) {
    const o = opts || {};
    const staff = str(o.staff);
    const bad = (assets || []).map(normalizeAsset)
      .map(a => ({ asset: a, health: healthOf(a) }))
      .filter(x => x.health.level === 'dead');
    if (!staff || !bad.length) return null;

    return {
      staff: staff,
      title: '이상 기기 격리·조치',
      detail: bad.length + '대 — 부푼 배터리는 아이들 공간에서 먼저 빼주세요',
      guide: [
        '1) 아래 번호의 기기를 찾아 별도 박스로 옮깁니다',
        '2) 배터리가 부푼 기기는 충전하지 말고, 아이들 손이 닿지 않는 곳에 둡니다',
        '3) 기기 탭에서 배치를 "격리"로 바꿉니다',
        '4) 수리·폐기 여부는 원장님께 보고 후 결정합니다'
      ].join('\n'),
      steps: bad.map(x => x.asset.id + ' — ' + x.health.reasons.join(', ')),
      target: bad.length,
      unit: '대',
      priority: 'high',
      repeat: 'once',
      carry: true
    };
  }

  /* 개인정보를 다루는 기기(센터 대기실 문진 등)의 정기 점검.
     학원 기기와 같은 주기로 두면 안 되므로 따로 발행한다. */
  function buildPiiCheckAssignment(assets, opts) {
    const o = opts || {};
    const staff = str(o.staff);
    const pii = (assets || []).map(normalizeAsset).filter(a => a.pii);
    if (!staff || !pii.length) return null;

    return {
      staff: staff,
      title: '개인정보 취급 기기 점검',
      detail: pii.length + '대 — 문진·설문 태블릿',
      guide: [
        '1) 키오스크 모드가 풀려 있지 않은지 확인합니다',
        '2) 크롬 > 설정 > 인터넷 사용 기록 삭제 를 실행합니다',
        '3) 저장된 비밀번호·자동완성이 남아 있지 않은지 봅니다',
        '4) 갤러리에 문진표를 찍은 사진이 남아 있으면 삭제합니다',
        '5) 이상이 있으면 메모에 적고 원장님께 알립니다'
      ].join('\n'),
      steps: pii.map(a => a.id + ' ' + (a.spot || '위치 미지정')),
      target: pii.length,
      unit: '대',
      priority: 'high',
      repeat: 'days',
      days: [1],
      carry: true
    };
  }

  return {
    ASSET_PREFIX: ASSET_PREFIX,
    KINDS: KINDS,
    PLACES: PLACES,
    TIERS: TIERS,
    assetKey: assetKey,
    isAssetKey: isAssetKey,
    assetIdFromKey: assetIdFromKey,
    kindOfModel: kindOfModel,
    kindInfo: kindInfo,
    normalizeAsset: normalizeAsset,
    isAudited: isAudited,
    healthOf: healthOf,
    recommendTier: recommendTier,
    tierOfPlace: tierOfPlace,
    placeLabel: placeLabel,
    nextId: nextId,
    auditProgress: auditProgress,
    countBy: countBy,
    assetsOfHolder: assetsOfHolder,
    parseBulk: parseBulk,
    buildAuditAssignments: buildAuditAssignments,
    buildRepairAssignment: buildRepairAssignment,
    buildPiiCheckAssignment: buildPiiCheckAssignment
  };
});
