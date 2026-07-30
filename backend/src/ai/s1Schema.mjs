// S1 관찰 추출 — Claude tool-use 스키마.
// Vision 단계에서 이 도구 호출을 강제해 "해석 없이 사실만" 구조화 출력을 받습니다.
// (엔진 프롬프트 스펙 v0 §2와 대응)

export const S1_SYSTEM_PROMPT = `당신은 아동 그림검사의 '관찰 기록자'입니다.
그림에서 보이는 시각적 특징만 객관적으로 기술하세요.
심리적 해석·진단·추측은 절대 하지 마세요. 반드시 record_observations 도구로만 답하세요.`;

export const S1_TOOL = {
  name: 'record_observations',
  description: '그림에서 관찰된 시각적 특징을 구조화해 기록한다. 해석 금지.',
  input_schema: {
    type: 'object',
    properties: {
      image_quality: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          issues: { type: 'array', items: { type: 'string' } }
        },
        required: ['ok']
      },
      observations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            element: {
              type: 'string',
              // HTP 지식베이스 키와 정렬(S2 매핑 보장). KFD/DAP 확장 시 키 추가.
              enum: [
                // HTP
                'house.roof', 'house.door', 'house.window', 'house.fence',
                'tree.trunk', 'tree.root', 'tree.foliage', 'tree.branch',
                'person.head', 'person.face', 'person.hand', 'person.arm',
                'person.leg', 'person.body',
                // KFD
                'kfd.distance', 'kfd.activity', 'kfd.self_position',
                'kfd.compartment', 'kfd.barrier', 'kfd.order',
                // DAP
                'dap.parts', 'dap.proportion', 'dap.omission',
                'dap.size', 'dap.pressure', 'dap.face',
                // FREE / PITR
                'pitr.rain', 'pitr.umbrella', 'pitr.protection',
                'free.color', 'free.space', 'free.line'
              ],
              description: '관찰 대상 요소 키 (반드시 목록 중 하나). 예: house.roof, tree.root, person.hand'
            },
            present: { type: 'boolean' },
            attributes: {
              type: 'object',
              description: '예: {size:"large"|"small"}, {handle:true|false}, {emphasis:"strong"}, {expression:"smile"|"frown"}, {width:"thin"|"thick"}, {density:"sparse"|"full"}, {direction:"drooping"}'
            },
            note: { type: 'string' },
            vision_confidence: { type: 'string', enum: ['high', 'mid', 'low'] }
          },
          required: ['element', 'present', 'vision_confidence']
        }
      },
      crisis_flags: {
        type: 'array',
        items: { type: 'string', description: '예: self_harm_imagery, violence, abuse_indicator' }
      }
    },
    required: ['image_quality', 'observations', 'crisis_flags']
  }
};
