// HTP 해석 지식베이스 (엔진 재료 v0의 실행용 subset).
// element 키 → 가설·근거수준·연령규준·경고. S2 가설 매핑이 사용.
// derive(o): 관찰(o)의 속성/유무에 따라 가설을 다르게 산출(없으면 null).
// ⚠️ 전문 심리사 검수 전 초안. 투사검사 특성상 근거수준 대부분 low~mid.

export const HTP_KB = {
  'house.roof': {
    match: (a) => a?.size === 'large',
    hypothesis: '상상·공상에 대한 관심이 큰 경향 (가능성)',
    confidence: 'low',
    caveats: ['HTP 지붕 해석 근거 약함', '연구 간 의미 상충']
  },
  'house.door': {
    match: (a) => a?.handle === false,
    hypothesis: '관계 접근에 신중한 경향 (가능성)',
    confidence: 'mid',
    caveats: ['단일 지표 단정 금지', '면담(PDI)으로 확인']
  },
  'house.fence': {
    derive: (o) => o.present === false ? null : {
      hypothesis: '가족 경계·방어·보호 욕구 가능성',
      confidence: 'low',
      caveats: ['근거 약함', '실제 환경(안전 등) 반영 가능']
    }
  },
  'tree.trunk': {
    derive: (o) => o.attributes?.width === 'thin' ? {
      hypothesis: '자아 강도 약화·불안 가능성',
      confidence: 'mid',
      caveats: ['줄기 해석 근거 중, 그래도 단정 금지', '소근육 발달 영향 가능']
    } : null
  },
  'tree.root': {
    derive: (o) => {
      if (o.attributes?.emphasis === 'strong') return {
        hypothesis: '안정감·현실 지향 추구 가능성', confidence: 'low',
        caveats: ['뿌리 상징 해석 근거 약함']
      };
      if (o.present === false) return {
        hypothesis: '기반·소속감 부족 가능성', confidence: 'low',
        caveats: ['근거 약함', '발달·과제 영향 가능']
      };
      return null;
    }
  },
  'tree.foliage': {
    derive: (o) => (o.attributes?.density === 'sparse' || o.attributes?.direction === 'drooping') ? {
      hypothesis: '우울·위축 가능성', confidence: 'low',
      caveats: ['근거 약함', '계절·미술습관 영향 가능']
    } : null
  },
  'person.hand': {
    // 손 '생략'(present:false)일 때만
    matchAbsent: true,
    hypothesis: '행위·대인접촉에 조심스러움 가능성',
    confidence: 'mid',
    ageNorm: { normalBelow: 9, note: '만 9세 미만·전후에서는 발달상 정상 범위일 수 있음 — 병리 단정 금지' },
    caveats: ['귀찮음 등 대안 설명 가능', '반복 시에만 의미']
  },
  'person.face': {
    derive: (o) => {
      const a = o.attributes || {};
      if (a.expression === 'smile' || a.size === 'large') return {
        hypothesis: '정서 표현이 개방적이고 긍정 정서 (강점)', confidence: 'mid', strength: true,
        caveats: ['노골적 정서 기호만 참고', '진단 아님']
      };
      if (a.expression === 'frown' || a.expression === 'down') return {
        hypothesis: '부정 정서·위축 가능성', confidence: 'low',
        caveats: ['단일 지표 단정 금지', '일시적 기분 영향 가능', '면담 확인']
      };
      return null;
    }
  }
};

// 전 검사 공통 메타규칙 (가드레일과 함께 사용)
export const META_CAVEAT = '단일 지표로 진단 불가 · 타 검사·면담과 통합 필요';
