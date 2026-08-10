// 검사별 해석 지식베이스 (실행용 subset). element 키 → 가설·근거수준·연령규준·경고.
// derive(o): 관찰(o)의 속성/유무에 따라 가설을 다르게 산출(없으면 null).
// ⚠️ 전문 심리사 검수 전 초안. 투사검사 특성상 근거수준 대부분 low~mid, 색채는 low+주의.
// 출처: docs/HTP-해석-지식베이스-v0, docs/KFD-DAP-자유화-지식베이스-v0.

// ── HTP: 집–나무–사람 ──────────────────────────────────────────
export const HTP_KB = {
  'house.roof': {
    match: (a) => a?.size === 'large',
    hypothesis: '상상·공상에 대한 관심이 큰 경향 (가능성)', confidence: 'low',
    caveats: ['HTP 지붕 해석 근거 약함', '연구 간 의미 상충']
  },
  'house.door': {
    match: (a) => a?.handle === false,
    hypothesis: '관계 접근에 신중한 경향 (가능성)', confidence: 'mid',
    caveats: ['단일 지표 단정 금지', '면담(PDI)으로 확인']
  },
  'house.fence': {
    derive: (o) => o.present === false ? null : {
      hypothesis: '가족 경계·방어·보호 욕구 가능성', confidence: 'low',
      caveats: ['근거 약함', '실제 환경(안전 등) 반영 가능']
    }
  },
  'tree.trunk': {
    derive: (o) => o.attributes?.width === 'thin' ? {
      hypothesis: '자아 강도 약화·불안 가능성', confidence: 'mid',
      caveats: ['줄기 해석 근거 중, 그래도 단정 금지', '소근육 발달 영향 가능']
    } : null
  },
  'tree.root': {
    derive: (o) => {
      if (o.attributes?.emphasis === 'strong') return { hypothesis: '안정감·현실 지향 추구 가능성', confidence: 'low', caveats: ['뿌리 상징 해석 근거 약함'] };
      if (o.present === false) return { hypothesis: '기반·소속감 부족 가능성', confidence: 'low', caveats: ['근거 약함', '발달·과제 영향 가능'] };
      return null;
    }
  },
  'tree.foliage': {
    derive: (o) => (o.attributes?.density === 'sparse' || o.attributes?.direction === 'drooping') ? {
      hypothesis: '우울·위축 가능성', confidence: 'low', caveats: ['근거 약함', '계절·미술습관 영향 가능']
    } : null
  },
  'person.hand': {
    matchAbsent: true,
    hypothesis: '행위·대인접촉에 조심스러움 가능성', confidence: 'mid',
    ageNorm: { normalBelow: 9, note: '만 9세 미만·전후에서는 발달상 정상 범위일 수 있음 — 병리 단정 금지' },
    caveats: ['귀찮음 등 대안 설명 가능', '반복 시에만 의미']
  },
  'person.face': {
    derive: (o) => {
      const a = o.attributes || {};
      if (a.expression === 'smile' || a.size === 'large') return { hypothesis: '정서 표현이 개방적이고 긍정 정서 (강점)', confidence: 'mid', strength: true, caveats: ['노골적 정서 기호만 참고', '진단 아님'] };
      if (a.expression === 'frown' || a.expression === 'down') return { hypothesis: '부정 정서·위축 가능성', confidence: 'low', caveats: ['단일 지표 단정 금지', '일시적 기분 영향 가능', '면담 확인'] };
      return null;
    }
  }
};

// ── KFD: 동적 가족화 ──────────────────────────────────────────
export const KFD_KB = {
  'kfd.distance': {
    derive: (o) => {
      const l = o.attributes?.level;
      if (l === 'close') return { hypothesis: '정서적 친밀·의존 경향 가능성', confidence: 'mid', caveats: ['상황·과제 영향', '면담 확인'] };
      if (l === 'far') return { hypothesis: '정서적 거리·갈등·소외감 가능성', confidence: 'mid', caveats: ['문화·상황 영향', '단정 금지'] };
      return null;
    }
  },
  'kfd.activity': {
    derive: (o) => {
      if (o.present === false || o.attributes?.interaction === false) return { hypothesis: '가족 내 정서적 단절감 가능성', confidence: 'mid', caveats: ['문화·상황 영향'] };
      if (o.attributes?.interaction === true) return { hypothesis: '협력·지지적 가족 지각 (강점)', confidence: 'mid', strength: true, caveats: ['단정 금지'] };
      return null;
    }
  },
  'kfd.self_position': {
    derive: (o) => {
      const a = o.attributes || {};
      if (a.size === 'large' || a.location === 'center') return { hypothesis: '자기중심·주목 욕구 가능성', confidence: 'mid', caveats: ['발달·기질 영향'] };
      if (a.size === 'small' || a.location === 'corner') return { hypothesis: '위축·소외감 가능성', confidence: 'mid', caveats: ['발달 영향', '반복 시 의미'] };
      return null;
    }
  },
  'kfd.compartment': {
    derive: (o) => o.present === false ? null : { hypothesis: '정서적 분리·방어 가능성', confidence: 'low', caveats: ['표준화 규준 부족', '반복 시에만 의미'] }
  },
  'kfd.barrier': {
    derive: (o) => o.present === false ? null : { hypothesis: '의사소통 차단·방어 욕구 가능성', confidence: 'low', caveats: ['체계적 검증 제한'] }
  },
  'kfd.order': {
    derive: (o) => {
      if (o.attributes?.self_first === true) return { hypothesis: '자기 초점 경향 가능성', confidence: 'low', caveats: ['과제 전략 영향'] };
      if (o.attributes?.self_last === true) return { hypothesis: '자기 중요성 축소·가족 우선 가능성', confidence: 'low', caveats: ['과제 전략 영향'] };
      return null;
    }
  }
};

// ── DAP: 인물화 (발달·정서 지표 분리) ─────────────────────────
export const DAP_KB = {
  'dap.parts': {  // 발달·지능 지표
    derive: (o) => o.attributes?.count === 'low' ? {
      hypothesis: '발달 수준 미성숙 가능성 (발달 지표)', confidence: 'mid',
      caveats: ['연령·미술경험 영향', '정서 문제 아님', '한국 규준 부재로 IQ 산출 부적절']
    } : null
  },
  'dap.proportion': {
    derive: (o) => o.attributes?.distortion === 'severe' ? {
      hypothesis: '발달·정서 불안정 가능성', confidence: 'mid', caveats: ['단독 진단 불가', '발달 고려']
    } : null
  },
  'dap.omission': {  // 정서 지표 (Koppitz 계열, 근거 약)
    derive: (o) => {
      const p = o.attributes?.part;
      if (p === 'hand') return { hypothesis: '통제감 부족·행동 억제 가능성', confidence: 'low', ageNorm: { normalBelow: 9, note: '만 9세 미만 생략은 발달상 정상 범위일 수 있음' }, caveats: ['정서지표 근거 약함', '대안 설명 가능'] };
      if (p === 'mouth') return { hypothesis: '표현 억제 가능성', confidence: 'low', caveats: ['정서지표 근거 약함'] };
      if (p === 'neck') return { hypothesis: '충동통제 어려움 가능성', confidence: 'low', caveats: ['정서지표 근거 약함'] };
      return null;
    }
  },
  'dap.size': {
    derive: (o) => {
      const s = o.attributes?.size;
      if (s === 'small') return { hypothesis: '위축·자존감 저하 가능성', confidence: 'low', caveats: ['크기만으로 단정 불가'] };
      if (s === 'large') return { hypothesis: '자기중심·충동 가능성', confidence: 'low', caveats: ['크기만으로 단정 불가'] };
      return null;
    }
  },
  'dap.pressure': {
    derive: (o) => {
      const l = o.attributes?.level;
      if (l === 'heavy') return { hypothesis: '긴장·공격성 가능성', confidence: 'low', caveats: ['필기구·소근육 영향'] };
      if (l === 'light') return { hypothesis: '위축·불안 가능성', confidence: 'low', caveats: ['필기구·소근육 영향'] };
      return null;
    }
  },
  'dap.face': {
    derive: (o) => {
      const e = o.attributes?.expression;
      if (e === 'smile') return { hypothesis: '정서 개방·긍정 정서 (강점)', confidence: 'mid', strength: true, caveats: ['진단 아님'] };
      if (e === 'frown') return { hypothesis: '부정 정서 가능성', confidence: 'low', caveats: ['일시적 기분 영향 가능'] };
      if (e === 'blank') return { hypothesis: '정서 둔마·우울 가능성', confidence: 'low', caveats: ['문화·미술습관 영향'] };
      return null;
    }
  }
};

// ── FREE: 자유화·PITR(빗속의 사람) ────────────────────────────
export const FREE_KB = {
  'pitr.rain': {
    derive: (o) => {
      const a = o.attributes?.amount;
      if (a === 'heavy') return { hypothesis: '현재 스트레스가 크거나 민감할 가능성', confidence: 'mid', caveats: ['상황 영향'] };
      if (a === 'none') return { hypothesis: '스트레스 지각 둔감·회피 가능성', confidence: 'low', caveats: ['근거 약함'] };
      return null;
    }
  },
  'pitr.umbrella': {
    derive: (o) => {
      if (o.present === false) return { hypothesis: '대처자원 부족 가능성', confidence: 'mid', caveats: ['자원이 다른 형태일 수 있음'] };
      if (o.attributes?.size === 'large') return { hypothesis: '과도한 방어 가능성', confidence: 'low', caveats: ['근거 약함'] };
      return { hypothesis: '스트레스 대처자원 존재 (강점)', confidence: 'low', strength: true, caveats: ['참고 수준'] };
    }
  },
  'pitr.protection': {
    derive: (o) => o.present === true ? { hypothesis: '활용 가능한 내·외적 자원 풍부 가능성 (강점)', confidence: 'low', strength: true, caveats: ['교재 수준 근거'] } : null
  },
  'free.color': {
    derive: (o) => {
      const u = o.attributes?.usage;
      if (u === 'dark') return { hypothesis: '에너지 저하·위축 가능성', confidence: 'low', caveats: ['색채 해석은 문화·개인차 큼', '이 색을 고른 이유 확인 필수', '진단 아님'] };
      if (u === 'varied') return { hypothesis: '에너지·탐색·개방성 가능성 (강점)', confidence: 'low', strength: true, caveats: ['색채 해석 초기 단계·한계'] };
      return null;
    }
  },
  'free.space': {
    derive: (o) => {
      const a = o.attributes || {};
      if (a.placement === 'corner' || a.whitespace === 'high') return { hypothesis: '위축·표현 최소화 가능성', confidence: 'low', caveats: ['발달 영향'] };
      if (a.placement === 'center') return { hypothesis: '자기 존재감·자기주장 가능성 (강점)', confidence: 'low', strength: true, caveats: ['참고 수준'] };
      return null;
    }
  },
  'free.line': {
    derive: (o) => {
      const q = o.attributes?.quality;
      if (q === 'heavy') return { hypothesis: '긴장·공격성 가능성', confidence: 'low', caveats: ['필기구·소근육 영향'] };
      if (q === 'light') return { hypothesis: '위축·자기확신 부족 가능성', confidence: 'low', caveats: ['필기구·소근육 영향'] };
      return null;
    }
  }
};

// ── 검사별 KB 레지스트리 ──────────────────────────────────────
export const KB_BY_TEST = { HTP: HTP_KB, KFD: KFD_KB, DAP: DAP_KB, FREE: FREE_KB };

// 전 검사 공통 메타규칙
export const META_CAVEAT = '단일 지표로 진단 불가 · 타 검사·면담과 통합 필요';
