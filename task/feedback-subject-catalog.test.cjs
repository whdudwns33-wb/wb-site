'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const catalog = require('./feedback-subject-catalog.js');

test('과목별 잘한점 30개와 보완할점 10개를 제공한다', () => {
  assert.deepEqual(catalog.SUBJECTS, ['국어', '영어', '수학', '사회', '과학']);

  catalog.SUBJECTS.forEach(subject => {
    assert.equal(catalog.getButtons(subject, 'strength').length, 30, subject + ' 잘한점');
    assert.equal(catalog.getButtons(subject, 'improvement').length, 10, subject + ' 보완할점');
  });
});

test('모든 버튼은 고유 id, 표시명, 격식체 완성문장 20개를 가진다', () => {
  const allIds = new Set();
  let total = 0;

  catalog.SUBJECTS.forEach(subject => {
    ['strength', 'improvement'].forEach(kind => {
      const labels = new Set();
      catalog.getButtons(subject, kind).forEach(option => {
        total += 1;
        assert.match(option.id, /^[a-z0-9-]+$/);
        assert.ok(!allIds.has(option.id), '중복 id: ' + option.id);
        allIds.add(option.id);
        assert.ok(option.label.trim());
        assert.ok(!labels.has(option.label), subject + ' ' + kind + ' 중복 표시명: ' + option.label);
        labels.add(option.label);

        assert.equal(option.sentences.length, 20, option.id);
        assert.strictEqual(option.sentences, option.variants);
        assert.equal(new Set(option.sentences).size, 20, option.id + ' 문장 중복');
        option.sentences.forEach(sentence => {
          assert.equal(sentence, sentence.trim());
          assert.ok(sentence.length <= 100, option.id + ' 문장이 피드백 분량을 과도하게 사용한다');
          assert.match(sentence, /니다\.$/, option.id + ': ' + sentence);
          assert.doesNotMatch(sentence, /[#{}<>]|https?:\/\/|\d{2,3}-\d{3,4}-\d{4}/);
        });
      });
    });
  });

  assert.equal(total, 200);
});

test('없음은 별도 선택지로 유지되어 과목별 개수에 포함되지 않는다', () => {
  assert.deepEqual(catalog.NONE_OPTION, { id: 'none', label: '없음' });
  catalog.SUBJECTS.forEach(subject => {
    assert.equal(catalog.getButtons(subject, 'strength').some(item => item.id === 'none'), false);
    assert.equal(catalog.getButtons(subject, 'improvement').some(item => item.id === 'none'), false);
  });
});

test('기존 컨디션 관리 보완 선택지는 모든 과목에서 유지된다', () => {
  catalog.SUBJECTS.forEach(subject => {
    assert.ok(catalog.getButtons(subject, 'improvement').some(item => item.label === '컨디션 관리'), subject);
  });
});

test('랜덤 값에 따라 준비된 20개 문장 중 하나를 고른다', () => {
  const option = catalog.getButtons('수학', 'strength')[0];
  assert.equal(catalog.pickVariant('수학', 'strength', option.id, () => 0), option.sentences[0]);
  assert.equal(catalog.pickVariant('수학', 'strength', option.id, () => 0.999999), option.sentences[19]);
  assert.equal(catalog.pickVariant('수학', 'strength', option.id, () => Number.NaN), option.sentences[0]);
  assert.equal(catalog.pickVariant('미술', 'strength', option.id, () => 0), '');
});

test('브라우저에서는 WBFeedbackSubjectCatalog 전역으로 노출된다', () => {
  const filePath = path.join(__dirname, 'feedback-subject-catalog.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const browser = {};
  vm.runInNewContext(source, browser, { filename: filePath });

  assert.ok(browser.WBFeedbackSubjectCatalog);
  assert.equal(browser.WBFeedbackSubjectCatalog.getButtons('영어', 'plus').length, 30);
  assert.equal(browser.WBFeedbackSubjectCatalog.getButtons('과학', 'minus').length, 10);
});

test('카탈로그와 승인 문장 목록은 외부에서 변경할 수 없다', () => {
  const option = catalog.CATALOG['국어'].strengths[0];
  assert.equal(Object.isFrozen(catalog.CATALOG), true);
  assert.equal(Object.isFrozen(catalog.CATALOG['국어']), true);
  assert.equal(Object.isFrozen(option), true);
  assert.equal(Object.isFrozen(option.sentences), true);
});
