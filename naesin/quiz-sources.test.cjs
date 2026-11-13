'use strict';
/* 문제 자료 이름표: 중1·2와 중3은 같은 파일 번호가 다른 자료다(예: 05 = 예상문제 1회 / 기본학습 빈칸).
   학년별 목록이 실제 팩 source 를 모두 덮고, 중3이 중1·2 이름으로 보이지 않는지 본다. */
const fs = require('fs'), path = require('path'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const list = name => new Function('return ' + html.match(new RegExp('var ' + name + ' = (\\[[\\s\\S]*?\\]\\]);'))[1])();
const m12 = list('QUIZ_SOURCES_M12'), m3 = list('QUIZ_SOURCES_M3');
const codes = l => l.map(e => e[0]);
assert.deepStrictEqual(codes(m12), ['00', '02', '04', '05', '06', '07', '08', '09']);
assert.deepStrictEqual(codes(m3), ['02', '03', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16']);
for (const l of [m12, m3]) assert.strictEqual(new Set(l.map(e => e[1])).size, l.length, '이름 중복');
assert.strictEqual(m3.find(e => e[0] === '05')[1], '기본학습 빈칸');
assert.ok(/function quizSources\(\) \{ return pack && \/\^\(\?:m3\|중3\)\$\/\.test\(pack\.grade\)/.test(html), '학년으로 목록을 고른다');
assert.ok(!/QUIZ_SOURCES\./.test(html), '옛 단일 목록을 쓰는 곳이 남지 않았다');
console.log('quiz-sources ok');

/* 결과 화면 정답 줄: 허용 답 변형(구분자·따옴표·->)은 한 번만 보인다 */
const shown = new Function('return ' + html.match(/function shownAnswers\(list\)\{[\s\S]*?\}\);\}/)[0])();
assert.deepStrictEqual(shown(['languages / requirements / for fun', 'languages/requirements/for fun', 'languages, requirements, for fun', 'languages requirements for fun']), ['languages / requirements / for fun']);
assert.deepStrictEqual(shown(['for', 'since → for', 'since -> for']), ['for', 'since → for']);
assert.deepStrictEqual(shown(['knocking', 'knock']), ['knocking', 'knock']);
assert.deepStrictEqual(shown(['don’t know', "don't know"]), ['don’t know']);
console.log('shown-answers ok');
