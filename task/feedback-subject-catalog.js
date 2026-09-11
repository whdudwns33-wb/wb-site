(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBFeedbackSubjectCatalog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SUBJECTS = Object.freeze(['국어', '영어', '수학', '사회', '과학']);
  const NONE_OPTION = Object.freeze({ id: 'none', label: '없음' });

  function withoutFinalMark(value) {
    return String(value == null ? '' : value).trim().replace(/[.!?。！？]+$/g, '');
  }

  function hasBatchim(value) {
    const source = String(value == null ? '' : value).trim();
    if (!source) return false;
    const code = source.charCodeAt(source.length - 1);
    return code >= 0xac00 && code <= 0xd7a3 && ((code - 0xac00) % 28) !== 0;
  }

  function withTopicParticle(value) {
    const source = withoutFinalMark(value);
    return source + (hasBatchim(source) ? '은' : '는');
  }

  // 문장 틀도 데이터와 함께 고정한다. 브라우저에서 즉석 생성형 AI를 호출하지 않고,
  // 교사가 고른 관찰 사실의 범위 안에서만 표현을 바꾸기 위한 20개 승인 문형이다.
  const STRENGTH_PATTERNS = Object.freeze([
    item => item.statement + '.',
    item => '이번 수업에서는 ' + item.statement + '.',
    item => '오늘 학습 과정에서 ' + item.statement + '.',
    item => item.statement + '. 해당 부분에서 안정적인 학습 모습을 보여주었습니다.',
    item => item.statement + '. 이 점이 이번 수업에서 긍정적으로 드러났습니다.',
    item => item.statement + '. 해당 활동을 충실하게 수행한 점이 좋았습니다.',
    item => item.statement + '. 이러한 강점이 학습 과정에서 잘 나타났습니다.',
    item => '수업 중 ' + item.statement + '. 이 과정에서 좋은 학습 역량을 보여주었습니다.',
    item => '학습 내용을 확인하는 과정에서 ' + item.statement + '.',
    item => item.statement + '. 특히 해당 과정에서 보여준 태도와 노력이 돋보였습니다.',
    item => item.statement + '. 이와 같은 긍정적인 모습을 계속 이어가도록 격려하겠습니다.',
    item => item.statement + '. 현재의 좋은 학습 흐름을 꾸준히 유지하도록 지도하겠습니다.',
    item => '이번 학습에서는 ' + item.statement + '. 관련 역량이 자연스럽게 드러났습니다.',
    item => item.statement + '. 이 부분은 앞으로의 학습에도 도움이 되는 강점입니다.',
    item => item.statement + '. 수업에서 확인된 이러한 장점을 지속해서 발전시키겠습니다.',
    item => '오늘 수업에서 확인한 강점은 ' + item.focus + '입니다. 실제 활동에서도 ' + item.statement + '.',
    item => withTopicParticle(item.focus) + ' 수업 과정에서 잘 드러났으며, 관련 활동에서도 ' + item.statement + '.',
    item => item.statement + '. 관련 활동을 수행하는 과정에서도 안정적인 모습을 보여주었습니다.',
    item => item.statement + '. 앞으로도 이 강점을 충분히 활용하도록 수업을 이어가겠습니다.',
    item => item.statement + '. 이러한 모습이 꾸준히 이어지면 앞으로의 학습에 좋은 기반이 됩니다.'
  ]);

  const IMPROVEMENT_PATTERNS = Object.freeze([
    item => item.statement + '.',
    item => '이번 수업에서는 ' + item.statement + '.',
    item => '오늘 학습 과정에서는 ' + item.statement + '.',
    item => item.statement + '. 다음 수업에서도 해당 부분을 이어서 확인하겠습니다.',
    item => item.statement + '. 기초부터 차근차근 연습하도록 지도하겠습니다.',
    item => item.statement + '. 반복 학습을 통해 안정적으로 익히도록 돕겠습니다.',
    item => item.statement + '. 충분한 연습 시간을 두고 보완하겠습니다.',
    item => item.statement + '. 어려움을 느끼는 지점을 세분화하여 지도하겠습니다.',
    item => withTopicParticle(item.focus) + ' 아직 보완할 부분이 있어 관련 활동을 단계적으로 연습하겠습니다.',
    item => item.statement + '. 해당 부분을 차근차근 보완할 수 있도록 다음 수업에서도 꾸준히 연습하겠습니다.',
    item => item.statement + '. 해당 부분을 보완하기 위해 기본 과정부터 다시 확인하겠습니다.',
    item => '보완이 필요한 부분은 ' + item.focus + '입니다. 해당 부분을 반복해서 점검하겠습니다.',
    item => item.statement + '. 익숙해질 때까지 다양한 방식으로 확인하겠습니다.',
    item => item.statement + '. 한 단계씩 차근차근 보완하도록 연습을 이어가겠습니다.',
    item => item.statement + '. 서두르지 않고 해당 부분을 안정적으로 보완하도록 돕겠습니다.',
    item => item.statement + '. 작은 단계부터 성공 경험을 쌓도록 지도하겠습니다.',
    item => item.statement + '. 다음 학습에서는 해당 부분을 중점적으로 다루겠습니다.',
    item => item.statement + '. 현재 학습 상태를 살피며 알맞은 방식으로 보완하겠습니다.',
    item => item.statement + '. 연습 과정의 변화를 꾸준히 살피며 지도하겠습니다.',
    item => item.statement + '. 수업과 복습 과정에서 해당 부분을 지속해서 점검하겠습니다.'
  ]);

  // 컨디션은 학습 기능처럼 "반복해서 익힌다"고 표현할 수 없으므로 전용 문장만 사용한다.
  // 버튼 선택만으로 알 수 없는 질병·원인·회복 시점은 추측하지 않는다.
  const CONDITION_SENTENCES = Object.freeze([
    '오늘은 평소보다 컨디션이 저하되어 학습 집중을 안정적으로 유지하기 어려웠습니다.',
    '오늘 수업에서는 컨디션이 학습 흐름에 영향을 주는 모습이 확인되었습니다.',
    '오늘은 다소 피로한 모습이 보여 충분한 휴식과 컨디션 회복이 필요합니다.',
    '안정적인 학습을 이어가기 위해 수업 전 충분한 휴식과 컨디션 관리가 중요합니다.',
    '컨디션에 따라 집중력이 달라질 수 있어 충분히 쉬고 다음 수업을 준비할 필요가 있습니다.',
    '오늘 확인된 컨디션을 고려하여 무리하지 않고 회복에 신경 써 주시기 바랍니다.',
    '학습 효율을 안정적으로 유지할 수 있도록 수면과 휴식 시간을 충분히 확보해 주시기 바랍니다.',
    '컨디션이 회복된 상태에서 학습에 집중할 수 있도록 생활 리듬을 함께 살펴보겠습니다.',
    '오늘은 컨디션의 영향으로 평소의 학습 역량을 충분히 발휘하기 어려운 모습이었습니다.',
    '다음 수업에서는 컨디션 회복 상태를 살피며 학습 흐름을 차근차근 이어가겠습니다.',
    '컨디션이 좋지 않은 날에는 학습 부담을 무리하게 늘리지 않고 회복을 우선하는 것이 필요합니다.',
    '꾸준한 학습을 위해서는 수업 내용만큼 충분한 휴식과 안정적인 컨디션 관리도 중요합니다.',
    '오늘 수업에서 보인 피로감을 고려해 가정에서도 충분히 쉴 수 있도록 도와주시기 바랍니다.',
    '집중 상태를 안정적으로 유지할 수 있도록 수업 전 식사와 휴식 상태를 함께 점검해 주시기 바랍니다.',
    '컨디션이 학습 참여에 영향을 주지 않도록 다음 수업 전에는 충분한 회복 시간을 갖는 것이 좋겠습니다.',
    '현재의 컨디션을 충분히 회복한 뒤 평소의 학습 흐름으로 자연스럽게 돌아올 수 있도록 돕겠습니다.',
    '오늘은 컨디션 관리가 필요한 모습이 확인되어 가정에서도 휴식 상태를 살펴봐 주시면 좋겠습니다.',
    '학습에 안정적으로 참여할 수 있도록 당분간 컨디션 변화를 세심하게 살펴보겠습니다.',
    '컨디션이 좋아지면 오늘 충분히 집중하기 어려웠던 부분을 다시 확인하며 보완하겠습니다.',
    '충분히 회복한 상태에서 다음 학습을 시작할 수 있도록 오늘은 편안한 휴식을 부탁드립니다.'
  ]);

  function item(id, label, statement, focus, sentences) {
    return { id, label, statement: withoutFinalMark(statement), focus: withoutFinalMark(focus), sentences };
  }

  const RAW_CATALOG = {
    '국어': {
      strengths: [
        item('ko-main-idea', '핵심 내용 파악', '글의 핵심 내용을 정확하게 파악했습니다', '글의 핵심 내용을 파악하는 능력'),
        item('ko-detail', '세부 정보 확인', '글에 제시된 세부 정보를 꼼꼼하게 확인했습니다', '세부 정보를 정확하게 확인하는 능력'),
        item('ko-topic-sentence', '중심 문장 찾기', '문단에서 중심 문장을 알맞게 찾았습니다', '중심 문장을 찾는 능력'),
        item('ko-summary', '문단 요약', '문단의 내용을 간결하게 요약했습니다', '문단의 핵심을 요약하는 능력'),
        item('ko-structure', '글의 구조 파악', '글의 짜임과 전개 구조를 잘 파악했습니다', '글의 구조를 파악하는 능력'),
        item('ko-character', '인물의 마음 이해', '인물의 말과 행동을 바탕으로 마음을 잘 이해했습니다', '인물의 마음을 이해하는 능력'),
        item('ko-sequence', '사건 흐름 정리', '사건이 전개되는 순서를 알맞게 정리했습니다', '사건의 흐름을 정리하는 능력'),
        item('ko-cause-effect', '원인과 결과 파악', '글에 나타난 원인과 결과의 관계를 정확하게 파악했습니다', '원인과 결과를 연결하는 능력'),
        item('ko-evidence', '근거 찾기', '질문에 필요한 근거를 글에서 정확하게 찾았습니다', '글에서 근거를 찾는 능력'),
        item('ko-inference', '내용 추론', '글에 직접 드러나지 않은 내용을 근거를 바탕으로 추론했습니다', '근거를 바탕으로 추론하는 능력'),
        item('ko-context-vocab', '문맥 속 어휘 이해', '문맥을 살펴 낱말의 뜻을 알맞게 이해했습니다', '문맥으로 어휘의 뜻을 파악하는 능력'),
        item('ko-vocab-explain', '낱말 뜻 설명', '배운 낱말의 뜻을 자신의 말로 분명하게 설명했습니다', '낱말의 뜻을 설명하는 능력'),
        item('ko-accurate-reading', '문장 정확히 읽기', '문장을 빠뜨리지 않고 정확하게 읽었습니다', '문장을 정확하게 읽는 능력'),
        item('ko-question-intent', '질문 의도 파악', '질문에서 요구하는 내용을 정확하게 파악했습니다', '질문의 의도를 파악하는 능력'),
        item('ko-own-words', '자기 말로 설명', '읽고 이해한 내용을 자신의 말로 자연스럽게 설명했습니다', '이해한 내용을 자기 말로 설명하는 능력'),
        item('ko-opinion-evidence', '의견과 근거 제시', '자신의 의견과 그에 알맞은 근거를 함께 제시했습니다', '의견을 근거와 함께 표현하는 능력'),
        item('ko-reading-focus', '독서 집중력', '읽기 활동에 집중하며 내용을 끝까지 따라갔습니다', '읽기 활동에 집중하는 힘'),
        item('ko-long-text', '긴 글 끝까지 읽기', '긴 글도 흐름을 놓치지 않고 끝까지 읽었습니다', '긴 글을 끝까지 읽는 힘'),
        item('ko-compare-info', '정보 비교', '두 자료의 공통점과 차이점을 정확하게 비교했습니다', '여러 정보를 비교하는 능력'),
        item('ko-title', '알맞은 제목 정하기', '글의 내용을 잘 드러내는 제목을 알맞게 정했습니다', '글에 알맞은 제목을 정하는 능력'),
        item('ko-theme', '주제 파악', '글쓴이가 전하려는 주제를 정확하게 파악했습니다', '글의 주제를 파악하는 능력'),
        item('ko-expression-effect', '표현 효과 이해', '글에 사용된 표현이 주는 효과를 잘 이해했습니다', '표현의 효과를 이해하는 능력'),
        item('ko-grammar', '문법 개념 적용', '배운 문법 개념을 문제에 정확하게 적용했습니다', '문법 개념을 적용하는 능력'),
        item('ko-spelling', '맞춤법 정확성', '맞춤법과 띄어쓰기를 정확하게 적용했습니다', '맞춤법과 띄어쓰기의 정확성'),
        item('ko-written-answer', '서술형 답안 구성', '질문에 맞는 내용을 갖추어 서술형 답안을 작성했습니다', '서술형 답안을 구성하는 능력'),
        item('ko-writing-organize', '글쓰기 내용 조직', '쓸 내용을 순서에 맞게 논리적으로 조직했습니다', '글의 내용을 조직하는 능력'),
        item('ko-sentence-expression', '문장 표현력', '생각을 의미가 분명한 문장으로 표현했습니다', '생각을 문장으로 표현하는 능력'),
        item('ko-error-cause', '오답 원인 확인', '틀린 문제에서 잘못 이해한 부분을 스스로 확인했습니다', '오답의 원인을 확인하는 능력'),
        item('ko-reread', '스스로 다시 읽기', '이해가 어려운 부분을 스스로 다시 읽고 확인했습니다', '필요한 부분을 다시 읽는 습관'),
        item('ko-presentation', '적극적인 발표', '자신의 생각을 발표 활동에서 적극적으로 표현했습니다', '생각을 적극적으로 발표하는 태도')
      ],
      improvements: [
        item('ko-improve-main-detail', '핵심과 세부 구분', '글의 핵심 내용과 세부 내용을 구분하는 연습이 필요합니다', '핵심과 세부 내용을 구분하는 능력'),
        item('ko-improve-evidence', '근거 찾아 답하기', '답의 근거를 글에서 직접 찾아 확인하는 연습이 필요합니다', '근거를 찾아 답하는 능력'),
        item('ko-improve-context', '문맥으로 어휘 추론', '앞뒤 문맥을 활용해 낱말의 뜻을 추론하는 연습이 필요합니다', '문맥으로 어휘를 추론하는 능력'),
        item('ko-improve-careful', '문장 꼼꼼히 읽기', '문장의 조건과 표현을 빠뜨리지 않고 읽는 연습이 필요합니다', '문장을 꼼꼼하게 읽는 습관'),
        item('ko-improve-complete', '서술형 문장 완성', '서술형 답안을 완전한 문장으로 마무리하는 연습이 필요합니다', '서술형 문장을 완성하는 능력'),
        item('ko-improve-structure', '글의 구조 정리', '문단 사이의 관계를 살펴 글의 구조를 정리하는 연습이 필요합니다', '글의 구조를 정리하는 능력'),
        item('ko-improve-explain', '자기 말로 설명하기', '이해한 내용을 자신의 말로 다시 설명하는 연습이 필요합니다', '자기 말로 설명하는 능력'),
        item('ko-improve-focus', '집중 유지', '긴 글을 읽는 동안 집중을 유지하는 연습이 필요합니다', '읽기 집중을 유지하는 힘'),
        item('ko-improve-spelling', '맞춤법과 띄어쓰기', '글을 쓴 뒤 맞춤법과 띄어쓰기를 점검하는 연습이 필요합니다', '맞춤법과 띄어쓰기의 정확성'),
        item('ko-improve-condition', '컨디션 관리', '안정적인 학습을 위해 충분한 휴식과 수업 전 컨디션 관리가 필요합니다', '학습 컨디션을 관리하는 습관', CONDITION_SENTENCES)
      ]
    },
    '영어': {
      strengths: [
        item('en-spelling', '단어 철자 정확성', '학습한 영어 단어의 철자를 정확하게 썼습니다', '영어 단어 철자의 정확성'),
        item('en-vocab-meaning', '어휘 뜻 이해', '학습한 영어 어휘의 뜻을 정확하게 이해했습니다', '영어 어휘의 뜻을 이해하는 능력'),
        item('en-context-vocab', '문맥 속 어휘 추론', '문맥을 활용해 영어 단어의 뜻을 알맞게 추론했습니다', '문맥으로 어휘를 추론하는 능력'),
        item('en-pronunciation', '정확한 발음', '영어 단어와 문장을 정확한 발음으로 읽었습니다', '영어 발음의 정확성'),
        item('en-intonation', '자연스러운 억양', '영어 문장을 자연스러운 억양으로 읽었습니다', '영어 문장의 억양을 표현하는 능력'),
        item('en-listening-main', '듣기 핵심 파악', '영어 듣기 자료의 핵심 내용을 정확하게 파악했습니다', '영어 듣기의 핵심을 파악하는 능력'),
        item('en-listening-detail', '듣기 세부 정보 확인', '영어 듣기 자료의 세부 정보를 꼼꼼하게 확인했습니다', '영어 듣기의 세부 정보를 확인하는 능력'),
        item('en-grammar', '문법 개념 적용', '배운 영어 문법 개념을 문제에 정확하게 적용했습니다', '영어 문법 개념을 적용하는 능력'),
        item('en-sentence-structure', '문장 구조 파악', '영어 문장의 주요 성분과 구조를 정확하게 파악했습니다', '영어 문장 구조를 파악하는 능력'),
        item('en-tense', '시제 구분', '문맥에 맞는 시제를 정확하게 구분했습니다', '영어 시제를 구분하는 능력'),
        item('en-subject-verb', '주어·동사 찾기', '영어 문장에서 주어와 동사를 정확하게 찾았습니다', '영어 문장의 주어와 동사를 찾는 능력'),
        item('en-translation', '문장 해석', '영어 문장의 의미를 문맥에 맞게 자연스럽게 해석했습니다', '영어 문장을 해석하는 능력'),
        item('en-reading-main', '독해 중심 내용 파악', '영어 지문의 중심 내용을 정확하게 파악했습니다', '영어 지문의 중심 내용을 파악하는 능력'),
        item('en-reading-detail', '독해 세부 내용 확인', '영어 지문에 제시된 세부 내용을 정확하게 확인했습니다', '영어 지문의 세부 내용을 확인하는 능력'),
        item('en-reading-inference', '독해 내용 추론', '영어 지문의 근거를 활용해 내용을 알맞게 추론했습니다', '영어 지문의 내용을 추론하는 능력'),
        item('en-chunking', '긴 문장 끊어 읽기', '긴 영어 문장을 의미 단위로 나누어 정확하게 읽었습니다', '긴 영어 문장을 끊어 읽는 능력'),
        item('en-writing', '영어 문장 쓰기', '배운 표현을 활용해 의미가 분명한 영어 문장을 썼습니다', '영어 문장을 쓰는 능력'),
        item('en-vocab-recall', '어휘 기억', '학습한 영어 어휘를 정확하게 기억해 활용했습니다', '영어 어휘를 기억하고 활용하는 능력'),
        item('en-speaking', '영어로 말하기', '배운 표현을 활용해 영어로 자신의 생각을 말했습니다', '영어로 생각을 표현하는 능력'),
        item('en-response', '질문에 알맞게 답하기', '영어 질문의 의도를 이해하고 알맞게 답했습니다', '영어 질문에 답하는 능력'),
        item('en-self-correction', '스스로 오류 수정', '영어 표현의 오류를 확인하고 스스로 바르게 고쳤습니다', '영어 표현을 스스로 수정하는 능력'),
        item('en-homework', '과제 성실도', '영어 과제를 정해진 범위에 맞게 성실히 수행했습니다', '영어 과제를 수행하는 태도'),
        item('en-read-aloud', '소리 내어 읽기', '영어 지문을 소리 내어 또렷하게 읽었습니다', '영어 지문을 소리 내어 읽는 능력'),
        item('en-dictation', '받아쓰기 정확성', '들은 영어 문장을 정확하게 받아썼습니다', '영어 받아쓰기의 정확성'),
        item('en-paraphrase', '내용 바꾸어 표현하기', '영어 문장의 의미를 유지하며 다른 표현으로 바꾸었습니다', '영어 내용을 바꾸어 표현하는 능력'),
        item('en-application', '배운 표현 활용', '배운 영어 표현을 새로운 문장에 알맞게 활용했습니다', '배운 영어 표현을 활용하는 능력'),
        item('en-error-analysis', '오답 원인 분석', '영어 문제의 오답 원인을 정확하게 확인했습니다', '영어 문제의 오답을 분석하는 능력'),
        item('en-participation', '적극적인 참여', '영어 활동에 적극적으로 참여했습니다', '영어 활동에 참여하는 태도'),
        item('en-confidence', '영어 표현 자신감', '틀릴 것을 두려워하지 않고 영어로 표현했습니다', '영어로 표현하는 자신감'),
        item('en-review', '복습 습관', '배운 영어 어휘와 표현을 스스로 다시 확인했습니다', '영어 학습 내용을 복습하는 습관')
      ],
      improvements: [
        item('en-improve-spelling', '철자 반복 확인', '영어 단어의 철자를 소리와 연결해 반복해서 확인하는 연습이 필요합니다', '영어 단어 철자의 정확성'),
        item('en-improve-vocab', '어휘 복습', '학습한 영어 어휘를 예문과 함께 꾸준히 복습하는 연습이 필요합니다', '영어 어휘를 복습하는 습관'),
        item('en-improve-structure', '문장 구조 분석', '긴 영어 문장에서 주어와 동사를 먼저 찾아 구조를 분석하는 연습이 필요합니다', '영어 문장 구조를 분석하는 능력'),
        item('en-improve-grammar', '문법 적용', '문법 규칙을 문장과 문제에 정확하게 적용하는 연습이 필요합니다', '영어 문법을 적용하는 능력'),
        item('en-improve-listening', '듣기 집중', '영어 듣기에서 핵심어와 세부 정보를 구분해 듣는 연습이 필요합니다', '영어 듣기에 집중하는 능력'),
        item('en-improve-condition', '컨디션 관리', '안정적인 학습을 위해 충분한 휴식과 수업 전 컨디션 관리가 필요합니다', '학습 컨디션을 관리하는 습관', CONDITION_SENTENCES),
        item('en-improve-translation', '직독직해', '영어 문장을 의미 단위로 나누어 순서대로 이해하는 연습이 필요합니다', '영어 문장을 순서대로 이해하는 능력'),
        item('en-improve-writing', '영작 정확성', '문장 성분과 어순을 확인하며 영어 문장을 완성하는 연습이 필요합니다', '영어 문장을 정확하게 쓰는 능력'),
        item('en-improve-speaking', '말하기 자신감', '짧은 문장부터 영어로 직접 말해보는 연습이 필요합니다', '영어로 말하는 자신감'),
        item('en-improve-errors', '오답 복습', '틀린 영어 문제의 근거를 확인하고 다시 풀어보는 연습이 필요합니다', '영어 오답을 복습하는 습관')
      ]
    },
    '수학': {
      strengths: [
        item('math-calculation', '계산 정확성', '계산 과정을 정확하게 수행했습니다', '계산의 정확성'),
        item('math-concept', '개념 이해', '수학 개념의 의미를 정확하게 이해했습니다', '수학 개념을 이해하는 능력'),
        item('math-condition', '문제 조건 파악', '문제에 주어진 조건을 빠짐없이 확인했습니다', '문제의 조건을 파악하는 능력'),
        item('math-equation', '식 세우기', '문제의 관계를 알맞은 식으로 나타냈습니다', '문제에 맞는 식을 세우는 능력'),
        item('math-diagram', '그림으로 표현', '문제의 조건을 그림으로 알맞게 표현했습니다', '문제의 조건을 그림으로 표현하는 능력'),
        item('math-pattern', '규칙 찾기', '수와 도형의 변화를 살펴 규칙을 정확하게 찾았습니다', '수학적 규칙을 찾는 능력'),
        item('math-multiple', '다양한 풀이 시도', '한 문제를 여러 가지 방법으로 해결하려고 시도했습니다', '다양한 풀이를 시도하는 태도'),
        item('math-reasoning', '논리적 추론', '주어진 조건을 연결해 논리적으로 추론했습니다', '수학적으로 추론하는 능력'),
        item('math-explain', '풀이 과정 설명', '풀이 과정을 순서에 맞게 자신의 말로 설명했습니다', '수학 풀이를 설명하는 능력'),
        item('math-check', '답 검산', '풀이를 마친 뒤 계산과 답을 스스로 검산했습니다', '답을 검산하는 습관'),
        item('math-unit', '단위 사용', '문제에 맞는 단위를 정확하게 사용했습니다', '수학 단위를 사용하는 능력'),
        item('math-formula', '공식 활용', '공식의 의미를 이해하고 문제에 알맞게 활용했습니다', '수학 공식을 활용하는 능력'),
        item('math-application', '응용문제 해결', '배운 개념을 응용문제에 알맞게 적용했습니다', '응용문제를 해결하는 능력'),
        item('math-challenge', '고난도 문제 도전', '난이도가 높은 문제에도 포기하지 않고 도전했습니다', '고난도 문제에 도전하는 태도'),
        item('math-error-fix', '오답 스스로 수정', '틀린 풀이의 원인을 찾아 스스로 바르게 고쳤습니다', '수학 오답을 스스로 수정하는 능력'),
        item('math-homework', '과제 성실도', '수학 과제를 정해진 범위에 맞게 성실히 수행했습니다', '수학 과제를 수행하는 태도'),
        item('math-focus', '문제풀이 집중력', '문제를 푸는 동안 집중을 안정적으로 유지했습니다', '수학 문제풀이에 집중하는 힘'),
        item('math-speed', '풀이 속도', '문제에 알맞은 속도로 풀이를 진행했습니다', '수학 풀이 속도를 조절하는 능력'),
        item('math-step-accuracy', '풀이 과정 정확성', '풀이의 각 단계를 빠뜨리지 않고 정확하게 작성했습니다', '수학 풀이 과정의 정확성'),
        item('math-word-problem', '문장제 이해', '문장제의 상황과 필요한 계산을 정확하게 연결했습니다', '수학 문장제를 이해하는 능력'),
        item('math-graph', '그래프 해석', '그래프에 나타난 정보를 정확하게 읽고 해석했습니다', '수학 그래프를 해석하는 능력'),
        item('math-geometry', '도형 관계 파악', '도형의 성질과 관계를 정확하게 파악했습니다', '도형의 관계를 파악하는 능력'),
        item('math-data', '자료 분석', '표와 자료에 나타난 정보를 정확하게 분석했습니다', '수학 자료를 분석하는 능력'),
        item('math-fraction', '수의 관계 이해', '분수와 소수 등 여러 수의 관계를 정확하게 이해했습니다', '여러 수의 관계를 이해하는 능력'),
        item('math-function', '변화 관계 파악', '두 양 사이의 변화 관계를 정확하게 파악했습니다', '수학적 변화 관계를 파악하는 능력'),
        item('math-proof', '근거 있는 풀이', '각 풀이 단계의 근거를 분명하게 제시했습니다', '근거를 갖추어 풀이하는 능력'),
        item('math-unknown', '미지수 활용', '구하려는 값을 미지수로 두고 관계를 정확하게 나타냈습니다', '미지수를 활용하는 능력'),
        item('math-self-solve', '스스로 풀이 완성', '풀이 방향을 스스로 찾아 문제를 끝까지 해결했습니다', '문제를 스스로 해결하는 능력'),
        item('math-question', '적절한 질문', '이해가 필요한 부분을 구체적으로 질문했습니다', '필요한 내용을 질문하는 태도'),
        item('math-persistence', '끝까지 해결하기', '어려운 문제도 충분히 고민하며 끝까지 해결했습니다', '문제를 끝까지 해결하는 힘')
      ],
      improvements: [
        item('math-improve-calculation', '계산 실수 줄이기', '계산 과정을 한 줄씩 확인하며 실수를 줄이는 연습이 필요합니다', '계산의 정확성'),
        item('math-improve-condition', '조건 빠짐없이 확인', '문제의 조건에 표시하며 빠짐없이 확인하는 연습이 필요합니다', '문제 조건을 확인하는 습관'),
        item('math-improve-equation', '식 세우기 연습', '문제의 관계를 식으로 나타내는 연습이 필요합니다', '문제에 맞는 식을 세우는 능력'),
        item('math-improve-explain', '풀이 과정 쓰기', '답뿐만 아니라 풀이 과정을 순서대로 작성하는 연습이 필요합니다', '수학 풀이 과정을 쓰는 능력'),
        item('math-improve-concept', '개념 복습', '문제풀이 전에 관련 개념과 원리를 다시 확인하는 연습이 필요합니다', '수학 개념을 복습하는 습관'),
        item('math-improve-application', '응용문제 접근', '응용문제의 조건을 나누어 풀이 방향을 찾는 연습이 필요합니다', '응용문제에 접근하는 능력'),
        item('math-improve-check', '검산 습관', '풀이를 마친 뒤 식과 답을 검산하는 연습이 필요합니다', '수학 답을 검산하는 습관'),
        item('math-improve-diagram', '그림·표 활용', '문제의 내용을 그림이나 표로 정리하는 연습이 필요합니다', '그림과 표를 활용하는 능력'),
        item('math-improve-condition-care', '컨디션 관리', '안정적인 학습을 위해 충분한 휴식과 수업 전 컨디션 관리가 필요합니다', '학습 컨디션을 관리하는 습관', CONDITION_SENTENCES),
        item('math-improve-errors', '오답 원인 정리', '틀린 이유를 풀이 과정에서 찾아 정리하는 연습이 필요합니다', '수학 오답의 원인을 정리하는 능력')
      ]
    },
    '사회': {
      strengths: [
        item('social-concept', '핵심 개념 이해', '사회 학습의 핵심 개념을 정확하게 이해했습니다', '사회 핵심 개념을 이해하는 능력'),
        item('social-terms', '용어 뜻 설명', '사회 용어의 뜻을 자신의 말로 정확하게 설명했습니다', '사회 용어를 설명하는 능력'),
        item('social-chronology', '시간 순서 정리', '사회·역사 학습에서 다룬 사건을 시간 순서에 맞게 정리했습니다', '사건을 시간 순서로 정리하는 능력'),
        item('social-cause', '원인과 결과 분석', '사회 현상의 원인과 결과를 정확하게 연결했습니다', '사회 현상의 원인과 결과를 분석하는 능력'),
        item('social-map', '지도 활용', '지도에 제시된 위치와 공간 정보를 정확하게 파악했습니다', '사회 학습에서 지도를 활용하는 능력'),
        item('social-chart', '표·그래프 해석', '사회 자료의 표와 그래프를 정확하게 해석했습니다', '사회 자료를 해석하는 능력'),
        item('social-compare', '제도 비교', '여러 사회 제도의 공통점과 차이점을 정확하게 비교했습니다', '사회 제도를 비교하는 능력'),
        item('social-current', '현실 사례 연결', '배운 사회 개념을 현실의 사례와 알맞게 연결했습니다', '사회 개념을 현실 사례와 연결하는 능력'),
        item('social-evidence', '자료에서 근거 찾기', '사회 자료에서 답의 근거를 정확하게 찾았습니다', '사회 자료에서 근거를 찾는 능력'),
        item('social-perspective', '다양한 관점 이해', '사회 문제를 여러 관점에서 살펴보았습니다', '사회 문제를 다양한 관점에서 이해하는 능력'),
        item('social-source', '사료 읽기', '사료에 제시된 핵심 정보를 정확하게 파악했습니다', '사회와 역사 사료를 읽는 능력'),
        item('social-summary', '내용 요약', '배운 사회 내용을 핵심 중심으로 간결하게 요약했습니다', '사회 학습 내용을 요약하는 능력'),
        item('social-opinion', '의견과 근거 제시', '사회 쟁점에 대한 의견과 근거를 함께 제시했습니다', '사회 쟁점에 의견을 제시하는 능력'),
        item('social-facts', '사실 관계 확인', '사회 내용의 사실 관계를 정확하게 확인했습니다', '사회적 사실 관계를 확인하는 능력'),
        item('social-vocab', '핵심 어휘 활용', '배운 사회 핵심 어휘를 답변에 알맞게 활용했습니다', '사회 핵심 어휘를 활용하는 능력'),
        item('social-geography', '지역 특성 파악', '자연환경과 인문환경을 바탕으로 지역의 특성을 파악했습니다', '지역의 특성을 파악하는 능력'),
        item('social-history-person', '인물과 사건 연결', '역사적 인물의 활동을 관련 사건과 정확하게 연결했습니다', '역사적 인물과 사건을 연결하는 능력'),
        item('social-politics-economy', '정치·경제 원리 이해', '정치와 경제의 기본 원리를 사례를 통해 이해했습니다', '정치와 경제 원리를 이해하는 능력'),
        item('social-culture', '문화 다양성 이해', '서로 다른 문화의 특징과 다양성을 존중하며 이해했습니다', '문화의 다양성을 이해하는 태도'),
        item('social-problem', '사회 문제 발견', '자료에서 중요한 사회 문제를 정확하게 찾아냈습니다', '사회 문제를 발견하는 능력'),
        item('social-solution', '해결 방안 제안', '사회 문제에 알맞은 해결 방안을 구체적으로 제안했습니다', '사회 문제의 해결 방안을 제안하는 능력'),
        item('social-textbook', '교과서 자료 해석', '교과서의 사진과 자료가 의미하는 내용을 정확하게 해석했습니다', '사회 교과서 자료를 해석하는 능력'),
        item('social-note', '내용 정리', '배운 사회 내용을 항목별로 알아보기 쉽게 정리했습니다', '사회 내용을 정리하는 능력'),
        item('social-explain', '자기 말로 설명', '배운 사회 개념을 자신의 말로 분명하게 설명했습니다', '사회 개념을 자기 말로 설명하는 능력'),
        item('social-question', '적절한 질문', '이해가 필요한 사회 내용을 구체적으로 질문했습니다', '사회 학습에서 질문하는 태도'),
        item('social-participation', '수업 참여', '사회 수업의 자료 읽기와 활동에 적극적으로 참여했습니다', '사회 수업에 참여하는 태도'),
        item('social-review', '복습 습관', '배운 사회 개념과 용어를 스스로 다시 확인했습니다', '사회 학습 내용을 복습하는 습관'),
        item('social-inference', '자료 기반 추론', '사회 자료의 정보를 연결해 알맞은 결론을 추론했습니다', '사회 자료를 바탕으로 추론하는 능력'),
        item('social-long-text', '긴 자료 읽기', '긴 사회 자료도 핵심을 놓치지 않고 끝까지 읽었습니다', '긴 사회 자료를 읽는 힘'),
        item('social-discussion', '토의 내용 경청', '사회 토의에서 다른 의견을 경청하고 자신의 생각을 표현했습니다', '사회 토의에 참여하는 태도')
      ],
      improvements: [
        item('social-improve-terms', '용어 정확히 익히기', '사회 핵심 용어의 뜻을 사례와 함께 정확히 익히는 연습이 필요합니다', '사회 핵심 용어를 이해하는 능력'),
        item('social-improve-chronology', '사건 순서 정리', '사회·역사 학습에서 다룬 사건의 앞뒤 관계를 순서대로 정리하는 연습이 필요합니다', '사건의 순서를 정리하는 능력'),
        item('social-improve-cause', '인과관계 연결', '사회 현상의 원인과 결과를 구분해 연결하는 연습이 필요합니다', '사회 현상의 인과관계를 파악하는 능력'),
        item('social-improve-map', '지도 읽기', '방위와 범례를 확인하며 지도 정보를 읽는 연습이 필요합니다', '사회 지도를 읽는 능력'),
        item('social-improve-data', '자료 해석', '표와 그래프의 기준을 먼저 확인하고 자료를 해석하는 연습이 필요합니다', '사회 자료를 해석하는 능력'),
        item('social-improve-evidence', '근거 활용', '사회 자료에서 찾은 근거를 답변에 직접 활용하는 연습이 필요합니다', '사회적 근거를 활용하는 능력'),
        item('social-improve-summary', '핵심 요약', '사회 학습 내용에서 중요한 정보만 골라 요약하는 연습이 필요합니다', '사회 내용을 요약하는 능력'),
        item('social-improve-condition', '컨디션 관리', '안정적인 학습을 위해 충분한 휴식과 수업 전 컨디션 관리가 필요합니다', '학습 컨디션을 관리하는 습관', CONDITION_SENTENCES),
        item('social-improve-review', '개념 반복 복습', '배운 사회 개념과 용어를 일정한 간격으로 복습하는 연습이 필요합니다', '사회 개념을 복습하는 습관'),
        item('social-improve-reading', '자료 꼼꼼히 읽기', '사회 자료의 조건과 단서를 빠뜨리지 않고 읽는 연습이 필요합니다', '사회 자료를 꼼꼼하게 읽는 습관')
      ]
    },
    '과학': {
      strengths: [
        item('science-concept', '핵심 개념 이해', '과학의 핵심 개념과 원리를 정확하게 이해했습니다', '과학 개념과 원리를 이해하는 능력'),
        item('science-observation', '세밀한 관찰', '과학 현상과 실험의 변화를 세밀하게 관찰했습니다', '과학 현상을 관찰하는 능력'),
        item('science-classify', '기준에 따른 분류', '대상의 특징을 살펴 알맞은 기준으로 분류했습니다', '과학 대상을 분류하는 능력'),
        item('science-procedure', '실험 순서 이해', '실험의 목적과 순서를 정확하게 이해했습니다', '과학 실험의 순서를 이해하는 능력'),
        item('science-safety', '실험 안전수칙', '실험 안전수칙을 지키며 활동에 참여했습니다', '과학 실험 안전수칙을 지키는 태도'),
        item('science-variable', '변인 구분', '실험에서 변화시키는 조건과 일정하게 유지할 조건을 정확하게 구분했습니다', '과학 실험의 변인을 구분하는 능력'),
        item('science-hypothesis', '가설 설정', '관찰한 내용을 바탕으로 검증할 수 있는 가설을 세웠습니다', '과학적 가설을 세우는 능력'),
        item('science-result', '실험 결과 정리', '실험 결과를 빠짐없이 기록하고 알맞게 정리했습니다', '과학 실험 결과를 정리하는 능력'),
        item('science-data', '자료 해석', '과학 자료에 나타난 정보를 정확하게 읽고 해석했습니다', '과학 자료를 해석하는 능력'),
        item('science-graph', '그래프 분석', '과학 그래프의 변화와 특징을 정확하게 분석했습니다', '과학 그래프를 분석하는 능력'),
        item('science-cause', '원인과 결과 설명', '과학 현상의 원인과 결과를 정확하게 연결해 설명했습니다', '과학 현상의 인과관계를 설명하는 능력'),
        item('science-apply', '현상에 개념 적용', '배운 과학 개념을 새로운 현상에 알맞게 적용했습니다', '과학 개념을 현상에 적용하는 능력'),
        item('science-terms', '과학 용어 활용', '과학 용어를 의미에 맞게 정확하게 사용했습니다', '과학 용어를 활용하는 능력'),
        item('science-diagram', '그림·모형 이해', '과학 그림과 모형이 나타내는 내용을 정확하게 이해했습니다', '과학 그림과 모형을 이해하는 능력'),
        item('science-calculation', '과학 계산 정확성', '공식과 단위를 적용해 과학 계산을 정확하게 수행했습니다', '과학 계산의 정확성'),
        item('science-unit', '단위 사용', '과학량에 맞는 단위를 정확하게 사용했습니다', '과학 단위를 사용하는 능력'),
        item('science-evidence', '근거 있는 설명', '관찰과 자료를 근거로 과학 현상을 설명했습니다', '과학적 근거로 설명하는 능력'),
        item('science-predict', '결과 예측', '주어진 조건을 바탕으로 과학 현상의 결과를 알맞게 예측했습니다', '과학 현상의 결과를 예측하는 능력'),
        item('science-error', '실험 오차 확인', '실험 결과에 영향을 준 오차의 원인을 찾아보았습니다', '과학 실험의 오차를 확인하는 능력'),
        item('science-connect', '개념 연결', '서로 관련된 과학 개념을 정확하게 연결했습니다', '과학 개념을 연결하는 능력'),
        item('science-daily', '생활 속 사례 연결', '배운 과학 원리를 생활 속 사례와 알맞게 연결했습니다', '과학 원리를 생활과 연결하는 능력'),
        item('science-problem', '과학 문제 해결', '주어진 조건을 활용해 과학 문제를 끝까지 해결했습니다', '과학 문제를 해결하는 능력'),
        item('science-step-explain', '과정 설명', '과학 현상이 일어나는 과정을 순서대로 설명했습니다', '과학 현상의 과정을 설명하는 능력'),
        item('science-question', '탐구 질문', '과학 현상에서 궁금한 점을 구체적인 질문으로 표현했습니다', '과학 탐구 질문을 만드는 능력'),
        item('science-participation', '실험 적극성', '과학 실험과 탐구 활동에 적극적으로 참여했습니다', '과학 탐구 활동에 참여하는 태도'),
        item('science-focus', '관찰 집중력', '과학 관찰과 실험 과정에 집중했습니다', '과학 관찰에 집중하는 힘'),
        item('science-review', '개념 복습', '배운 과학 개념과 용어를 스스로 다시 확인했습니다', '과학 개념을 복습하는 습관'),
        item('science-record', '탐구 기록', '탐구 과정과 결과를 알아보기 쉽게 기록했습니다', '과학 탐구 내용을 기록하는 능력'),
        item('science-curiosity', '과학적 호기심', '과학 현상에 관심을 보이며 원리를 알아보려 했습니다', '과학 현상을 탐구하는 태도'),
        item('science-self-correct', '오답 스스로 수정', '과학 문제의 오답 원인을 확인하고 스스로 바르게 고쳤습니다', '과학 오답을 스스로 수정하는 능력')
      ],
      improvements: [
        item('science-improve-concept', '개념과 원리 복습', '과학 용어를 외우는 데 그치지 않고 개념과 원리를 이해하는 연습이 필요합니다', '과학 개념과 원리를 이해하는 능력'),
        item('science-improve-observe', '관찰 내용 구체화', '관찰한 변화를 구체적인 말과 수치로 기록하는 연습이 필요합니다', '과학 관찰 내용을 기록하는 능력'),
        item('science-improve-variable', '변인 구분', '실험에서 변화시키는 조건과 유지할 조건을 구분하는 연습이 필요합니다', '과학 실험의 변인을 구분하는 능력'),
        item('science-improve-data', '자료와 그래프 해석', '과학 자료와 그래프의 기준을 확인하고 변화를 해석하는 연습이 필요합니다', '과학 자료와 그래프를 해석하는 능력'),
        item('science-improve-evidence', '근거로 설명하기', '과학 현상을 관찰 결과와 자료를 근거로 설명하는 연습이 필요합니다', '과학적 근거로 설명하는 능력'),
        item('science-improve-condition', '컨디션 관리', '안정적인 학습을 위해 충분한 휴식과 수업 전 컨디션 관리가 필요합니다', '학습 컨디션을 관리하는 습관', CONDITION_SENTENCES),
        item('science-improve-procedure', '실험 과정 이해', '실험의 목적과 각 단계의 이유를 연결해 이해하는 연습이 필요합니다', '과학 실험 과정을 이해하는 능력'),
        item('science-improve-apply', '개념 적용', '배운 과학 개념을 다양한 현상과 문제에 적용하는 연습이 필요합니다', '과학 개념을 적용하는 능력'),
        item('science-improve-errors', '오답 원인 정리', '과학 문제에서 틀린 이유를 관련 개념과 연결해 정리하는 연습이 필요합니다', '과학 오답의 원인을 정리하는 능력'),
        item('science-improve-review', '누적 복습', '앞서 배운 과학 개념을 새 내용과 함께 꾸준히 복습하는 연습이 필요합니다', '과학 개념을 누적해서 복습하는 습관')
      ]
    }
  };

  function hydrate(rawItem, patterns) {
    const sentences = Object.freeze(Array.isArray(rawItem.sentences)
      ? rawItem.sentences.slice()
      : patterns.map(pattern => pattern(rawItem)));
    return Object.freeze({
      id: rawItem.id,
      label: rawItem.label,
      sentences,
      // 기존 호출부가 variants라는 이름을 사용해도 같은 승인 문장 목록을 보도록 한다.
      variants: sentences
    });
  }

  const CATALOG = Object.freeze(SUBJECTS.reduce((result, subject) => {
    result[subject] = Object.freeze({
      strengths: Object.freeze(RAW_CATALOG[subject].strengths.map(entry => hydrate(entry, STRENGTH_PATTERNS))),
      improvements: Object.freeze(RAW_CATALOG[subject].improvements.map(entry => hydrate(entry, IMPROVEMENT_PATTERNS)))
    });
    return result;
  }, {}));

  function normalizeKind(kind) {
    const value = String(kind == null ? '' : kind).trim().toLowerCase();
    if (['strength', 'strengths', 'plus', 'good'].includes(value)) return 'strengths';
    if (['improvement', 'improvements', 'minus', 'need'].includes(value)) return 'improvements';
    return '';
  }

  function getButtons(subject, kind) {
    const group = CATALOG[String(subject == null ? '' : subject).trim()];
    const normalizedKind = normalizeKind(kind);
    if (!group || !normalizedKind) return [];
    return group[normalizedKind].slice();
  }

  function findButton(subject, kind, buttonId) {
    const id = String(buttonId == null ? '' : buttonId).trim();
    return getButtons(subject, kind).find(entry => entry.id === id) || null;
  }

  function getVariants(subject, kind, buttonId) {
    const selected = findButton(subject, kind, buttonId);
    return selected ? selected.sentences.slice() : [];
  }

  function pickVariant(subject, kind, buttonId, random) {
    const variants = getVariants(subject, kind, buttonId);
    if (!variants.length) return '';
    const draw = typeof random === 'function' ? Number(random()) : Math.random();
    const safeDraw = Number.isFinite(draw) ? Math.max(0, Math.min(0.999999999999, draw)) : 0;
    return variants[Math.floor(safeDraw * variants.length)];
  }

  return Object.freeze({
    SUBJECTS,
    NONE_OPTION,
    CATALOG,
    getButtons,
    getVariants,
    pickVariant
  });
});
