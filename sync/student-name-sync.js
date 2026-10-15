// 이름은 표시용 스냅샷이다. 연결 ID와 출결·메모·시간표는 바꾸지 않는다.
export function renamedLessonTask(task, studentId, oldName, newName, updatedAt) {
  if (!task || task.deleted || task.studentId !== studentId || !oldName || !newName || oldName === newName ||
      !(task.taskKind === 'lesson_instruction' || task.lessonFormVersion || task.intakeVersion)) return null;
  const title = String(task.title || '');
  const prefix = title.match(/^(?:\[[^\]]+\]\s*)?/)?.[0] || '';
  const rest = title.slice(prefix.length);
  const hasOldTitle = rest.startsWith(oldName) && /^(?:\s|\(|—|$)/.test(rest.slice(oldName.length));
  if (task.studentName !== oldName && !hasOldTitle) return null;
  return { ...task, studentName: newName,
    title: hasOldTitle ? prefix + newName + rest.slice(oldName.length) : title, updatedAt };
}
