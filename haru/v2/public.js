'use strict';
(function () {
  if (!window.HaruCatalog) return;
  const grade = document.getElementById('grade'), field = document.getElementById('field');
  if (grade && field) {
    const rows = [...document.querySelectorAll('[data-course]')];
    const filter = () => {
      let count = 0;
      for (const row of rows) {
        const visible = window.HaruCatalog.matches({ grades: row.dataset.grades.split(',').map(Number), fields: row.dataset.fields.split('|') }, grade.value, field.value);
        row.hidden = !visible;
        if (visible) count++;
      }
      document.getElementById('result-count').textContent = count + '개 과정 후보 · 지원 가능 판정이 아닙니다';
      document.getElementById('empty').hidden = count !== 0;
    };
    grade.addEventListener('change', filter); field.addEventListener('change', filter);
    document.getElementById('reset').addEventListener('click', () => { grade.value = ''; field.value = ''; filter(); });
    filter();
  }
  for (const item of document.querySelectorAll('[data-end]')) {
    item.querySelector('.phase').textContent = window.HaruCatalog.phase({ start: item.dataset.start, end: item.dataset.end, kind: item.dataset.kind });
  }
})();
