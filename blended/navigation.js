'use strict';
window.blendedNavigation = (role, student, active, planner = false) => {
  const sid = encodeURIComponent(student || '');
  const staff = ['owner','admin','teacher'].includes(role);
  const item = (key, label, core = false) => {
    const current = core ? !planner && active === key : planner && (active === key || key === 'month' && active === 'academic');
    const inCurrentApp = core ? !planner : planner;
    const attr = inCurrentApp ? `data-${core ? 'tab' : 'go'}="${key}"` : `href="/blended/${core ? '?' : 'planner/?'}student=${sid}#/${key}"`;
    const tag = attr.startsWith('href') ? 'a' : 'button';
    return `<${tag} ${attr}${current ? ' aria-current="page"' : ''}>${label}</${tag}>`;
  };
  if(role === 'guardian') return '';
  return `<nav class="blended-navigation" aria-label="전체 플래너 메뉴"><div class="blended-primary">${item('today','오늘')}${item('week','주간')}${item('month','일정·학사')}${item(staff ? 'consultations' : 'reports','상담·리포트',true)}<details class="blended-menu"><summary>전체 메뉴</summary><div class="blended-menu-items">${[['guide','사용 안내'],['roadmap','로드맵'],['ingang','인강'],['study','학습'],...(staff ? [['write','학습 배부'],['board','학생 현황']] : [])].map(([k,v])=>item(k,v)).join('')}${item('learning',staff ? '담당 학습' : '오늘 학습',true)}${staff ? item('reports','리포트',true) : ''}${['owner','admin'].includes(role) ? item('management','강사·학생 관리',true) : ''}${item('account','내 계정',true)}</div></details></div></nav>`;
};
