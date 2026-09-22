'use strict';
/* 실제 인라인 핸들러를 작은 DOM 대역으로 실행한다. 네이티브 dialog의 Tab/Esc 동작은 브라우저에서 확인한다. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const L = require('./letter.js');
const ISSUE = require('./issue-sample.json');
const html = fs.readFileSync(require('node:path').join(__dirname, 'index.html'), 'utf8');
const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
const between = (start, end) => {
  const a = script.indexOf(start), b = script.indexOf(end, a);
  assert.ok(a >= 0 && b > a, '실제 UI 핸들러를 찾지 못했다');
  return script.slice(a, b);
};
const nodes = {}, events = {}, dialogs = [];
const opener = { isConnected: true, focus() { this.focused = true; } };
const context = {
  L, ISSUE, TIER: 'K', esc: L.esc,
  $(id) { return nodes[id] || (id === 'pdfSheet' ? null : (nodes[id] = { innerHTML: '' })); },
  document: {
    activeElement: opener,
    body: { appendChild(node) { dialogs.push(node); if (node.id) nodes[node.id] = node; } },
    createElement(tag) {
      return {
        tag, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; },
        showModal() { this.open = true; },
        close() { this.open = false; this.onclose(); },
        remove() { this.removed = true; if (this.id) delete nodes[this.id]; },
      };
    },
  },
  window: { addEventListener(name, fn) { events[name] = fn; }, print() { events.beforeprint(); }, scrollTo() {}, scrollY: 10 },
  setTimeout(fn) { fn(); },
};
vm.createContext(context);
vm.runInContext(between('    function openDialog(', '    function afterRender('), context);
vm.runInContext(between('    var PRINT_KEY = true;', '    /* ── 학생 연동 카드'), context);

// Ctrl+P 경로도 현재 호·학년대로 준비하고, 전용 버튼의 정답 옵션을 덮어쓰지 않는다.
events.beforeprint();
assert.ok(nodes.printArea.innerHTML.includes('유치판'));
assert.ok(nodes.printArea.innerHTML.includes('정답과 해설'));
context.ISSUE = { ...ISSUE, title: '지금 보고 있는 새 호' };
context.TIER = 'M';
events.beforeprint();
assert.ok(nodes.printArea.innerHTML.includes('지금 보고 있는 새 호'));
assert.ok(nodes.printArea.innerHTML.includes('중등판'));
context.printIssue(false);
assert.ok(!nodes.printArea.innerHTML.includes('정답과 해설'));
context.TIER = 'all';
events.beforeprint();
assert.equal((nodes.printArea.innerHTML.match(/class="np print"/g) || []).length, 5);
context.printIssue(true);
assert.ok(nodes.printArea.innerHTML.includes('정답과 해설'));

// PDF와 사진 모두 모달로 열리고 닫으면 호출한 단추로 돌아온다.
nodes.btnPdf.onclick();
let dialog = dialogs.at(-1);
assert.equal(dialog.tag, 'dialog');
assert.equal(dialog.open, true);
assert.equal(dialog.attrs['aria-labelledby'], 'pdfTitle');
nodes.pdfClose.onclick();
assert.ok(dialog.removed && opener.focused);
opener.focused = false;
const img = { alt: '자체 제작 달 그림', getAttribute() { return 'img/moon.svg'; } };
context.openZoom({ querySelector(selector) { return selector === 'img' ? img : null; } });
dialog = dialogs.at(-1);
assert.equal(dialog.tag, 'dialog');
assert.equal(dialog.open, true);
dialog.close();
assert.ok(dialog.removed && opener.focused);

// 다시 그려진 퀴즈 해설/정답 단추에 초점이 이어져야 한다.
let click, focused = '', drawn = 0;
const state = { quiz: {}, reveal: {} };
context.app = {
  addEventListener(name, fn) { click = fn; },
  querySelector(selector) { return { focus() { focused = selector; } }; },
};
context.issueState = () => state;
context.push = () => {};
context.showIssue = () => { drawn += 1; };
vm.runInContext(between("    app.addEventListener('click'", '    var writeTimer'), context);
function answer(attr, value) {
  const button = { hasAttribute(name) { return name === attr; }, getAttribute() { return value; } };
  click({ target: { closest(selector) { return selector === '[data-q],[data-ans]' ? button : null; } } });
}
answer('data-q', 'read-k:0:1');
assert.equal(drawn, 1);
assert.equal(focused, '[data-feedback="read-k:0"]');
answer('data-ans', 'brain-k:0');
assert.equal(drawn, 2);
assert.equal(focused, '[data-ans="brain-k:0"]');
assert.ok(/id="btnPdf"[^>]*aria-label="PDF로 저장"/.test(html));
assert.doesNotThrow(() => new Function(script));
console.log('letter UI: 기본 인쇄·현재 호·정답 옵션·모달 복귀·퀴즈 초점 통과');
