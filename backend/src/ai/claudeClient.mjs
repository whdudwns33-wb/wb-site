// Claude 클라이언트 — 실제 API 경로 + 모의(mock) 폴백.
// ANTHROPIC_API_KEY가 없으면 mock으로 동작(개발/CI에서 네트워크 없이 실행 가능).
// 실제 연동 시 이 파일만 교체하면 나머지 파이프라인은 그대로 동작.

import { S1_SYSTEM_PROMPT, S1_TOOL } from './s1Schema.mjs';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL_DRAFT = 'claude-opus-5';      // 초안(S1/S3): 상위 모델
const useMock = !process.env.ANTHROPIC_API_KEY;

// ── S1: Vision 관찰 추출 ─────────────────────────────────────────
export async function extractObservations({ testType, age, sex, imageRef, imageBase64 }) {
  if (useMock) return mockObservations({ testType, imageRef, age });

  // 실제 경로: tool_choice로 record_observations 강제
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL_DRAFT,
      max_tokens: 1024,
      system: S1_SYSTEM_PROMPT,
      tools: [S1_TOOL],
      tool_choice: { type: 'tool', name: 'record_observations' },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `검사: ${testType}, 아동: 만 ${age}세 ${sex}. 관찰만 기록.` },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } }
        ]
      }]
    })
  });
  if (!res.ok) throw new Error(`Claude S1 실패: ${res.status}`);
  const data = await res.json();
  const toolUse = (data.content || []).find((c) => c.type === 'tool_use');
  if (!toolUse) throw new Error('S1: tool_use 응답 없음');
  return toolUse.input;
}

// ── S3: 자연어 생성 (전문가 초안 / 학부모 텍스트) ─────────────────
// MVP는 템플릿 기반. 실제 연동 시 Claude messages 호출로 교체(시임 동일).
export async function generateText({ kind, payload }) {
  if (useMock) return mockGenerate({ kind, payload });
  // TODO: 실제 Claude 호출 (kind별 시스템 프롬프트 주입)
  return mockGenerate({ kind, payload });
}

// ── mock 구현 ────────────────────────────────────────────────────
function mockObservations({ testType, imageRef, age }) {
  // 데모: 샘플 HTP 케이스
  if (testType === 'HTP' && imageRef === 'sample-htp') {
    return {
      image_quality: { ok: true, issues: [] },
      observations: [
        { element: 'house.roof', present: true, attributes: { size: 'large' }, note: '지붕이 몸체보다 크게', vision_confidence: 'high' },
        { element: 'house.door', present: true, attributes: { handle: false }, note: '문 손잡이 없음', vision_confidence: 'mid' },
        { element: 'tree.root', present: true, attributes: { emphasis: 'strong' }, note: '뿌리·밑동 강조', vision_confidence: 'mid' },
        { element: 'person.hand', present: false, attributes: {}, note: '손 생략', vision_confidence: 'high' },
        { element: 'person.face', present: true, attributes: { size: 'large', expression: 'smile' }, note: '큰 눈·미소', vision_confidence: 'high' }
      ],
      crisis_flags: []
    };
  }
  // 위기 신호 데모
  const flags = imageRef === 'sample-crisis' ? ['self_harm_imagery'] : [];
  return { image_quality: { ok: true, issues: [] }, observations: [], crisis_flags: flags };
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
