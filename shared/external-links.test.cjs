const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const links = require('./external-links.js');

/* 계약 §2에 고정된 키 — 팩·서버·UI가 같은 문자열을 쓴다. 하나라도 바뀌면 팩 검증이 깨진다. */
const CONTRACT_KEYS = [
  'studyforce_admin', 'classcard_teacher', 'classcard_app_android', 'classcard_app_ios',
  'metamath_center', 'metamath_student', 'nelt_org', 'leaders_eye', 'exam4you', 'jokbo'
];

test('every contract key exists and no extra key sneaks in', () => {
  assert.deepEqual(links.keys().sort(), CONTRACT_KEYS.slice().sort());
});

test('every link is https with a label and a program', () => {
  links.keys().forEach(k => {
    const row = links.linkFor(k);
    assert.ok(row, k);
    assert.equal(row.key, k);
    assert.ok(/^https:\/\//.test(row.url), k + ' must be https');
    assert.ok(row.label.length >= 2, k + ' label');
    assert.ok(row.program, k + ' program');
    assert.equal(links.isApprovedLink(row.url), true, k + ' approves itself');
  });
});

test('unknown or malformed keys return null instead of throwing', () => {
  ['', null, undefined, 'STUDYFORCE_ADMIN', 'toString', '__proto__', 'x'.repeat(50), 'a b'].forEach(k => {
    assert.equal(links.linkFor(k), null, String(k));
  });
  assert.equal(links.programOf('nope'), '');
  assert.equal(links.programOf('jokbo'), 'jokbo');
});

/* consult·task가 들고 있던 상수와 같은 주소여야 한다 — 두 앱이 다른 곳으로 보내면 안 된다. */
test('urls match the constants that consult and task already ship', () => {
  const root = path.join(__dirname, '..');
  const consult = fs.readFileSync(path.join(root, 'consult', 'index.html'), 'utf8');
  const task = fs.readFileSync(path.join(root, 'task', 'index.html'), 'utf8');
  const constant = name => {
    const m = consult.match(new RegExp('const ' + name + " = '([^']+)'"));
    assert.ok(m, name + ' constant exists in consult');
    return m[1];
  };
  assert.equal(links.LINKS.studyforce_admin.url, constant('STUDYFORCE_URL'));
  assert.equal(links.LINKS.metamath_center.url, constant('METAMATH_CENTER_URL'));
  assert.equal(links.LINKS.metamath_student.url, constant('METAMATH_STUDENT_URL'));
  assert.equal(links.LINKS.classcard_app_android.url, constant('CLASSCARD_ANDROID_APP_URL'));
  assert.equal(links.LINKS.classcard_app_ios.url, constant('CLASSCARD_IOS_APP_URL'));
  assert.equal(links.LINKS.leaders_eye.url, constant('LEADERS_EYE_URL'));
  assert.ok(task.includes('href="' + links.LINKS.classcard_teacher.url + '"'), 'task student portal uses the same classcard login');
  /* 넬트는 기관 페이지가 (가정)이라 호스트만 같으면 된다. */
  assert.equal(new URL(links.LINKS.nelt_org.url).hostname, new URL(constant('NELT_EXAM_URL')).hostname);
});

test('hosts() is the sorted unique host list', () => {
  const h = links.hosts();
  assert.deepEqual(h, h.slice().sort());
  assert.equal(new Set(h).size, h.length);
  assert.ok(h.includes('hol.sfcenter.co.kr'));
  assert.ok(h.includes('www.classcard.net'));
  assert.ok(h.includes('new.mmath.co.kr'));
});

test('isApprovedLink refuses http, foreign hosts, credentials and junk', () => {
  assert.equal(links.isApprovedLink('http://www.classcard.net/Login'), false, 'http');
  assert.equal(links.isApprovedLink('https://evil.example.com/'), false, 'foreign host');
  assert.equal(links.isApprovedLink('https://user:pw@www.classcard.net/'), false, 'credentials');
  assert.equal(links.isApprovedLink('https://www.classcard.net.evil.com/'), false, 'suffix trick');
  assert.equal(links.isApprovedLink('javascript:alert(1)'), false, 'scheme');
  assert.equal(links.isApprovedLink(''), false);
  assert.equal(links.isApprovedLink(null), false);
  assert.equal(links.isApprovedLink('https://www.classcard.net/set/123 4'), false, 'whitespace');
  assert.equal(links.isApprovedLink('https://www.classcard.net/set/1234'), true, 'deep path on approved host');
  assert.equal(links.isApprovedLink('https://www.classcard.net/set/my-set_1?tab=a-b'), true, 'hyphens and query are fine');
  assert.equal(links.isApprovedLink('https://WWW.CLASSCARD.NET/set/1'), true, 'host is case-insensitive');
});

test('classcardAppUrl follows the consult rule', () => {
  assert.equal(links.classcardAppUrl('Mozilla/5.0 (Linux; Android 13; SM-T500)'), links.LINKS.classcard_app_android.url);
  assert.equal(links.classcardAppUrl('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'), links.LINKS.classcard_app_ios.url);
  assert.equal(links.classcardAppUrl('Mozilla/5.0 (Macintosh; Intel Mac OS X)', 5), links.LINKS.classcard_app_ios.url, 'iPadOS desktop UA');
  assert.equal(links.classcardAppUrl('Mozilla/5.0 (Macintosh; Intel Mac OS X)', 0), '');
  assert.equal(links.classcardAppUrl('Mozilla/5.0 (Windows NT 10.0)'), '');
  assert.equal(links.classcardAppUrl(''), '');
});

test('LINKS table is frozen so a page cannot rewrite a destination at runtime', () => {
  assert.ok(Object.isFrozen(links.LINKS));
  assert.ok(Object.isFrozen(links.LINKS.jokbo));
  assert.throws(() => { 'use strict'; links.LINKS.jokbo.url = 'https://evil.example.com/'; });
});
