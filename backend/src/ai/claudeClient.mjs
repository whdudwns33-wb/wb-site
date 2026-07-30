// Claude 클라이언트 — 실제 API(@anthropic-ai/sdk) + 모의(mock) 폴백.
// ANTHROPIC_API_KEY가 없으면 mock으로 동작(개발/CI에서 SDK 없이도 실행 가능).
// SDK는 키가 있을 때만 지연 import → mock 경로는 무의존성 유지.

import { S1_SYSTEM_PROMPT, S1_TOOL } from './s1Schema.mjs';

// 모델(기본 Claude Opus 5). 필요 시 환경변수로 검사단계별 교체 가능.
const MODEL_S1 = process.env.MODEL_S1 || process.env.CLAUDE_MODEL || 'claude-opus-5';
const MODEL_S3 = process.env.MODEL_S3 || process.env.CLAUDE_MODEL || 'claude-opus-5';
const useMock = !process.env.ANTHROPIC_API_KEY;

let _client = null;
async function getClient() {
  if (_client) return _client;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  _client = new Anthropic();          // ANTHROPIC_API_KEY를 환경에서 자동 사용
  return _client;
}

// ── S1: Vision 관찰 추출 (강제 tool-use로 구조화 출력) ────────────
export async function extractObservations({ testType, age, sex, imageRef, imageBase64, mediaType }) {
  if (useMock || (!imageBase64 && String(imageRef || '').startsWith('sample-'))) {
    return mockObservations({ testType, imageRef });
  }
  if (!imageBase64) throw new Error('S1: 이미지(base64)가 없습니다');

  const client = await getClient();
  const res = await client.messages.create({
    model: MODEL_S1,
    max_tokens: 4096,   // Opus 5는 적응형 thinking이 기본 → 관찰 JSON 잘림 방지 위해 여유
    system: S1_SYSTEM_PROMPT,
    tools: [S1_TOOL],
    tool_choice: { type: 'tool', name: 'record_observations' },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `검사: ${testType}, 아동: 만 ${age ?? '?'}세 ${sex ?? ''}. 관찰만 기록.` },
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/png', data: imageBase64 } }
      ]
    }]
  });
  const toolUse = (res.content || []).find((b) => b.type === 'tool_use' && b.name === 'record_observations');
  if (!toolUse) throw new Error('S1: record_observations 도구 응답 없음');
  return toolUse.input;
}

// ── S3: 자연어 생성 (전문가 초안 / 학부모 미리보기 / 정식 리포트) ──
const SYS = {
  expert_draft:
    "당신은 아동 심리평가 보조 도구입니다. 아래 관찰-가설 목록을 근거로 전문가가 '검수'할 초안을 작성하세요.\n" +
    "규칙: 각 항목을 '관찰 → 가설(신뢰도) → 상담에서 확인할 질문' 형식으로. 단정 금지. '진단'이라는 단어 사용 금지.\n" +
    "약한 근거는 명확히 '약'으로 표시하고 대안 설명을 병기. 마지막에 '본 초안은 가설이며, 타 검사·면담과 통합 필요' 문구 포함. 한국어.",
  parent_preview:
    "당신은 학부모에게 전할 '참고용 미리보기'를 씁니다.\n" +
    "규칙: 강점을 먼저, 따뜻하고 쉬운 말로. 정서·병리 관련 강한 표현 금지(관찰 중심만).\n" +
    "'전문가 확정 후 정식 해석 제공' 안내와 '참고용이며 진단이 아닙니다' 취지의 문구를 포함. 2~4문장, 한국어.",
  parent_report:
    "전문가가 확정한 항목만 사용해 학부모용 정식 리포트를 씁니다.\n" +
    "구조: 강점 → 관찰된 특징 → 집에서 돕는 법 → 다음 단계(상담). 낙인·병리 언어를 성장 관점으로 리프레이밍.\n" +
    "하단에 '본 리포트는 참고용이며 진단이 아닙니다' 면책 문구를 고정. 쉬운 한국어."
};

export async function generateText({ kind, payload }) {
  if (useMock) return mockGenerate({ kind, payload });

  const keep = (payload.hypotheses || []).filter((h) => h.status !== 'rejected');
  const items = keep.map((h) => ({
    observation: h.observation,
    hypothesis: h.edited_text || h.text,
    confidence: h.confidence,
    age_adjustment: h.age_adjustment || null,
    caveats: h.caveats || [],
    strength: !!h.strength
  }));
  const client = await getClient();
  const res = await client.messages.create({
    model: MODEL_S3,
    max_tokens: 4096,   // thinking + 본문 여유
    system: SYS[kind] || SYS.expert_draft,
    messages: [{ role: 'user', content: '아래 관찰-가설(JSON)을 바탕으로 작성하세요:\n' + JSON.stringify(items, null, 2) }]
  });
  return (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// ── mock 구현 (키/SDK 없이 흐름 검증용) ───────────────────────────
function mockObservations({ testType, imageRef }) {
  const q = { ok: true, issues: [] };
  const S = {
    'sample-htp': [
      { element: 'house.roof', present: true, attributes: { size: 'large' }, note: '지붕이 몸체보다 크게', vision_confidence: 'high' },
      { element: 'house.door', present: true, attributes: { handle: false }, note: '문 손잡이 없음', vision_confidence: 'mid' },
      { element: 'tree.root', present: true, attributes: { emphasis: 'strong' }, note: '뿌리·밑동 강조', vision_confidence: 'mid' },
      { element: 'person.hand', present: false, attributes: {}, note: '손 생략', vision_confidence: 'high' },
      { element: 'person.face', present: true, attributes: { size: 'large', expression: 'smile' }, note: '큰 눈·미소', vision_confidence: 'high' }
    ],
    'sample-kfd': [
      { element: 'kfd.distance', present: true, attributes: { level: 'far' }, note: '인물 간 거리 멂', vision_confidence: 'mid' },
      { element: 'kfd.activity', present: true, attributes: { interaction: false }, note: '각자 다른 활동', vision_confidence: 'mid' },
      { element: 'kfd.self_position', present: true, attributes: { size: 'small', location: 'corner' }, note: '자기 구석·작게', vision_confidence: 'mid' },
      { element: 'kfd.barrier', present: true, attributes: {}, note: '사물로 가로막힘', vision_confidence: 'mid' }
    ],
    'sample-dap': [
      { element: 'dap.parts', present: true, attributes: { count: 'low' }, note: '신체부위 적음', vision_confidence: 'mid' },
      { element: 'dap.omission', present: false, attributes: { part: 'hand' }, note: '손 생략', vision_confidence: 'high' },
      { element: 'dap.size', present: true, attributes: { size: 'small' }, note: '작게 그림', vision_confidence: 'mid' },
      { element: 'dap.face', present: true, attributes: { expression: 'blank' }, note: '무표정', vision_confidence: 'mid' }
    ],
    'sample-free': [
      { element: 'pitr.rain', present: true, attributes: { amount: 'heavy' }, note: '빗줄기 많음', vision_confidence: 'high' },
      { element: 'pitr.umbrella', present: false, attributes: {}, note: '우산 없음', vision_confidence: 'high' },
      { element: 'free.color', present: true, attributes: { usage: 'dark' }, note: '어두운 색 위주', vision_confidence: 'mid' },
      { element: 'free.space', present: true, attributes: { placement: 'corner' }, note: '구석 배치', vision_confidence: 'mid' }
    ]
  };
  if (S[imageRef]) return { image_quality: q, observations: S[imageRef], crisis_flags: [] };
  const flags = imageRef === 'sample-crisis' ? ['self_harm_imagery'] : [];
  return { image_quality: q, observations: [], crisis_flags: flags };
}

function mockGenerate({ kind, payload }) {
  const keep = (payload.hypotheses || []).filter((h) => h.status !== 'rejected');
  if (kind === 'expert_draft') {
    const lines = keep.map((h) =>
      `- ${h.observation} (${confKo(h.confidence)}): ${h.edited_text || h.text}` +
      (h.age_adjustment ? ` ⚖ ${h.age_adjustment}` : ''));
    return lines.join('\n') + '\n- 종합: 본 초안은 가설이며, 타 검사·면담과 통합 필요.';
  }
  if (kind === 'parent_preview') {
    return '아이의 그림에는 밝은 표정 등 긍정적인 특징이 보여요. 자세한 이야기는 전문 선생님이 확인한 뒤 정식 리포트로 전해 드릴게요. (참고용이며 진단이 아닙니다.)';
  }
  if (kind === 'parent_report') {
    const strengths = keep.filter((h) => h.strength).map((h) => h.text);
    const features = keep.filter((h) => !h.strength).map((h) => h.edited_text || h.text);
    return [
      '【강점】 ' + (strengths.join(' / ') || '밝은 정서 표현'),
      '【관찰된 특징】 ' + (features.join(' / ') || '—'),
      '【집에서 돕는 법】 그림으로 이야기 열어주기 · 아이만의 시간 · 구체적 칭찬',
      '【다음 단계】 전문 심리사 1:1 해석 상담 안내',
      '※ 본 리포트는 참고용이며 진단이 아닙니다.'
    ].join('\n');
  }
  return '';
}

function confKo(c) { return c === 'high' ? '강' : c === 'mid' ? '중' : '약'; }

// 상태 점검용
export const clientInfo = { useMock, MODEL_S1, MODEL_S3 };
