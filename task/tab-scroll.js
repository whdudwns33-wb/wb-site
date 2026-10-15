'use strict';
var TaskTabScroll = (function () {
  function bounds(left, width, total) {
    var max = Math.max(0, total - width);
    return { overflow: max > 1, left: left > 1, right: left < max - 1 };
  }
  function revealDelta(view, item) {
    if (item.left < view.left) return item.left - view.left;
    if (item.right > view.right) return item.right - view.right;
    return 0;
  }
  function init() {
    var tabs = document.getElementById('tabs');
    var prev = document.getElementById('tabScrollLeft');
    var next = document.getElementById('tabScrollRight');
    if (!tabs || !prev || !next) return;
    var activeKey = null, pending = false;
    function reveal(item) {
      if (!item) return;
      tabs.scrollLeft += revealDelta(tabs.getBoundingClientRect(), item.getBoundingClientRect());
    }
    function update() {
      pending = false;
      // 양 끝에서도 버튼 자리는 유지하여 너비 변화로 스크롤이 흔들리지 않게 한다.
      var shell = tabs.parentElement;
      var style = window.getComputedStyle(shell);
      var available = shell.clientWidth - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0);
      var overflow = tabs.scrollWidth > available + 1;
      prev.hidden = next.hidden = !overflow;
      var selected = tabs.querySelector('.tab.on');
      var key = selected ? selected.getAttribute('data-go') : '';
      // 동기화 재렌더 때 사용자가 옆 메뉴를 살펴보던 위치는 되돌리지 않는다.
      if (key !== activeKey) { activeKey = key; reveal(selected); }
      var state = bounds(tabs.scrollLeft, tabs.clientWidth, tabs.scrollWidth);
      prev.disabled = !state.left;
      next.disabled = !state.right;
    }
    function queue() {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(update);
    }
    function move(direction) {
      tabs.scrollLeft += direction * Math.max(120, tabs.clientWidth * 0.75);
      queue();
    }
    prev.addEventListener('click', function () { move(-1); });
    next.addEventListener('click', function () { move(1); });
    tabs.addEventListener('scroll', queue, { passive: true });
    tabs.addEventListener('focusin', function (event) { reveal(event.target.closest('.tab')); queue(); });
    window.addEventListener('resize', function () { reveal(tabs.querySelector('.tab.on')); queue(); });
    new MutationObserver(queue).observe(tabs, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    if (window.ResizeObserver) new ResizeObserver(queue).observe(tabs);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(queue);
    queue();
  }
  return { bounds: bounds, revealDelta: revealDelta, init: init };
}());
if (typeof module !== 'undefined' && module.exports) module.exports = TaskTabScroll;
if (typeof document !== 'undefined') TaskTabScroll.init();
