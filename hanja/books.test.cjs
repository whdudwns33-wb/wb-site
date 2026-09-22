'use strict';
/* 저장소에 든 자체 단어장 검사 (node hanja/books.test.cjs)
 *
 * hanja/books/ 는 학원이 직접 쓴 단어장이다(교과 어휘). 구매 교재와 달리 저장소에 살 수 있고,
 * 그래서 고치다 망가뜨릴 수도 있다 — 업로드 관문과 같은 규칙(book-check)으로 여기서 먼저 막는다.
 * 자체 자료에는 경고도 남기지 않는다: 예문에 낱말이 없거나 훈음이 빈 한자는 우리가 고칠 수 있는 것이고,
 * 그대로 두면 문맥 빈칸·한자 조립 문항이 조용히 빠진 채 학생에게 간다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const B = require('./book-check.js');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };
const DIR = path.join(__dirname, 'books');
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort() : [];

t('자체 단어장이 저장소에 있다', () => {
  assert.ok(files.length >= 4, 'hanja/books/ 에 단어장이 ' + files.length + '개뿐이다');
});

const books = files.map((f) => ({ file: f, raw: JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) }));

t('업로드 관문과 같은 규칙으로 오류·경고 0', () => {
  books.forEach(({ file, raw }) => {
    const res = B.checkBook(raw);
    assert.deepStrictEqual(res.errors, [], file + ' 오류: ' + JSON.stringify(res.errors));
    assert.deepStrictEqual(res.warns, [], file + ' 경고: ' + JSON.stringify(res.warns));
    assert.ok(res.ok, file + ' 가 통과하지 못했다');
    const again = B.checkBook(res.book); // 학생 앱은 업로드 때 정규화한 단어장을 다시 검사한다.
    assert.deepStrictEqual(again.errors, [], file + ' 재검사 오류');
    assert.deepStrictEqual(again.warns, [], file + ' 재검사 경고');
    assert.deepStrictEqual(again.book, res.book, file + ' 재검사로 내용이 달라졌다');
  });
});

t('종류는 자체(own) — AI 연상이 열리고, 교재 뜻 문장이 아니다', () => {
  books.forEach(({ file, raw }) => {
    const book = B.checkBook(raw).book;
    assert.strictEqual(book.source, 'own', file + ' 의 종류가 own 이 아니다');
    assert.ok(B.aiAllowed(book), file + ' 에서 AI 연상이 닫혀 있다');
  });
});

t('id 가 겹치지 않고, 낱말마다 뜻·예문이 있다 (낱말 단어장)', () => {
  const ids = new Set();
  books.forEach(({ file, raw }) => {
    const book = B.checkBook(raw).book;
    assert.ok(!ids.has(book.id), '단어장 id 가 겹친다: ' + book.id);
    ids.add(book.id);
    book.words.forEach((w) => {
      assert.ok(w.meaning && w.meaning.length >= 5, file + ' 의 「' + w.word + '」 뜻이 너무 짧다');
      assert.ok(w.example, file + ' 의 「' + w.word + '」 에 예문이 없다 — 문맥 빈칸 문항이 안 나온다');
    });
  });
});

t('한자어의 한자에는 훈음이 다 있다 — 한자 조립·따라쓰기가 열리게', () => {
  books.forEach(({ file, raw }) => {
    const book = B.checkBook(raw).book;
    book.words.filter((w) => w.type === 'hanja').forEach((w) => {
      (w.parts || []).forEach((p) => {
        assert.ok(p.hun && p.eum, file + ' 의 「' + w.word + '」 에서 ' + p.ch + ' 의 훈음이 비었다');
      });
    });
    book.chars.forEach((c) => assert.ok(c.hun && c.eum, file + ' 의 글자 ' + c.ch + ' 에 훈음이 없다'));
  });
});

t('단원이 비어 있지 않다 — 이번 주 단원으로 지정할 수 있게', () => {
  books.forEach(({ file, raw }) => {
    const book = B.checkBook(raw).book;
    assert.ok(book.units.length >= 2, file + ' 의 단원이 ' + book.units.length + '개뿐이다');
    book.units.forEach((u) => {
      /* 급수 배정한자처럼 낱말이 없는 단어장은 글자로 센다 — 단원의 학습 항목은 낱말 + 직접 적은 글자다 */
      const n = book.words.filter((w) => w.unit === u.id).length
        + book.chars.filter((c) => !c.derived && c.unit === u.id).length;
      assert.ok(n >= 5, file + ' 의 단원 「' + u.title + '」 에 학습 항목이 ' + n + '개뿐이다');
    });
  });
});

t('급수 배정한자 단어장은 글자마다 훈음·획수·예시 낱말이 있다', () => {
  /* 급수 대비는 글자가 주인공이다. 획수가 없으면 획수 문항이, 예시 낱말이 없으면
     「이 글자가 든 낱말」 문항이 빠져 문항이 훈음 고르기 하나로 줄어든다. */
  const geupsu = books.filter(({ raw }) => /geupsu/.test(raw.id || '') || /급수/.test(raw.title || ''));
  assert.ok(geupsu.length >= 2, '급수 단어장이 ' + geupsu.length + '개뿐이다');
  geupsu.forEach(({ file, raw }) => {
    const book = B.checkBook(raw).book;
    assert.ok(book.words.length === 0, file + ' 은 글자만 담는 단어장이어야 한다');
    assert.ok(book.chars.length >= 50, file + ' 의 글자가 ' + book.chars.length + '자뿐이다');
    book.chars.forEach((c) => {
      assert.ok(c.strokes >= 1, file + ' 의 ' + c.ch + ' 에 획수가 없다');
      assert.ok((c.words || []).length >= 2, file + ' 의 ' + c.ch + ' 에 예시 낱말이 모자란다');
      assert.ok(!c.derived, file + ' 의 ' + c.ch + ' 가 끌어낸 글자로 잡혔다 — 급수 글자는 직접 적은 항목이어야 한다');
    });
  });
});

t('8급 50자 + 7급 추가 100자는 공식 배정 범위와 같다', () => {
  /* 한국어문회 배정한자 7급 HWP, 2026-09-22 대조. 7급은 8급·7급II를 포함한 150자다.
     https://www.hanja.re.kr/kccpt/exam/levelConfirm.do
     개수만 세면 다른 급수 글자로 바뀌어도 통과하므로 집합과 중복을 함께 검사한다. */
  const lists = {
    'geupsu-8.json': '校敎九國軍金南女年大東六萬母木門民白父北四山三生西先小水室十五王外月二人一日長弟中靑寸七土八學韓兄火',
    'geupsu-7.json': '家歌間江車工空口旗氣記男內農答道冬動同洞登來力老里林立每面名命問文物方百夫不事算上色夕姓世少所手數市時植食心安語然午右有育邑入子字自場全前電正祖足左主住重地紙直千天川草村秋春出便平下夏漢海花話活孝後休',
  };
  const all = [];
  Object.entries(lists).forEach(([file, expected]) => {
    const raw = books.find((b) => b.file === file).raw;
    const chars = raw.chars.map((c) => c.ch.normalize('NFKC')).sort();
    assert.deepStrictEqual(chars, [...expected].sort(), file + ' 공식 배정 목록 불일치');
    all.push(...chars);
  });
  assert.strictEqual(all.length, 150);
  assert.strictEqual(new Set(all).size, 150, '8급과 7급 추가 글자가 겹친다');
});

t('체험 48낱말은 학습 예문과 다른 창작 상황·해설을 갖추고 왕복해도 보존된다', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'book-sample.json'), 'utf8'));
  const one = B.checkBook(raw), two = B.checkBook(JSON.parse(JSON.stringify(one.book)));
  assert.ok(one.ok && two.ok, JSON.stringify(one.errors.concat(two.errors)));
  assert.deepStrictEqual(one.warns, []);
  assert.deepStrictEqual(two.warns, []);
  assert.deepStrictEqual(two.book, one.book);
  assert.strictEqual(raw.source, 'own');
  assert.ok(/자체 창작/.test(raw.note));
  assert.strictEqual(raw.words.length, 48);
  raw.words.forEach((w) => {
    assert.ok(w.context && w.context.explanation, w.word + ' 의 상황·해설이 없다');
    assert.ok(w.example && !w.context.prompt.includes(w.example), w.word + ' 의 학습 예문을 시험에 그대로 썼다');
    assert.ok(!/[\u3400-\u9fff]/.test(JSON.stringify(w.context)), w.word + ' 의 어휘 적용 문제에 한자가 들어갔다');
  });
  const wordUnits = new Set(raw.words.map((w) => w.unit));
  raw.units.filter((u) => wordUnits.has(u.id)).forEach((u) => assert.ok(!/^(한자어|고유어)\s*—/.test(u.title), '어종이 주제 제목에 남았다: ' + u.title));
});

console.log(`\nOK — ${passed}개 통과`);
