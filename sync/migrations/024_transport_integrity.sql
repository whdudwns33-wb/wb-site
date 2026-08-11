-- 차량 승차 상태와 명단·직원·노선 설정 사이의 불변식을 DB 쓰기 시점에 보장한다.
-- API의 사전 조회만으로는 동시 요청 사이에 상태가 바뀌는 TOCTOU 경쟁을 막을 수 없으므로,
-- 최종 쓰기와 같은 SQLite 트랜잭션 안에서 중단한다.

CREATE TRIGGER IF NOT EXISTS trg_transport_boarded_insert_guard
BEFORE INSERT ON transport_states
WHEN NEW.status = 'boarded'
BEGIN
  SELECT CASE WHEN NOT (
    COALESCE(length(NEW.date) = 10 AND strftime('%Y-%m-%d', NEW.date) = NEW.date, 0) = 1
    AND EXISTS (
      SELECT 1
      FROM private_rosters AS pr, json_each(pr.data, '$.roster.students') AS student
      WHERE pr.app = NEW.app
        AND json_extract(student.value, '$.id') = NEW.student_id
        AND json_extract(student.value, '$.start') <= substr(NEW.date, 1, 7)
        AND (
          COALESCE(json_extract(student.value, '$.end'), '') = ''
          OR json_extract(student.value, '$.end') > substr(NEW.date, 1, 7)
        )
    )
    AND EXISTS (
      SELECT 1
      FROM transport_configs AS config, json_each(config.data, '$.routes') AS route
      WHERE config.app = NEW.app
        AND json_extract(route.value, '$.id') = NEW.route_id
        AND json_extract(route.value, '$.active') = 1
        AND EXISTS (
          SELECT 1 FROM json_each(route.value, '$.days') AS day
          WHERE CAST(day.value AS INTEGER) = CAST(strftime('%w', NEW.date) AS INTEGER)
        )
        AND EXISTS (
          SELECT 1
          FROM json_each(route.value, '$.stops') AS stop,
               json_each(stop.value, '$.studentIds') AS route_student
          WHERE route_student.value = NEW.student_id
        )
        AND EXISTS (
          SELECT 1 FROM json_each(config.data, '$.vehicles') AS vehicle
          WHERE json_extract(vehicle.value, '$.id') = json_extract(route.value, '$.vehicleId')
        )
        AND EXISTS (
          SELECT 1 FROM staff AS driver
          WHERE driver.app = NEW.app
            AND driver.id = json_extract(route.value, '$.driverId')
            AND CASE WHEN json_valid(driver.data) THEN
              json_type(driver.data) = 'object' AND COALESCE(json_extract(driver.data, '$.deleted'), 0) = 0
            ELSE 0 END
        )
    )
  ) THEN RAISE(ABORT, 'BOARDING_LOCK') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_transport_boarded_update_guard
BEFORE UPDATE ON transport_states
WHEN NEW.status = 'boarded'
BEGIN
  SELECT CASE WHEN NOT (
    COALESCE(length(NEW.date) = 10 AND strftime('%Y-%m-%d', NEW.date) = NEW.date, 0) = 1
    AND EXISTS (
      SELECT 1
      FROM private_rosters AS pr, json_each(pr.data, '$.roster.students') AS student
      WHERE pr.app = NEW.app
        AND json_extract(student.value, '$.id') = NEW.student_id
        AND json_extract(student.value, '$.start') <= substr(NEW.date, 1, 7)
        AND (
          COALESCE(json_extract(student.value, '$.end'), '') = ''
          OR json_extract(student.value, '$.end') > substr(NEW.date, 1, 7)
        )
    )
    AND EXISTS (
      SELECT 1
      FROM transport_configs AS config, json_each(config.data, '$.routes') AS route
      WHERE config.app = NEW.app
        AND json_extract(route.value, '$.id') = NEW.route_id
        AND json_extract(route.value, '$.active') = 1
        AND EXISTS (
          SELECT 1 FROM json_each(route.value, '$.days') AS day
          WHERE CAST(day.value AS INTEGER) = CAST(strftime('%w', NEW.date) AS INTEGER)
        )
        AND EXISTS (
          SELECT 1
          FROM json_each(route.value, '$.stops') AS stop,
               json_each(stop.value, '$.studentIds') AS route_student
          WHERE route_student.value = NEW.student_id
        )
        AND EXISTS (
          SELECT 1 FROM json_each(config.data, '$.vehicles') AS vehicle
          WHERE json_extract(vehicle.value, '$.id') = json_extract(route.value, '$.vehicleId')
        )
        AND EXISTS (
          SELECT 1 FROM staff AS driver
          WHERE driver.app = NEW.app
            AND driver.id = json_extract(route.value, '$.driverId')
            AND CASE WHEN json_valid(driver.data) THEN
              json_type(driver.data) = 'object' AND COALESCE(json_extract(driver.data, '$.deleted'), 0) = 0
            ELSE 0 END
        )
    )
  ) THEN RAISE(ABORT, 'BOARDING_LOCK') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_transport_roster_insert_guard
BEFORE INSERT ON private_rosters
WHEN EXISTS (
  SELECT 1 FROM transport_states AS state
  WHERE state.app = NEW.app AND state.status = 'boarded'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.data, '$.roster.students') AS student
      WHERE json_extract(student.value, '$.id') = state.student_id
        AND length(state.date) = 10
        AND strftime('%Y-%m-%d', state.date) = state.date
        AND json_extract(student.value, '$.start') <= substr(state.date, 1, 7)
        AND (
          COALESCE(json_extract(student.value, '$.end'), '') = ''
          OR json_extract(student.value, '$.end') > substr(state.date, 1, 7)
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'BOARDING_LOCK');
END;

CREATE TRIGGER IF NOT EXISTS trg_transport_roster_update_guard
BEFORE UPDATE OF data ON private_rosters
WHEN EXISTS (
  SELECT 1 FROM transport_states AS state
  WHERE state.app = NEW.app AND state.status = 'boarded'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.data, '$.roster.students') AS student
      WHERE json_extract(student.value, '$.id') = state.student_id
        AND length(state.date) = 10
        AND strftime('%Y-%m-%d', state.date) = state.date
        AND json_extract(student.value, '$.start') <= substr(state.date, 1, 7)
        AND (
          COALESCE(json_extract(student.value, '$.end'), '') = ''
          OR json_extract(student.value, '$.end') > substr(state.date, 1, 7)
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'BOARDING_LOCK');
END;

CREATE TRIGGER IF NOT EXISTS trg_transport_roster_delete_guard
BEFORE DELETE ON private_rosters
WHEN EXISTS (
  SELECT 1 FROM transport_states AS state
  WHERE state.app = OLD.app AND state.status = 'boarded'
)
BEGIN
  SELECT RAISE(ABORT, 'BOARDING_LOCK');
END;

-- 설정 변경은 미하차 기록이 하나라도 남아 있으면 보수적으로 막는다. 미하차를 하차·인계
-- 또는 사유 있는 초기화로 먼저 정리하면 정상적으로 변경할 수 있다.
CREATE TRIGGER IF NOT EXISTS trg_transport_config_insert_guard
BEFORE INSERT ON transport_configs
WHEN EXISTS (
  SELECT 1 FROM transport_states AS state
  WHERE state.app = NEW.app AND state.status = 'boarded'
)
BEGIN
  SELECT RAISE(ABORT, 'BOARDING_LOCK');
END;

CREATE TRIGGER IF NOT EXISTS trg_transport_config_update_guard
BEFORE UPDATE ON transport_configs
WHEN EXISTS (
  SELECT 1 FROM transport_states AS state
  WHERE state.app = OLD.app AND state.status = 'boarded'
)
BEGIN
  SELECT RAISE(ABORT, 'BOARDING_LOCK');
END;

CREATE TRIGGER IF NOT EXISTS trg_transport_config_delete_guard
BEFORE DELETE ON transport_configs
WHEN EXISTS (
  SELECT 1 FROM transport_states AS state
  WHERE state.app = OLD.app AND state.status = 'boarded'
)
BEGIN
  SELECT RAISE(ABORT, 'BOARDING_LOCK');
END;

-- 정상 노선에서는 해당 기사만 막고, 설정/차량/학생/요일/기사 중 하나라도 손상된
-- 고아 미하차 기록이 있으면 어떤 활성 직원의 비활성화도 fail-closed로 막는다.
CREATE TRIGGER IF NOT EXISTS trg_transport_staff_update_guard
BEFORE UPDATE OF data ON staff
WHEN OLD.app = 'task'
  AND CASE WHEN json_valid(OLD.data) THEN
    json_type(OLD.data) = 'object' AND COALESCE(json_extract(OLD.data, '$.deleted'), 0) = 0
  ELSE 0 END
  AND CASE WHEN json_valid(NEW.data) THEN
    json_type(NEW.data) <> 'object' OR COALESCE(json_extract(NEW.data, '$.deleted'), 0) <> 0
  ELSE 1 END
  AND EXISTS (
    SELECT 1
    FROM transport_states AS state
    WHERE state.app = OLD.app AND state.status = 'boarded'
      AND (
        NOT EXISTS (
          SELECT 1
          FROM transport_configs AS config, json_each(config.data, '$.routes') AS route
          WHERE config.app = state.app
            AND json_extract(route.value, '$.id') = state.route_id
            AND json_extract(route.value, '$.active') = 1
            AND EXISTS (
              SELECT 1 FROM json_each(route.value, '$.days') AS day
              WHERE CAST(day.value AS INTEGER) = CAST(strftime('%w', state.date) AS INTEGER)
            )
            AND EXISTS (
              SELECT 1
              FROM json_each(route.value, '$.stops') AS stop,
                   json_each(stop.value, '$.studentIds') AS route_student
              WHERE route_student.value = state.student_id
            )
            AND EXISTS (
              SELECT 1 FROM json_each(config.data, '$.vehicles') AS vehicle
              WHERE json_extract(vehicle.value, '$.id') = json_extract(route.value, '$.vehicleId')
            )
            AND EXISTS (
              SELECT 1 FROM staff AS driver
              WHERE driver.app = state.app
                AND driver.id = json_extract(route.value, '$.driverId')
                AND CASE WHEN json_valid(driver.data) THEN
                  json_type(driver.data) = 'object' AND COALESCE(json_extract(driver.data, '$.deleted'), 0) = 0
                ELSE 0 END
            )
            AND EXISTS (
              SELECT 1
              FROM private_rosters AS roster, json_each(roster.data, '$.roster.students') AS student
              WHERE roster.app = state.app
                AND json_extract(student.value, '$.id') = state.student_id
                AND length(state.date) = 10
                AND strftime('%Y-%m-%d', state.date) = state.date
                AND json_extract(student.value, '$.start') <= substr(state.date, 1, 7)
                AND (
                  COALESCE(json_extract(student.value, '$.end'), '') = ''
                  OR json_extract(student.value, '$.end') > substr(state.date, 1, 7)
                )
            )
        )
        OR EXISTS (
          SELECT 1
          FROM transport_configs AS config, json_each(config.data, '$.routes') AS route
          WHERE config.app = state.app
            AND json_extract(route.value, '$.id') = state.route_id
            AND json_extract(route.value, '$.driverId') = OLD.id
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'BOARDING_LOCK');
END;

CREATE TRIGGER IF NOT EXISTS trg_transport_staff_delete_guard
BEFORE DELETE ON staff
WHEN OLD.app = 'task'
  AND CASE WHEN json_valid(OLD.data) THEN
    json_type(OLD.data) = 'object' AND COALESCE(json_extract(OLD.data, '$.deleted'), 0) = 0
  ELSE 0 END
  AND EXISTS (
    SELECT 1
    FROM transport_states AS state
    WHERE state.app = OLD.app AND state.status = 'boarded'
      AND (
        NOT EXISTS (
          SELECT 1
          FROM transport_configs AS config, json_each(config.data, '$.routes') AS route
          WHERE config.app = state.app
            AND json_extract(route.value, '$.id') = state.route_id
            AND json_extract(route.value, '$.active') = 1
            AND EXISTS (
              SELECT 1 FROM json_each(route.value, '$.days') AS day
              WHERE CAST(day.value AS INTEGER) = CAST(strftime('%w', state.date) AS INTEGER)
            )
            AND EXISTS (
              SELECT 1
              FROM json_each(route.value, '$.stops') AS stop,
                   json_each(stop.value, '$.studentIds') AS route_student
              WHERE route_student.value = state.student_id
            )
            AND EXISTS (
              SELECT 1 FROM json_each(config.data, '$.vehicles') AS vehicle
              WHERE json_extract(vehicle.value, '$.id') = json_extract(route.value, '$.vehicleId')
            )
            AND EXISTS (
              SELECT 1 FROM staff AS driver
              WHERE driver.app = state.app
                AND driver.id = json_extract(route.value, '$.driverId')
                AND CASE WHEN json_valid(driver.data) THEN
                  json_type(driver.data) = 'object' AND COALESCE(json_extract(driver.data, '$.deleted'), 0) = 0
                ELSE 0 END
            )
            AND EXISTS (
              SELECT 1
              FROM private_rosters AS roster, json_each(roster.data, '$.roster.students') AS student
              WHERE roster.app = state.app
                AND json_extract(student.value, '$.id') = state.student_id
                AND length(state.date) = 10
                AND strftime('%Y-%m-%d', state.date) = state.date
                AND json_extract(student.value, '$.start') <= substr(state.date, 1, 7)
                AND (
                  COALESCE(json_extract(student.value, '$.end'), '') = ''
                  OR json_extract(student.value, '$.end') > substr(state.date, 1, 7)
                )
            )
        )
        OR EXISTS (
          SELECT 1
          FROM transport_configs AS config, json_each(config.data, '$.routes') AS route
          WHERE config.app = state.app
            AND json_extract(route.value, '$.id') = state.route_id
            AND json_extract(route.value, '$.driverId') = OLD.id
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'BOARDING_LOCK');
END;

-- 구형 Pages나 generic /sync 경로로 직원을 비활성화해도 기존 개인 링크가 나중에
-- 직원 재등록과 함께 되살아나지 않도록, 직원 tombstone과 같은 statement에서 해지한다.
CREATE TRIGGER IF NOT EXISTS trg_transport_staff_revoke_after_update
AFTER UPDATE OF data ON staff
WHEN OLD.app = 'task'
  AND CASE WHEN json_valid(OLD.data) THEN
    json_type(OLD.data) = 'object' AND COALESCE(json_extract(OLD.data, '$.deleted'), 0) = 0
  ELSE 0 END
  AND CASE WHEN json_valid(NEW.data) THEN
    json_type(NEW.data) <> 'object' OR COALESCE(json_extract(NEW.data, '$.deleted'), 0) <> 0
  ELSE 1 END
BEGIN
  UPDATE tokens SET revoked = 1 WHERE app = NEW.app AND staff_id = NEW.id;
  UPDATE bootstrap_codes SET revoked = 1 WHERE app = NEW.app AND staff_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_transport_staff_revoke_after_delete
AFTER DELETE ON staff
WHEN OLD.app = 'task'
BEGIN
  UPDATE tokens SET revoked = 1 WHERE app = OLD.app AND staff_id = OLD.id;
  UPDATE bootstrap_codes SET revoked = 1 WHERE app = OLD.app AND staff_id = OLD.id;
END;
