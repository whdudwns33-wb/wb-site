/* 기존 하루 관리자 계약만 개인 계정에 연다. */
const routes = {
  GET: ['students', 'packs', 'paperkeys', 'plans', 'plan', 'atoms', 'board', 'map', 'reports', 'export'],
  POST: ['enroll', 'pack', 'paperkey', 'paper', 'plan', 'cohort', 'atoms', 'parentlink', 'reports/resolve', 'purge'],
  DELETE: ['pack', 'plan'],
};
export function allowedStaffRoute(method, path) {
  return routes[method]?.some(p => path === '/api/haru/admin/' + p) || false;
}
