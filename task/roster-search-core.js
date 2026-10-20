'use strict';
(function(root) {
  function search(students, query) {
    var term = String(query || '').normalize('NFKC').replace(/\s/g, '').toLowerCase();
    if (!term) return [];
    return (students || []).filter(function(s) {
      return String(s.name || '').normalize('NFKC').replace(/\s/g, '').toLowerCase().includes(term);
    }).slice().sort(function(a, b) {
      return String(a.name).localeCompare(String(b.name), 'ko') ||
        String(a.school || '').localeCompare(String(b.school || ''), 'ko') ||
        String(a.id || '').localeCompare(String(b.id || ''));
    });
  }
  var api = { search: search };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WBRosterSearch = api;
})(typeof window !== 'undefined' ? window : null);
