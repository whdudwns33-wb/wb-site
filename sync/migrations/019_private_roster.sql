-- 원생 명단과 학생별 교재 배정을 GitHub Pages 정적 파일 대신 D1에 비공개로 저장한다.
-- 문서 내부의 teacherIds는 Worker가 개인 링크 응답을 담당 학생으로 제한할 때만 사용한다.
CREATE TABLE IF NOT EXISTS private_rosters (
  app        TEXT    NOT NULL CHECK (app = 'task'),
  data       TEXT    NOT NULL CHECK (json_valid(data) AND length(CAST(data AS BLOB)) <= 524288),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app)
);
