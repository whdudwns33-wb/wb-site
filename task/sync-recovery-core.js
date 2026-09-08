var WBSyncRecoveryCore = (function () {
  'use strict';

  var VERSION = 1;
  var PREFIX = 'wb-task-sync-recovery:v1:';
  var SCOPE_RE = /^(?:admin|person:[A-Za-z0-9_-]{1,128})$/;
  var ID_RE = /^recovery-[a-z0-9-]+$/;
  var ERROR_TEXT = {
    LESSON_SCHEDULE_ENDPOINT_REQUIRED: '이 기기에 남아 있는 수업·시간표 변경은 수업 등록 및 변경 화면에서 다시 확인해야 합니다.',
    MAKEUP_ENDPOINT_REQUIRED: '이 기기에 남아 있는 보강 변경은 보강 화면에서 다시 확인해야 합니다.',
    BOOK_ORDER_SEALED: '이미 확정된 교재 주문과 이 기기의 변경 내용이 다릅니다. 교재 주문 화면에서 확인해 주세요.',
    BOOK_ORDER_CREATE_REQUIRED: '이 기기에 남아 있는 교재 주문은 전용 주문 화면에서 다시 확인해야 합니다.',
    SESSION4_ATTENDANCE_LOCKED: '이미 확정된 회차제 출결과 이 기기의 기록이 다릅니다. 보관된 출결·메모를 확인해 주세요.',
    BOARDING_LOCK: '하차가 완료되지 않은 학생과 연결된 변경입니다. 차량 화면에서 현재 상태를 확인해 주세요.',
    REWARD_ALREADY_PROCESSING: '이미 처리 중인 교환 요청과 이 기기의 변경 내용이 충돌했습니다.',
    REVISION_CONFLICT: '다른 기기에서 먼저 변경한 내용과 이 기기의 기록이 다릅니다.',
    STALE_REVISION: '다른 기기에서 먼저 변경한 내용과 이 기기의 기록이 다릅니다.',
    SYNC_SCHEDULE_REVISION_CONFLICT: '다른 기기에서 수업 시간표가 먼저 변경되었습니다. 최신 시간표와 보존된 내용을 비교해 주세요.',
    MAKEUP_COMPLETED_ATTENDANCE_LOCKED: '완료된 보강 출결과 이 기기의 기록이 다릅니다. 보강 완료 기록과 보존된 메모를 확인해 주세요.',
    STUDENT_SCHEDULE_CONFLICT: '같은 학생의 수업 시간이 겹칩니다. 보존된 시간표를 확인해 주세요.',
    SYNC_RECOVERY_AUTH_CHANGED: '접속 정보가 바뀌어 복구를 중단했습니다. 현재 연결에서 다시 확인해 주세요.',
    SYNC_RECOVERY_LOCAL_CHANGED: '다른 화면에서 내용이 바뀌어 복구를 중단했습니다. 다른 탭을 닫고 다시 확인해 주세요.',
    SYNC_RECOVERY_INVALID_RESPONSE: '서버의 전체 자료를 확인하지 못해 현재 기록을 유지했습니다. 다시 확인해 주세요.',
    SYNC_RECOVERY_STALLED: '전체 자료 조회가 진행되지 않아 현재 기록을 유지했습니다. 다시 확인해 주세요.',
    SYNC_RECOVERY_INCOMPLETE: '전체 자료 조회가 끝나지 않아 현재 기록을 유지했습니다. 다시 확인해 주세요.',
    SYNC_RECOVERY_STORAGE_FAILED: '복구 결과를 기기에 저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.',
    ARCHIVE_CORRUPT: '보존된 미전송 기록을 안전하게 읽지 못해 복구를 중단했습니다. 기존 데이터는 유지했습니다.',
    ARCHIVE_STORAGE_FAILED: '미전송 기록을 기기에 보존할 공간이 부족합니다. 기존 데이터는 유지했습니다.',
    ARCHIVE_STORAGE_UNAVAILABLE: '브라우저가 기록 보관을 허용하지 않아 복구를 중단했습니다. 기존 데이터는 유지했습니다.',
    ARCHIVE_VERIFY_FAILED: '미전송 기록의 보관을 확인하지 못해 복구를 중단했습니다. 기존 데이터는 유지했습니다.',
    DATA_GENERATION_MISMATCH: '운영 데이터가 새로 바뀌었습니다. 최신 데이터를 다시 받아야 합니다.',
    AUTH_REQUIRED: '개인 연결을 다시 확인해 주세요.',
    SESSION_EXPIRED: '개인 연결이 만료되었습니다. 새 개인 링크로 다시 연결해 주세요.',
    SESSION_REVOKED: '개인 연결이 해제되었습니다. 새 개인 링크로 다시 연결해 주세요.'
  };

  function fail(code) {
    var error = new Error(code);
    error.code = code;
    throw error;
  }

  function scopePrefix(scopeId) {
    if (typeof scopeId !== 'string' || !SCOPE_RE.test(scopeId)) fail('ARCHIVE_SCOPE_INVALID');
    return PREFIX + encodeURIComponent(scopeId) + ':';
  }

  function archiveKey(scopeId, id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) fail('ARCHIVE_ID_INVALID');
    return scopePrefix(scopeId) + id;
  }

  function isCredentialKey(key) {
    var name = String(key).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    return /^(?:auth|authorization|credentials?|cookies?|password|passwd|pin|adminpin|apikey|bootstrapcode|linkcode)$/.test(name) ||
      /(?:token|tokens|secret|secrets|password|passwd|apikey|pinhash|tokenhash|secretkey)$/.test(name);
  }

  // 수업 내용은 필드 제한으로 잘라내지 않고, 인증 필드만 재귀적으로 제외한다.
  function sanitize(value, parents) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('ARCHIVE_DATA_INVALID');
      return value;
    }
    if (typeof value === 'undefined') return undefined;
    if (typeof value !== 'object') fail('ARCHIVE_DATA_INVALID');
    parents = parents || [];
    if (parents.indexOf(value) !== -1) fail('ARCHIVE_DATA_INVALID');
    var proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) fail('ARCHIVE_DATA_INVALID');
    var nextParents = parents.concat([value]);
    if (Array.isArray(value)) return value.map(function (item) {
      var cloned = sanitize(item, nextParents);
      return typeof cloned === 'undefined' ? null : cloned;
    });
    var out = {};
    Object.keys(value).sort().forEach(function (key) {
      if (isCredentialKey(key)) return;
      var cloned = sanitize(value[key], nextParents);
      if (typeof cloned === 'undefined') return;
      Object.defineProperty(out, key, { value: cloned, enumerable: true, writable: true, configurable: true });
    });
    return out;
  }

  function errorCode(error) {
    var code = String(error && (error.code || error.errorCode || error.reason) || '');
    return /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : '';
  }

  function isRecoverableError(error) {
    return Number(error && error.status) === 409 && errorCode(error) !== 'DATA_GENERATION_MISMATCH';
  }

  function errorText(error) {
    var code = errorCode(error);
    if (Object.prototype.hasOwnProperty.call(ERROR_TEXT, code)) return ERROR_TEXT[code];
    if (/^(?:SYNC_TIMEOUT|REQUEST_TIMEOUT|TIMEOUT)$/.test(code) ||
        /^(?:AbortError|TimeoutError)$/.test(String(error && error.name || ''))) {
      return '서버 응답이 늦어 연결 확인을 멈췄습니다. 잠시 후 다시 시도해 주세요.';
    }
    if (/^(?:NETWORK_ERROR|FETCH_ERROR)$/.test(code) ||
        /failed to fetch|network|load failed/i.test(String(error && error.message || ''))) {
      return '서버에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.';
    }
    var status = Number(error && error.status) || 0;
    if (status === 401 || status === 403) return '현재 개인 연결 또는 접근 권한을 확인하지 못했습니다. 개인 링크를 다시 확인해 주세요.';
    if (status === 409) return '이 기기에 남아 있는 변경 내용이 서버의 최신 내용과 충돌했습니다.';
    if (status >= 500) return '서버에서 연결을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
    return '최신 내용을 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.';
  }

  function snapshot(record) {
    return JSON.stringify(sanitize({ scopeId: record.scopeId, accessRole: record.accessRole,
      dataGeneration: record.dataGeneration, changes: record.changes }));
  }

  function fingerprint(value) {
    var hash = 2166136261;
    for (var i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function buildArchive(options) {
    options = options || {};
    scopePrefix(options.scopeId);
    if (options.scopeId === 'admin' ? options.accessRole !== 'admin' :
        options.accessRole !== 'staff' && options.accessRole !== 'manager') fail('ARCHIVE_ROLE_INVALID');
    var generation = options.dataGeneration == null ? 0 : Number(options.dataGeneration);
    var createdAt = options.createdAt == null ? Date.now() : Number(options.createdAt);
    if (!Number.isSafeInteger(generation) || generation < 0 || !Number.isSafeInteger(createdAt) || createdAt <= 0) {
      fail('ARCHIVE_METADATA_INVALID');
    }
    if (!Array.isArray(options.changes)) fail('ARCHIVE_DATA_INVALID');
    var changes = sanitize(options.changes);
    if (changes.some(function (change) {
      return !change || typeof change !== 'object' || Array.isArray(change) ||
        typeof change.table !== 'string' || !change.table || !change.data || typeof change.data !== 'object';
    })) fail('ARCHIVE_DATA_INVALID');
    var record = {
      version: VERSION,
      id: '',
      scopeId: options.scopeId,
      accessRole: options.accessRole,
      dataGeneration: generation,
      createdAt: createdAt,
      error: { status: Number(options.error && options.error.status) || 0, code: errorCode(options.error) },
      changes: changes
    };
    record.id = 'recovery-' + createdAt.toString(36) + '-' + fingerprint(snapshot(record));
    return record;
  }

  function validRecord(record, scopeId, key) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.version !== VERSION ||
        record.scopeId !== scopeId || !Number.isSafeInteger(record.createdAt) || record.createdAt <= 0 ||
        !Number.isSafeInteger(record.dataGeneration) || record.dataGeneration < 0 ||
        !Array.isArray(record.changes) || !record.error || typeof record.error !== 'object' ||
        Object.keys(record).sort().join(',') !== 'accessRole,changes,createdAt,dataGeneration,error,id,scopeId,version') return false;
    try {
      if (archiveKey(record.scopeId, record.id) !== key) return false;
      var rebuilt = buildArchive(record);
      if (record.id !== rebuilt.id && record.id.indexOf(rebuilt.id + '-') !== 0) return false;
      return JSON.stringify(sanitize(record)) === JSON.stringify(sanitize({
        version: VERSION, id: record.id, scopeId: rebuilt.scopeId, accessRole: rebuilt.accessRole,
        dataGeneration: rebuilt.dataGeneration, createdAt: rebuilt.createdAt,
        error: rebuilt.error, changes: rebuilt.changes
      })) && JSON.stringify(record) === JSON.stringify(JSON.parse(JSON.stringify(record), function (name, value) {
        return isCredentialKey(name) ? undefined : value;
      }));
    } catch (error) { return false; }
  }

  function storageFailure(code) {
    return { ok: false, records: [], code: code,
      error: code === 'ARCHIVE_CORRUPT'
        ? '보관된 기록을 안전하게 읽지 못했습니다. 이 기기의 변경 내용을 유지합니다.'
        : '이 기기에 복구 기록을 안전하게 보관하지 못했습니다. 저장 공간과 브라우저 설정을 확인해 주세요. 변경 내용은 유지합니다.' };
  }

  function readArchives(storage, scopeId) {
    try {
      var prefix = scopePrefix(scopeId);
      if (!storage || typeof storage.getItem !== 'function' || typeof storage.key !== 'function' ||
          !Number.isSafeInteger(storage.length) || storage.length < 0) return storageFailure('ARCHIVE_STORAGE_UNAVAILABLE');
      var keys = [];
      for (var i = 0; i < storage.length; i++) {
        var key = storage.key(i);
        if (typeof key === 'string' && key.indexOf(prefix) === 0 && keys.indexOf(key) === -1) keys.push(key);
      }
      var records = [];
      for (var j = 0; j < keys.length; j++) {
        var raw = storage.getItem(keys[j]);
        var record;
        try { record = JSON.parse(raw); } catch (error) { return storageFailure('ARCHIVE_CORRUPT'); }
        if (!validRecord(record, scopeId, keys[j])) return storageFailure('ARCHIVE_CORRUPT');
        records.push(record);
      }
      records.sort(function (a, b) { return b.createdAt - a.createdAt || a.id.localeCompare(b.id); });
      return { ok: true, records: records };
    } catch (error) { return storageFailure(error && error.code || 'ARCHIVE_STORAGE_UNAVAILABLE'); }
  }

  function saveArchive(storage, record) {
    try {
      var key = archiveKey(record.scopeId, record.id);
      if (!validRecord(record, record.scopeId, key)) return storageFailure('ARCHIVE_DATA_INVALID');
      var existing = readArchives(storage, record.scopeId);
      if (!existing.ok) return existing;
      var content = snapshot(record);
      for (var i = 0; i < existing.records.length; i++) {
        if (snapshot(existing.records[i]) === content) {
          // 중복이어도 실제 저장소를 다시 읽어 본 뒤에만 원본 정리를 허용한다.
          var duplicate = existing.records[i];
          var duplicateRaw = storage.getItem(archiveKey(duplicate.scopeId, duplicate.id));
          if (duplicateRaw !== JSON.stringify(duplicate)) return storageFailure('ARCHIVE_VERIFY_FAILED');
          return { ok: true, record: duplicate, duplicate: true };
        }
      }
      var saved = JSON.parse(JSON.stringify(record));
      var collision = 0;
      while (storage.getItem(key) !== null) {
        saved.id = record.id + '-' + (++collision).toString(36);
        key = archiveKey(saved.scopeId, saved.id);
      }
      var serialized = JSON.stringify(saved);
      // 한 기록씩 저장해 다른 탭의 보관 목록을 덮어쓰지 않고, 용량 부족 때는 중단한다.
      storage.setItem(key, serialized);
      var verified = storage.getItem(key);
      if (verified !== serialized || !validRecord(JSON.parse(verified), saved.scopeId, key)) {
        return storageFailure('ARCHIVE_VERIFY_FAILED');
      }
      return { ok: true, record: saved, duplicate: false };
    } catch (error) { return storageFailure('ARCHIVE_STORAGE_FAILED'); }
  }

  function displayRows(record) {
    var changes = sanitize(record && Array.isArray(record.changes) ? record.changes : []);
    return changes.map(function (change) {
      var data = change.data || {};
      var key = String(change.k || change.key || change.id || data.id || '');
      var table = String(change.table || '');
      var title = String(data.title || data.studentName || data.name || data.subject || key || '이름 없는 기록');
      return {
        table: table, label: ({ tasks: '수업·업무', checks: '출결·메모·확인 기록', staff: '직원 정보' })[table] || table,
        key: key, owner: String(change.owner || data.staffId || ''), title: title,
        updatedAt: Number(change.updated_at || data.updatedAt) || 0,
        details: JSON.stringify(change, null, 2)
      };
    });
  }

  function clearArchives(storage, scopeId) {
    var read = readArchives(storage, scopeId);
    if (!read.ok) return read;
    var removed = 0;
    try {
      for (var i = 0; i < read.records.length; i++) {
        var record = read.records[i];
        var key = archiveKey(scopeId, record.id);
        // 연결 해제 때도 다른 사람의 보관본을 지우지 않도록 대상과 내용을 재확인한다.
        var raw = storage.getItem(key);
        if (!validRecord(JSON.parse(raw), scopeId, key)) return storageFailure('ARCHIVE_CORRUPT');
        storage.removeItem(key);
        if (storage.getItem(key) !== null) return storageFailure('ARCHIVE_CLEAR_FAILED');
        removed++;
      }
      return { ok: true, removed: removed };
    } catch (error) { return storageFailure('ARCHIVE_CLEAR_FAILED'); }
  }

  return { buildArchive: buildArchive, saveArchive: saveArchive, readArchives: readArchives,
    clearArchives: clearArchives, archiveKey: archiveKey, isRecoverableError: isRecoverableError,
    errorText: errorText, displayRows: displayRows };
})();

if (typeof module === 'object' && module.exports) module.exports = WBSyncRecoveryCore;
