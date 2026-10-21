// 저장 원장의 4회 단위는 보존하고, 첫 선납 3묶음만 하나의 결제 회차로 보여 준다.
export function initialSessionSize(student) {
  return Number(student && student.sessionInitialCycleSize) === 12 ? 12 : 4;
}

export function tuitionCycleEligible(student, cycle) {
  return initialSessionSize(student) !== 12 || Number(cycle.cycleNo) >= 3;
}

export function billingCycleView(cycles, student) {
  if (initialSessionSize(student) !== 12) return cycles;
  const first = cycles.filter(cycle => cycle.cycleNo <= 3);
  if (!first.length) return [];
  const entries = first.flatMap(cycle => cycle.entries).map((entry, index) => ({ ...entry, sessionNo: index + 1 }));
  return [{
    ...first[0], cycleNo: 1, cycleSize: 12, entries, attendanceCount: entries.length,
    status: entries.length === 12 ? 'complete' : 'open',
    completedAt: entries.length === 12 ? entries[11].date : null
  }, ...cycles.filter(cycle => cycle.cycleNo > 3).map(cycle => ({ ...cycle, cycleNo: cycle.cycleNo - 2, cycleSize: 4 }))];
}
