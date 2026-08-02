(function (root, factory) {
  "use strict";

  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.WBLearningPlatform = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var SCHEMA_VERSION = 2;
  var DAY_MS = 86400000;
  var mountSequence = 0;
  var PROGRAM_HISTORY_LIMIT = 20;
  var PROGRAM_HISTORY_MAX_BYTES = 8 * 1024;
  var PROGRAM_SNAPSHOT_MAX_BYTES = 4 * 1024;
  var OPAQUE_ACCOUNT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9:._\/#-]{0,127}$/;

  var PROGRAM_STATUSES = freeze([
    "unused", "preparing", "active", "partial", "incomplete",
    "unverified", "check_needed", "paused", "error"
  ]);
  var PLANNER_STATUSES = freeze([
    "planned", "in_progress", "verification_waiting", "completed",
    "carryover_candidate", "carried_over", "check_needed", "paused", "canceled"
  ]);
  var CAMPAIGN_STATUSES = freeze([
    "draft", "consent_pending", "review_pending", "planned", "active",
    "paused", "exam_ready", "taken", "result_waiting", "result_review",
    "completed", "reschedule_needed", "canceled", "archived", "check_needed"
  ]);
  var WRONG_ANSWER_STATUSES = freeze([
    "captured", "generation_requested", "generation_failed", "generated",
    "review_waiting", "assigned", "in_progress", "submitted", "result_waiting",
    "verification_waiting", "recheck_scheduled", "retry_required", "mastered",
    "check_needed", "closed"
  ]);

  var CAMPAIGN_TYPES = deepFreeze({
    school_regular: {
      label: "학교 정기시험",
      elementarySelectable: false,
      prepMode: "curriculum_review"
    },
    contest: {
      label: "경시대회",
      elementarySelectable: true,
      prepMode: "skill_building"
    },
    kmt: {
      label: "KMT",
      elementarySelectable: true,
      prepMode: "skill_building"
    },
    nelt: {
      label: "NELT",
      elementarySelectable: true,
      prepMode: "orientation_only"
    },
    gifted_admission: {
      label: "영재원",
      elementarySelectable: true,
      prepMode: "application_plus_prep"
    },
    entrance: {
      label: "입학시험",
      elementarySelectable: true,
      prepMode: "application_plus_prep"
    },
    level_test: {
      label: "레벨테스트",
      elementarySelectable: true,
      prepMode: "orientation_only"
    },
    custom: {
      label: "사용자 지정 시험",
      elementarySelectable: true,
      prepMode: "custom"
    }
  });

  var DEFAULT_PROVIDERS = deepFreeze({
    studyforce: {
      id: "studyforce",
      label: "스터디포스",
      category: "reading",
      evidenceMode: "official_report_or_teacher_check",
      capabilities: ["assignment", "progress", "result", "deep_link"]
    },
    classcard: {
      id: "classcard",
      label: "클래스카드",
      category: "vocabulary",
      evidenceMode: "official_report_or_teacher_check",
      capabilities: ["assignment", "progress", "result", "deep_link"]
    },
    metamath: {
      id: "metamath",
      label: "메타수학",
      category: "math",
      evidenceMode: "official_report_or_teacher_check",
      capabilities: ["assignment", "weekly_test", "month_end_test", "twin_problem", "result"]
    },
    nelt: {
      id: "nelt",
      label: "NELT",
      category: "english_assessment",
      evidenceMode: "official_result_or_teacher_check",
      capabilities: ["quarterly_assessment", "result"]
    },
    manual: {
      id: "manual",
      label: "직접 관리",
      category: "custom",
      evidenceMode: "teacher_check",
      capabilities: ["assignment", "progress", "result"]
    }
  });

  var LABELS = deepFreeze({
    program: {
      unused: "미사용", preparing: "준비중", active: "사용중", partial: "부분완료",
      incomplete: "미완료", unverified: "미확인", check_needed: "확인필요",
      paused: "일시정지", error: "오류"
    },
    planner: {
      planned: "예정", in_progress: "수행중", verification_waiting: "확인대기",
      completed: "완료", carryover_candidate: "이월후보", carried_over: "이월됨",
      check_needed: "확인필요", paused: "일시정지", canceled: "취소"
    },
    campaign: {
      draft: "초안", consent_pending: "동의대기", review_pending: "검토대기",
      planned: "예정", active: "진행중", paused: "일시정지", exam_ready: "응시준비",
      taken: "응시완료", result_waiting: "결과대기", result_review: "결과검토",
      completed: "완료", reschedule_needed: "재예약필요", canceled: "취소",
      archived: "보관", check_needed: "확인필요"
    },
    remediation: {
      captured: "오답등록", generation_requested: "쌍둥이 생성요청",
      generation_failed: "생성실패", generated: "생성완료",
      review_waiting: "선생님 검토대기", assigned: "배정완료",
      in_progress: "수행중", submitted: "제출완료", result_waiting: "결과대기",
      verification_waiting: "숙달 확인대기", recheck_scheduled: "재확인예정",
      retry_required: "재학습필요", mastered: "숙달완료",
      check_needed: "확인필요", closed: "종료"
    }
  });

  var WRONG_TRANSITIONS = deepFreeze({
    captured: ["generation_requested", "check_needed", "closed"],
    generation_requested: ["generated", "generation_failed", "check_needed"],
    generation_failed: ["generation_requested", "check_needed", "closed"],
    generated: ["review_waiting", "check_needed"],
    review_waiting: ["assigned", "generation_requested", "check_needed"],
    assigned: ["in_progress", "submitted", "check_needed"],
    in_progress: ["submitted", "check_needed"],
    submitted: ["result_waiting", "verification_waiting", "check_needed"],
    result_waiting: ["verification_waiting", "check_needed"],
    verification_waiting: ["mastered", "retry_required", "recheck_scheduled", "check_needed"],
    retry_required: ["generation_requested", "recheck_scheduled", "check_needed"],
    recheck_scheduled: ["generation_requested", "assigned", "check_needed"],
    mastered: ["closed"],
    check_needed: ["generation_requested", "review_waiting", "assigned", "closed"],
    closed: []
  });

  var COMMON_MILESTONES = freeze([
    { offset: -28, key: "setup", title: "참가 여부·범위 확인", minutes: 0 },
    { offset: -21, key: "baseline", title: "현재 수준 확인", minutes: 20 },
    { offset: -14, key: "core", title: "핵심 개념과 취약 영역", minutes: 25 },
    { offset: -7, key: "practice", title: "연습과 누락 점검", minutes: 25 },
    { offset: -3, key: "light_review", title: "가벼운 복습과 준비물 확인", minutes: 15 },
    { offset: -1, key: "rest", title: "짧은 확인과 충분한 휴식", minutes: 5 },
    { offset: 0, key: "exam", title: "응시", minutes: 0 },
    { offset: 1, key: "reflection", title: "부담 없는 돌아보기", minutes: 5 },
    { offset: 7, key: "review", title: "결과와 다음 계획 확인", minutes: 10 }
  ]);
  var ORIENTATION_MILESTONES = freeze([
    { offset: -14, key: "setup", title: "일정과 검사 방식 확인", minutes: 0 },
    { offset: -7, key: "format", title: "검사 형식 가볍게 익히기", minutes: 10 },
    { offset: -3, key: "logistics", title: "장소·시간·준비물 확인", minutes: 5 },
    { offset: -1, key: "rest", title: "새 학습 없이 휴식하기", minutes: 0 },
    { offset: 0, key: "exam", title: "진단 참여", minutes: 0 },
    { offset: 1, key: "reflection", title: "느낌 돌아보기", minutes: 5 },
    { offset: 7, key: "review", title: "결과를 선생님과 확인", minutes: 10 }
  ]);

  function freeze(value) {
    return Object.freeze(value);
  }

  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) {
      return value;
    }
    Object.keys(value).forEach(function (key) {
      deepFreeze(value[key]);
    });
    return Object.freeze(value);
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function ensure(condition, message) {
    if (!condition) {
      throw new Error(message);
    }
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function text(value, fallback) {
    var normalized = value === null || value === undefined ? "" : String(value).trim();
    return normalized || (fallback || "");
  }

  function nonNegative(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function parseDateOnly(value, fieldName) {
    var normalized = text(value);
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
    ensure(match, (fieldName || "date") + " must use YYYY-MM-DD");
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    var date = new Date(Date.UTC(year, month - 1, day));
    ensure(
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day,
      (fieldName || "date") + " is invalid"
    );
    return date;
  }

  function formatDateOnly(date) {
    return date.getUTCFullYear() + "-" +
      String(date.getUTCMonth() + 1).padStart(2, "0") + "-" +
      String(date.getUTCDate()).padStart(2, "0");
  }

  function todayDate(timeZone) {
    try {
      var values = {};
      new Intl.DateTimeFormat("en-CA", {
        timeZone: text(timeZone, "Asia/Seoul"),
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(new Date()).forEach(function (part) {
        values[part.type] = part.value;
      });
      return values.year + "-" + values.month + "-" + values.day;
    } catch (_error) {
      return new Date().toISOString().slice(0, 10);
    }
  }

  function addDays(dateOnly, amount) {
    var date = parseDateOnly(dateOnly);
    date.setUTCDate(date.getUTCDate() + Number(amount || 0));
    return formatDateOnly(date);
  }

  function addMonthsClamped(dateOnly, amount) {
    var date = parseDateOnly(dateOnly);
    var originalDay = date.getUTCDate();
    var totalMonths = date.getUTCMonth() + Number(amount || 0);
    var year = date.getUTCFullYear() + Math.floor(totalMonths / 12);
    var month = ((totalMonths % 12) + 12) % 12;
    var lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return formatDateOnly(new Date(Date.UTC(year, month, Math.min(originalDay, lastDay))));
  }

  function compareDates(left, right) {
    return parseDateOnly(left).getTime() - parseDateOnly(right).getTime();
  }

  function daysBetween(fromDate, toDate) {
    return Math.round((parseDateOnly(toDate).getTime() - parseDateOnly(fromDate).getTime()) / DAY_MS);
  }

  function startOfWeek(dateOnly, weekStartsOn) {
    var date = parseDateOnly(dateOnly);
    var first = Number.isInteger(weekStartsOn) ? weekStartsOn : 1;
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() - first + 7) % 7));
    return formatDateOnly(date);
  }

  function nextOrSameWeekday(dateOnly, weekday) {
    var date = parseDateOnly(dateOnly);
    var target = Number(weekday);
    ensure(Number.isInteger(target) && target >= 0 && target <= 6, "weekday must be 0-6");
    return addDays(dateOnly, (target - date.getUTCDay() + 7) % 7);
  }

  function lastLearningDayOfMonth(year, monthIndex, activeWeekdays) {
    var weekdays = asArray(activeWeekdays).length ? activeWeekdays.map(Number) : [1, 2, 3, 4, 5];
    var date = new Date(Date.UTC(year, monthIndex + 1, 0));
    while (weekdays.indexOf(date.getUTCDay()) < 0) {
      date.setUTCDate(date.getUTCDate() - 1);
    }
    return formatDateOnly(date);
  }

  function stableId(prefix) {
    var source = Array.prototype.slice.call(arguments, 1).map(function (value) {
      return value === null || value === undefined ? "" : String(value);
    }).join("|");
    var hash = 2166136261;
    var index;
    for (index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return text(prefix, "id") + "_" + (hash >>> 0).toString(36);
  }

  function safeHttpUrl(value) {
    var candidate = text(value);
    if (!candidate) {
      return "";
    }
    try {
      var url = new URL(candidate, "https://invalid.example");
      return url.protocol === "http:" || url.protocol === "https:" ? candidate : "";
    } catch (_error) {
      return "";
    }
  }

  function normalizedSensitiveKey(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
  }

  function isForbiddenCredentialKey(value) {
    var normalized = normalizedSensitiveKey(value);
    if (/^(?:password|passwd|pwd|pw|passcode|pin|secret|clientsecret|apisecret|apikey|apitoken|accesstoken|refreshtoken|sessiontoken|sessioncookie|authcookie|authtoken|authorization|bearer|bearertoken|cookie|credential|credentials|privatekey|비밀번호|비번|암호|인증토큰)$/.test(normalized)) return true;
    return /(?:password|passwd|passcode|clientsecret|apisecret|privatekey|(?:api|access|refresh|session|auth|bearer)(?:key|token|cookie|secret)|authorization|credential|비밀번호|비번|암호|인증토큰)/i.test(normalized);
  }

  function hasCredentialField(value) {
    if (!value || typeof value !== "object") return false;
    return Object.keys(value).some(function (key) {
      if (isForbiddenCredentialKey(key)) return true;
      return typeof value[key] === "object" && hasCredentialField(value[key]);
    });
  }

  function stripCredentialFields(value) {
    if (Array.isArray(value)) return value.map(stripCredentialFields);
    if (!isObject(value)) return value;
    var clean = {};
    Object.keys(value).forEach(function (key) {
      if (!isForbiddenCredentialKey(key)) clean[key] = stripCredentialFields(value[key]);
    });
    return clean;
  }

  function isOpaqueAccountRef(value) {
    var candidate = text(value);
    return !candidate || OPAQUE_ACCOUNT_REF_RE.test(candidate);
  }

  function opaqueAccountRef(value) {
    var candidate = text(value);
    ensure(isOpaqueAccountRef(candidate), "accountIdRef must be an opaque reference, not a password");
    return candidate;
  }

  function createProviderRegistry(customProviders) {
    var registry = clone(DEFAULT_PROVIDERS);
    asArray(customProviders).forEach(function (provider) {
      ensure(isObject(provider), "provider must be an object");
      var id = text(provider.id).toLowerCase();
      ensure(/^[a-z0-9_-]+$/.test(id), "provider id is invalid");
      registry[id] = {
        id: id,
        label: text(provider.label, id),
        category: text(provider.category, "custom"),
        evidenceMode: text(provider.evidenceMode, "teacher_check"),
        capabilities: asArray(provider.capabilities).map(String)
      };
    });
    return registry;
  }

  function createStudentProfile(input) {
    var source = input || {};
    var stage = text(source.academicStage, "elementary");
    ensure(["elementary", "middle", "high"].indexOf(stage) >= 0, "academicStage is invalid");
    return {
      studentCode: text(source.studentCode, "DEMO-STUDENT"),
      displayName: text(source.displayName, "학생"),
      academicStage: stage,
      grade: Math.max(1, Math.floor(nonNegative(source.grade, 1))),
      timeZone: text(source.timeZone, "Asia/Seoul")
    };
  }

  function createDefaultState(options) {
    var input = options || {};
    var student = createStudentProfile(input.student || input);
    return {
      schemaVersion: SCHEMA_VERSION,
      student: student,
      settings: {
        weekStartsOn: 1,
        schoolRegularExamEnabled: student.academicStage !== "elementary",
        requireTeacherVerification: true,
        notificationQuietHours: { start: "20:00", end: "08:00" }
      },
      programStates: [],
      plannerItems: [],
      assessmentSchedules: [],
      assessmentOccurrences: [],
      prepCampaigns: [],
      remediationCases: [],
      migrationIssues: []
    };
  }

  function normalizeStatus(value, allowed, aliases, fallback) {
    var normalized = aliases[value] || text(value, fallback);
    return allowed.indexOf(normalized) >= 0 ? normalized : fallback;
  }

  function normalizeProgramStatus(value) {
    return normalizeStatus(value, PROGRAM_STATUSES, {
      "사용중": "active", "준비중": "preparing", "미사용": "unused",
      "완료": "unverified", "부분완료": "partial", "미완료": "incomplete",
      "미확인": "unverified", "확인필요": "check_needed", "보류": "paused", "오류": "error"
    }, "check_needed");
  }

  function normalizePlannerStatus(value) {
    return normalizeStatus(value, PLANNER_STATUSES, {
      "대기": "planned", "예정": "planned", "수행중": "in_progress",
      "완료": "verification_waiting", "확인대기": "verification_waiting",
      "이월후보": "carryover_candidate", "확인필요": "check_needed",
      "보류": "paused", "취소": "canceled"
    }, "planned");
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value || {}, key);
  }

  function utf8ByteLength(value) {
    var serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(serialized).length;
    return unescape(encodeURIComponent(serialized)).length;
  }

  function normalizeProgramSnapshot(value) {
    if (!isObject(value)) return null;
    ensure(!hasCredentialField(value), "snapshot credentials must not be stored");
    var data = isObject(value.data) ? clone(value.data) : {};
    ensure(utf8ByteLength(data) <= PROGRAM_SNAPSHOT_MAX_BYTES, "program snapshot is too large");
    var checkDate = text(value.checkDate || value.check_date);
    if (checkDate) parseDateOnly(checkDate, "snapshot.checkDate");
    var payloadHash = text(value.payloadHash || value.payload_hash);
    var snapshotId = text(value.snapshotId || value.duplicateKey || value.duplicate_key,
      stableId("snapshot", value.providerId, value.studentCode, checkDate, payloadHash, value.approvedAt));
    var snapshot = {
      snapshotId: snapshotId,
      payloadHash: payloadHash,
      providerId: text(value.providerId || value.provider_id).toLowerCase(),
      studentCode: text(value.studentCode || value.student_code),
      checkDate: checkDate,
      status: normalizeProgramStatus(value.status || value.finalStatus || value.final_status),
      data: data,
      sourceHash: text(value.sourceHash || value.source_hash),
      sourceRef: text(value.sourceRef || value.source_ref),
      sourceDate: text(value.sourceDate || value.source_date),
      approvedBy: text(value.approvedBy || value.approved_by),
      approvedAt: text(value.approvedAt || value.approved_at)
    };
    ensure(utf8ByteLength(snapshot) + 2 <= PROGRAM_HISTORY_MAX_BYTES, "program snapshot record is too large");
    return snapshot;
  }

  function compareProgramSnapshots(left, right) {
    var a = [text(left && left.checkDate), text(left && left.approvedAt), text(left && left.snapshotId)].join("|");
    var b = [text(right && right.checkDate), text(right && right.approvedAt), text(right && right.snapshotId)].join("|");
    return a === b ? 0 : (a > b ? 1 : -1);
  }

  function boundProgramHistory(values) {
    var byId = {};
    asArray(values).forEach(function (value) {
      var snapshot = normalizeProgramSnapshot(value);
      if (snapshot) byId[snapshot.snapshotId] = snapshot;
    });
    var history = Object.keys(byId).map(function (key) { return byId[key]; }).sort(compareProgramSnapshots);
    var uniqueCount = history.length;
    if (history.length > PROGRAM_HISTORY_LIMIT) history = history.slice(-PROGRAM_HISTORY_LIMIT);
    while (history.length > 1 && utf8ByteLength(history) > PROGRAM_HISTORY_MAX_BYTES) history.shift();
    ensure(utf8ByteLength(history) <= PROGRAM_HISTORY_MAX_BYTES, "program history exceeds bridge limit");
    return { history: history, droppedCount: uniqueCount - history.length };
  }

  function upsertStudentProgramState(state, input, registryInput) {
    ensure(isObject(state), "state is required");
    ensure(isObject(input), "program state is required");
    ensure(!hasCredentialField(input), "credentials and passwords must not be stored");
    var registry = registryInput || DEFAULT_PROVIDERS;
    var providerId = text(input.providerId).toLowerCase();
    ensure(Boolean(registry[providerId]), "unknown provider: " + providerId);
    var studentCode = text(input.studentCode, state.student && state.student.studentCode);
    var next = clone(state);
    var requestedId = text(input.programStateId, stableId("program", studentCode, providerId));
    var index = next.programStates.findIndex(function (item) {
      return item.programStateId === requestedId ||
        (item.studentCode === studentCode && item.providerId === providerId);
    });
    var previous = index >= 0 ? next.programStates[index] : null;
    var previousLatest = normalizeProgramSnapshot(previous && previous.latestSnapshot);
    var incomingLatest = normalizeProgramSnapshot(input.latestSnapshot || input.historyEntry);
    var latest = previousLatest;
    var incomingPromotes = Boolean(incomingLatest && (!previousLatest || compareProgramSnapshots(incomingLatest, previousLatest) >= 0));
    if (incomingPromotes) latest = incomingLatest;
    var boundedHistory = boundProgramHistory(
      asArray(previous && previous.history).concat(asArray(input.history), input.historyEntry || [], input.latestSnapshot || [])
    );
    var history = boundedHistory.history;
    var previousDroppedCount = Math.floor(nonNegative(
      previous && previous.historyRetention && previous.historyRetention.droppedCount, 0
    ));
    var historyRetention = {
      maxEntries: PROGRAM_HISTORY_LIMIT,
      maxBytes: PROGRAM_HISTORY_MAX_BYTES,
      droppedCount: previousDroppedCount + boundedHistory.droppedCount,
      oldestRetainedAt: history.length ? text(history[0].checkDate, history[0].approvedAt) : "",
      newestRetainedAt: history.length ? text(history[history.length - 1].checkDate, history[history.length - 1].approvedAt) : ""
    };
    var account = previous ? text(previous.accountIdRef) : "";
    if (hasOwn(input, "accountIdRef") && text(input.accountIdRef)) account = opaqueAccountRef(input.accountIdRef);
    var status = previous ? normalizeProgramStatus(previous.status) : normalizeProgramStatus(input.status);
    if (!previous || !incomingLatest || incomingPromotes) {
      if (hasOwn(input, "status")) status = normalizeProgramStatus(input.status);
    }
    var assignedCount = previous ? Math.floor(nonNegative(previous.assignedCount, 0)) : 0;
    var completedCount = previous ? Math.floor(nonNegative(previous.completedCount, 0)) : 0;
    if (hasOwn(input, "assignedCount") && input.assignedCount !== "" && input.assignedCount != null) {
      assignedCount = Math.floor(nonNegative(input.assignedCount, assignedCount));
    }
    if (hasOwn(input, "completedCount") && input.completedCount !== "" && input.completedCount != null) {
      completedCount = Math.floor(nonNegative(input.completedCount, completedCount));
    }
    var lastCheckedAt = previous ? text(previous.lastCheckedAt) : "";
    if (!incomingLatest || incomingPromotes) lastCheckedAt = text(input.lastCheckedAt, lastCheckedAt);
    var evidenceRefs = Array.from(new Set(
      asArray(previous && previous.evidenceRefs).concat(asArray(input.evidenceRefs)).map(String)
    )).slice(-100);
    var record = {
      programStateId: previous ? previous.programStateId : requestedId,
      studentCode: studentCode,
      providerId: providerId,
      accountIdRef: account,
      status: status,
      assignedCount: assignedCount,
      completedCount: completedCount,
      lastCheckedAt: lastCheckedAt,
      evidenceRefs: evidenceRefs,
      checkNeededReason: hasOwn(input, "checkNeededReason") ? text(input.checkNeededReason) : text(previous && previous.checkNeededReason),
      deepLink: hasOwn(input, "deepLink") ? safeHttpUrl(input.deepLink) : safeHttpUrl(previous && previous.deepLink),
      latestSnapshot: latest,
      history: history,
      historyRetention: historyRetention,
      revision: previous
        ? Number(previous.revision || 0) + 1
        : Math.max(1, Math.floor(nonNegative(input.revision, 1)))
    };
    if (index >= 0) next.programStates[index] = record;
    else next.programStates.push(record);
    return next;
  }

  function applyApprovedProgramImport(state, candidate, registryInput) {
    ensure(isObject(candidate), "approved program candidate is required");
    ensure(candidate.workflow_stage === "approved" && candidate.approval_status === "approved",
      "only approved program candidates can be applied");
    ensure(candidate.confirmed === true && candidate.ledger_write_allowed === true,
      "approved candidate flags are required");
    ensure(text(candidate.approved_by) && text(candidate.approved_at), "approval actor and time are required");
    ensure(!hasCredentialField(candidate), "credentials and passwords must not be stored");
    var studentCode = text(candidate.student_code);
    ensure(studentCode === text(state.student && state.student.studentCode), "candidate student does not match state");
    var providerId = text(candidate.provider_id).toLowerCase();
    var accountRef = opaqueAccountRef(candidate.account_id_ref);
    var data = isObject(candidate.data) ? clone(candidate.data) : {};
    var snapshot = normalizeProgramSnapshot({
      snapshotId: candidate.duplicate_key,
      payloadHash: candidate.payload_hash,
      providerId: providerId,
      studentCode: studentCode,
      checkDate: candidate.check_date,
      status: candidate.final_status,
      data: data,
      sourceHash: candidate.source_hash,
      sourceRef: candidate.source_ref,
      sourceDate: candidate.source_date,
      approvedBy: candidate.approved_by,
      approvedAt: candidate.approved_at
    });
    var update = {
      studentCode: studentCode,
      providerId: providerId,
      status: candidate.final_status,
      lastCheckedAt: candidate.check_date || candidate.approved_at,
      evidenceRefs: ["import:" + text(candidate.source_hash)],
      latestSnapshot: snapshot,
      historyEntry: snapshot
    };
    if (accountRef) update.accountIdRef = accountRef;
    var assigned = data.assigned_count === undefined ? data.assignedCount : data.assigned_count;
    var completed = data.completed_count === undefined ? data.completedCount : data.completed_count;
    if (assigned !== undefined && assigned !== null && assigned !== "") update.assignedCount = assigned;
    if (completed !== undefined && completed !== null && completed !== "") update.completedCount = completed;
    return upsertStudentProgramState(state, update, registryInput);
  }

  function createPlannerItem(input) {
    var source = input || {};
    var studentCode = text(source.studentCode);
    var date = text(source.date);
    var title = text(source.title);
    ensure(studentCode, "planner item studentCode is required");
    ensure(title, "planner item title is required");
    parseDateOnly(date, "planner item date");
    var sourceType = text(source.sourceType, "personal");
    var verificationRequired = source.verificationRequired === undefined
      ? sourceType !== "personal"
      : Boolean(source.verificationRequired);
    return {
      itemId: text(source.itemId, stableId("plan", studentCode, date, sourceType, title, source.originItemId || "")),
      planId: text(source.planId, stableId("daily", studentCode, date)),
      studentCode: studentCode,
      date: date,
      title: title,
      detail: text(source.detail),
      sourceType: sourceType,
      providerId: text(source.providerId),
      campaignId: text(source.campaignId),
      occurrenceId: text(source.occurrenceId),
      remediationCaseId: text(source.remediationCaseId),
      originItemId: text(source.originItemId),
      minutes: Math.floor(nonNegative(source.minutes, 0)),
      priority: Math.max(0, Math.min(3, Math.floor(nonNegative(source.priority, 1)))),
      status: normalizePlannerStatus(source.status),
      verificationRequired: verificationRequired,
      evidenceRefs: asArray(source.evidenceRefs).map(String),
      verificationEvidenceRefs: asArray(source.verificationEvidenceRefs).map(String),
      verificationDecision: text(source.verificationDecision),
      carryoverRequestedDate: text(source.carryoverRequestedDate),
      completedAt: text(source.completedAt),
      verifiedAt: text(source.verifiedAt),
      verifiedBy: text(source.verifiedBy),
      revision: Math.max(1, Math.floor(nonNegative(source.revision, 1)))
    };
  }

  function addPlannerItem(state, itemInput) {
    var item = createPlannerItem(itemInput);
    var next = clone(state);
    var index = next.plannerItems.findIndex(function (existing) {
      return existing.itemId === item.itemId;
    });
    if (index >= 0) {
      item.revision = Number(next.plannerItems[index].revision || 0) + 1;
      next.plannerItems[index] = item;
    } else {
      next.plannerItems.push(item);
    }
    return next;
  }

  function updatePlannerItem(state, itemId, updater) {
    ensure(typeof updater === "function", "planner updater is required");
    var next = clone(state);
    var index = next.plannerItems.findIndex(function (item) {
      return item.itemId === itemId;
    });
    ensure(index >= 0, "planner item not found: " + itemId);
    var current = next.plannerItems[index];
    var updated = updater(clone(current));
    updated.revision = Number(current.revision || 0) + 1;
    next.plannerItems[index] = createPlannerItem(updated);
    return next;
  }

  function claimPlannerItemCompletion(state, itemId, evidenceRef, claimedAt) {
    return updatePlannerItem(state, itemId, function (item) {
      ensure(["planned", "in_progress", "check_needed"].indexOf(item.status) >= 0, "item cannot be claimed from " + item.status);
      if (text(evidenceRef)) {
        item.evidenceRefs = item.evidenceRefs.concat([String(evidenceRef)]);
      }
      item.completedAt = text(claimedAt, new Date().toISOString());
      item.status = item.verificationRequired ? "verification_waiting" : "completed";
      return item;
    });
  }

  function verifyPlannerItemCompletion(state, itemId, verification) {
    var input = verification || {};
    ensure(typeof input.approved === "boolean", "approved decision is required");
    ensure(text(input.verifiedBy), "verifiedBy is required");
    ensure(text(input.evidenceRef), "verification evidenceRef is required");
    return updatePlannerItem(state, itemId, function (item) {
      ensure(item.status === "verification_waiting", "only verification_waiting items can be verified");
      item.status = input.approved ? "completed" : "check_needed";
      item.verificationDecision = input.approved ? "approved" : "rejected";
      item.verificationEvidenceRefs = item.verificationEvidenceRefs.concat([text(input.evidenceRef)]);
      item.verifiedBy = text(input.verifiedBy);
      item.verifiedAt = text(input.verifiedAt, new Date().toISOString());
      return item;
    });
  }

  function requestPlannerCarryover(state, itemId, requestedDate) {
    parseDateOnly(requestedDate, "carryover requestedDate");
    return updatePlannerItem(state, itemId, function (item) {
      ensure(["planned", "in_progress", "check_needed"].indexOf(item.status) >= 0, "item cannot be carried over");
      item.status = "carryover_candidate";
      item.carryoverRequestedDate = requestedDate;
      return item;
    });
  }

  function approvePlannerCarryover(state, itemId, approval) {
    var input = approval || {};
    ensure(text(input.approvedBy), "approvedBy is required");
    var current = state.plannerItems.find(function (item) {
      return item.itemId === itemId;
    });
    ensure(current && current.status === "carryover_candidate", "carryover candidate not found");
    var targetDate = text(input.date, current.carryoverRequestedDate);
    parseDateOnly(targetDate, "carryover date");
    var next = updatePlannerItem(state, itemId, function (item) {
      item.status = "carried_over";
      item.verifiedBy = text(input.approvedBy);
      item.verifiedAt = text(input.approvedAt, new Date().toISOString());
      return item;
    });
    return addPlannerItem(next, Object.assign({}, current, {
      itemId: stableId("plan", current.studentCode, targetDate, current.sourceType, current.title, current.itemId),
      planId: stableId("daily", current.studentCode, targetDate),
      date: targetDate,
      originItemId: current.itemId,
      status: "planned",
      carryoverRequestedDate: "",
      completedAt: "",
      verifiedAt: "",
      verifiedBy: "",
      revision: 1
    }));
  }

  function plannerSort(left, right) {
    return left.date !== right.date
      ? left.date.localeCompare(right.date)
      : left.priority !== right.priority
        ? right.priority - left.priority
        : left.title.localeCompare(right.title, "ko");
  }

  function getTodayPlan(state, date) {
    parseDateOnly(date, "today plan date");
    var items = asArray(state.plannerItems).filter(function (item) {
      return item.date === date && item.status !== "canceled";
    }).sort(plannerSort);
    return {
      date: date,
      active: items.filter(function (item) {
        return ["planned", "in_progress", "check_needed"].indexOf(item.status) >= 0;
      }),
      verificationWaiting: items.filter(function (item) {
        return item.status === "verification_waiting";
      }),
      carryover: items.filter(function (item) {
        return ["carryover_candidate", "carried_over"].indexOf(item.status) >= 0;
      }),
      completed: items.filter(function (item) {
        return item.status === "completed";
      }),
      all: items
    };
  }

  function getWeekPlan(state, anchorDate) {
    var weekStart = startOfWeek(anchorDate, state.settings && state.settings.weekStartsOn);
    var weekEnd = addDays(weekStart, 6);
    var items = asArray(state.plannerItems).filter(function (item) {
      return compareDates(item.date, weekStart) >= 0 &&
        compareDates(item.date, weekEnd) <= 0 &&
        item.status !== "canceled";
    }).sort(plannerSort);
    var days = [];
    var offset;
    for (offset = 0; offset < 7; offset += 1) {
      var date = addDays(weekStart, offset);
      days.push({
        date: date,
        items: items.filter(function (item) {
          return item.date === date;
        })
      });
    }
    return { weekStart: weekStart, weekEnd: weekEnd, days: days, items: items };
  }

  function assessmentTitle(scheduleType) {
    return {
      nelt: "NELT 정기 진단",
      metamath_weekly: "메타수학 주간평가",
      metamath_month_end: "메타수학 월말평가",
      custom: "정기 평가"
    }[scheduleType] || "정기 평가";
  }

  function createAssessmentSchedule(input) {
    var source = input || {};
    var studentCode = text(source.studentCode);
    var scheduleType = text(source.scheduleType);
    var cadence = source.cadence || {};
    ensure(studentCode, "assessment studentCode is required");
    ensure(["nelt", "metamath_weekly", "metamath_month_end", "custom"].indexOf(scheduleType) >= 0, "scheduleType is invalid");
    ensure(["months", "weekly", "month_end", "once"].indexOf(cadence.kind) >= 0, "cadence kind is invalid");
    parseDateOnly(source.anchorDate, "assessment anchorDate");
    if (cadence.kind === "weekly") {
      ensure(Number.isInteger(Number(cadence.weekday)) && Number(cadence.weekday) >= 0 && Number(cadence.weekday) <= 6, "weekday must be 0-6");
    }
    return {
      scheduleId: text(source.scheduleId, stableId("schedule", studentCode, scheduleType, source.anchorDate)),
      studentCode: studentCode,
      scheduleType: scheduleType,
      providerId: text(source.providerId, scheduleType.indexOf("metamath") === 0 ? "metamath" : scheduleType === "nelt" ? "nelt" : "manual"),
      title: text(source.title, assessmentTitle(scheduleType)),
      anchorDate: source.anchorDate,
      cadence: {
        kind: cadence.kind,
        interval: Math.max(1, Math.floor(nonNegative(cadence.interval, 1))),
        weekday: cadence.weekday === undefined ? null : Number(cadence.weekday),
        activeWeekdays: asArray(cadence.activeWeekdays).length ? cadence.activeWeekdays.map(Number) : [1, 2, 3, 4, 5]
      },
      durationMinutes: Math.floor(nonNegative(source.durationMinutes, scheduleType === "nelt" ? 40 : 30)),
      enabled: source.enabled !== false,
      verificationRequired: source.verificationRequired !== false,
      revision: Math.max(1, Math.floor(nonNegative(source.revision, 1)))
    };
  }

  function createNeltSchedule(input) {
    var source = input || {};
    return createAssessmentSchedule(Object.assign({}, source, {
      scheduleType: "nelt",
      providerId: "nelt",
      cadence: { kind: "months", interval: Math.max(1, Math.floor(nonNegative(source.intervalMonths, 3))) }
    }));
  }

  function createMetaMathSchedule(input) {
    var source = input || {};
    var kind = text(source.kind, "weekly");
    ensure(["weekly", "month_end"].indexOf(kind) >= 0, "MetaMath kind is invalid");
    return createAssessmentSchedule(Object.assign({}, source, {
      scheduleType: kind === "weekly" ? "metamath_weekly" : "metamath_month_end",
      providerId: "metamath",
      cadence: kind === "weekly"
        ? {
          kind: "weekly",
          interval: Math.max(1, Math.floor(nonNegative(source.intervalWeeks, 1))),
          weekday: source.weekday === undefined ? 5 : Number(source.weekday)
        }
        : {
          kind: "month_end",
          interval: Math.max(1, Math.floor(nonNegative(source.intervalMonths, 1))),
          activeWeekdays: asArray(source.activeWeekdays).length ? source.activeWeekdays : [1, 2, 3, 4, 5]
        }
    }));
  }

  function createOccurrence(schedule, date) {
    return {
      occurrenceId: stableId("occurrence", schedule.scheduleId, date),
      scheduleId: schedule.scheduleId,
      studentCode: schedule.studentCode,
      scheduleType: schedule.scheduleType,
      providerId: schedule.providerId,
      title: schedule.title,
      scheduledDate: date,
      durationMinutes: schedule.durationMinutes,
      status: "scheduled",
      verificationStatus: schedule.verificationRequired ? "required" : "not_required",
      externalRef: "",
      revision: 1
    };
  }

  function expandAssessmentSchedule(scheduleInput, fromDate, toDate) {
    var schedule = createAssessmentSchedule(scheduleInput);
    parseDateOnly(fromDate, "range fromDate");
    parseDateOnly(toDate, "range toDate");
    ensure(compareDates(fromDate, toDate) <= 0, "assessment range is reversed");
    if (!schedule.enabled) {
      return [];
    }
    var output = [];
    var cadence = schedule.cadence;
    var iteration;
    if (cadence.kind === "months") {
      for (iteration = 0; iteration < 1000; iteration += 1) {
        var monthDate = addMonthsClamped(schedule.anchorDate, iteration * cadence.interval);
        if (compareDates(monthDate, toDate) > 0) {
          break;
        }
        if (compareDates(monthDate, fromDate) >= 0) {
          output.push(createOccurrence(schedule, monthDate));
        }
      }
      return output;
    }
    if (cadence.kind === "weekly") {
      var base = compareDates(schedule.anchorDate, fromDate) > 0 ? schedule.anchorDate : fromDate;
      var weeklyDate = nextOrSameWeekday(base, cadence.weekday);
      for (iteration = 0; iteration < 1000 && compareDates(weeklyDate, toDate) <= 0; iteration += 1) {
        output.push(createOccurrence(schedule, weeklyDate));
        weeklyDate = addDays(weeklyDate, 7 * cadence.interval);
      }
      return output;
    }
    if (cadence.kind === "month_end") {
      var from = parseDateOnly(fromDate);
      var anchor = parseDateOnly(schedule.anchorDate);
      var cursorMonth = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
      if (cursorMonth.getTime() < Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1)) {
        cursorMonth = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
      }
      for (iteration = 0; iteration < 240; iteration += cadence.interval) {
        var cursor = new Date(Date.UTC(cursorMonth.getUTCFullYear(), cursorMonth.getUTCMonth() + iteration, 1));
        var endDate = lastLearningDayOfMonth(cursor.getUTCFullYear(), cursor.getUTCMonth(), cadence.activeWeekdays);
        if (compareDates(endDate, toDate) > 0) {
          break;
        }
        if (compareDates(endDate, fromDate) >= 0 && compareDates(endDate, schedule.anchorDate) >= 0) {
          output.push(createOccurrence(schedule, endDate));
        }
      }
      return output;
    }
    if (compareDates(schedule.anchorDate, fromDate) >= 0 && compareDates(schedule.anchorDate, toDate) <= 0) {
      output.push(createOccurrence(schedule, schedule.anchorDate));
    }
    return output;
  }

  function assessmentOccurrenceToPlannerItem(occurrence) {
    return createPlannerItem({
      itemId: stableId("plan", occurrence.studentCode, occurrence.scheduledDate, occurrence.occurrenceId),
      studentCode: occurrence.studentCode,
      date: occurrence.scheduledDate,
      title: occurrence.title,
      sourceType: "assessment",
      providerId: occurrence.providerId,
      occurrenceId: occurrence.occurrenceId,
      minutes: occurrence.durationMinutes,
      priority: 2,
      status: "planned",
      verificationRequired: occurrence.verificationStatus === "required"
    });
  }

  function addAssessmentSchedule(state, scheduleInput, range) {
    var schedule = createAssessmentSchedule(scheduleInput);
    var next = clone(state);
    var index = next.assessmentSchedules.findIndex(function (item) {
      return item.scheduleId === schedule.scheduleId;
    });
    if (index >= 0) {
      schedule.revision = Number(next.assessmentSchedules[index].revision || 0) + 1;
      next.assessmentSchedules[index] = schedule;
    } else {
      next.assessmentSchedules.push(schedule);
    }
    if (range && range.fromDate && range.toDate) {
      expandAssessmentSchedule(schedule, range.fromDate, range.toDate).forEach(function (occurrence) {
        if (!next.assessmentOccurrences.some(function (item) {
          return item.occurrenceId === occurrence.occurrenceId;
        })) {
          next.assessmentOccurrences.push(occurrence);
        }
        if (!next.plannerItems.some(function (item) {
          return item.occurrenceId === occurrence.occurrenceId;
        })) {
          next.plannerItems.push(assessmentOccurrenceToPlannerItem(occurrence));
        }
      });
    }
    return next;
  }

  function getElementaryCampaignOptions() {
    return Object.keys(CAMPAIGN_TYPES).filter(function (key) {
      return CAMPAIGN_TYPES[key].elementarySelectable;
    }).map(function (key) {
      return { value: key, label: CAMPAIGN_TYPES[key].label, prepMode: CAMPAIGN_TYPES[key].prepMode };
    });
  }

  function createPrepCampaign(input, studentInput, settingsInput) {
    var source = input || {};
    var student = createStudentProfile(studentInput || {});
    var settings = settingsInput || {};
    var type = text(source.campaignType, "custom");
    ensure(Boolean(CAMPAIGN_TYPES[type]), "campaign type is invalid");
    parseDateOnly(source.examDate, "campaign examDate");
    var blocked = student.academicStage === "elementary" &&
      type === "school_regular" &&
      settings.schoolRegularExamEnabled !== true;
    var consentStatus = text(source.consentStatus, student.academicStage === "elementary" ? "pending" : "not_required");
    var initialStatus = blocked
      ? "draft"
      : student.academicStage === "elementary" && consentStatus !== "approved"
        ? "consent_pending"
        : text(source.status, "planned");
    if (CAMPAIGN_STATUSES.indexOf(initialStatus) < 0) {
      initialStatus = "review_pending";
    }
    var typeConfig = CAMPAIGN_TYPES[type];
    var startDate = text(source.startDate, addDays(source.examDate, type === "contest" || type === "kmt" ? -42 : -28));
    parseDateOnly(startDate, "campaign startDate");
    return {
      campaignId: text(source.campaignId, stableId("campaign", student.studentCode, type, source.provider, source.examDate, source.title)),
      studentCode: student.studentCode,
      campaignType: type,
      academicStage: student.academicStage,
      grade: student.grade,
      title: text(source.title, typeConfig.label),
      provider: text(source.provider),
      prepMode: text(source.prepMode, typeConfig.prepMode),
      examDate: source.examDate,
      datePrecision: text(source.datePrecision, "exact"),
      registrationDueAt: text(source.registrationDueAt),
      resultExpectedAt: text(source.resultExpectedAt),
      subjectCodes: asArray(source.subjectCodes).map(String),
      syllabusSnapshot: text(source.syllabusSnapshot),
      goalType: text(source.goalType, student.academicStage === "elementary" ? "participation_or_mastery" : "curriculum_mastery"),
      goalValue: source.goalValue === undefined ? null : source.goalValue,
      startDate: startDate,
      intensity: text(source.intensity, "standard"),
      consentStatus: consentStatus,
      consentEvidenceRef: text(source.consentEvidenceRef),
      consentApprovedBy: text(source.consentApprovedBy),
      consentApprovedAt: text(source.consentApprovedAt),
      participationSource: text(source.participationSource, "manual_selection"),
      ownerId: text(source.ownerId),
      reviewerId: text(source.reviewerId),
      visibility: text(source.visibility, "student_teacher_parent_summary"),
      status: initialStatus,
      activationBlockedReason: blocked ? "ELEMENTARY_REGULAR_EXAM_DISABLED" : "",
      migrationReviewRequired: Boolean(source.migrationReviewRequired),
      revision: Math.max(1, Math.floor(nonNegative(source.revision, 1)))
    };
  }

  function addPrepCampaign(state, input) {
    var campaign = createPrepCampaign(input, state.student, state.settings);
    var next = clone(state);
    var index = next.prepCampaigns.findIndex(function (item) {
      return item.campaignId === campaign.campaignId;
    });
    if (index >= 0) {
      campaign.revision = Number(next.prepCampaigns[index].revision || 0) + 1;
      next.prepCampaigns[index] = campaign;
    } else {
      next.prepCampaigns.push(campaign);
    }
    return next;
  }

  function activatePrepCampaign(state, campaignId, approval) {
    var input = approval || {};
    ensure(text(input.approvedBy), "approvedBy is required");
    var next = clone(state);
    var index = next.prepCampaigns.findIndex(function (item) {
      return item.campaignId === campaignId;
    });
    ensure(index >= 0, "campaign not found");
    var campaign = next.prepCampaigns[index];
    ensure(!campaign.activationBlockedReason, "campaign activation is blocked");
    if (campaign.academicStage === "elementary") {
      var consentEvidenceRef = text(input.consentEvidenceRef, campaign.consentEvidenceRef);
      var consentApprovedBy = text(input.consentApprovedBy, campaign.consentApprovedBy);
      var consentApprovedAt = text(input.consentApprovedAt, campaign.consentApprovedAt);
      ensure(consentEvidenceRef, "elementary consent evidenceRef is required");
      ensure(consentApprovedBy, "elementary consent approvedBy is required");
      ensure(consentApprovedAt, "elementary consent approvedAt is required");
      ensure(Number.isFinite(Date.parse(consentApprovedAt)), "elementary consent approvedAt must be a timestamp");
      campaign.consentStatus = "approved";
      campaign.consentEvidenceRef = consentEvidenceRef;
      campaign.consentApprovedBy = consentApprovedBy;
      campaign.consentApprovedAt = new Date(Date.parse(consentApprovedAt)).toISOString();
    }
    campaign.status = "active";
    campaign.reviewerId = text(input.approvedBy);
    campaign.revision = Number(campaign.revision || 0) + 1;
    next.prepCampaigns[index] = campaign;
    return next;
  }

  function buildCampaignMilestones(campaignInput, options) {
    var campaign = clone(campaignInput);
    parseDateOnly(campaign.examDate, "campaign examDate");
    var currentDate = text(options && options.today, todayDate("Asia/Seoul"));
    parseDateOnly(currentDate, "milestone today");
    var templates = campaign.prepMode === "orientation_only" ? ORIENTATION_MILESTONES : COMMON_MILESTONES;
    return templates.map(function (template) {
      var dueDate = addDays(campaign.examDate, template.offset);
      return {
        milestoneId: stableId("milestone", campaign.campaignId, template.key),
        campaignId: campaign.campaignId,
        key: template.key,
        offsetDays: template.offset,
        dueDate: dueDate,
        title: template.title,
        minutes: template.minutes,
        status: compareDates(dueDate, currentDate) < 0 ? "check_needed" : "planned"
      };
    }).filter(function (milestone) {
      var withinCampaignWindow = !campaign.startDate ||
        compareDates(milestone.dueDate, campaign.startDate) >= 0 ||
        milestone.offsetDays >= 0;
      return withinCampaignWindow && compareDates(milestone.dueDate, currentDate) >= 0;
    });
  }

  function campaignMilestonesToPlannerItems(campaign, options) {
    return buildCampaignMilestones(campaign, options).filter(function (milestone) {
      return milestone.minutes > 0;
    }).map(function (milestone) {
      return createPlannerItem({
        itemId: stableId("plan", campaign.studentCode, milestone.dueDate, milestone.milestoneId),
        studentCode: campaign.studentCode,
        date: milestone.dueDate,
        title: campaign.title + " · " + milestone.title,
        sourceType: "prep_campaign",
        campaignId: campaign.campaignId,
        minutes: milestone.minutes,
        priority: milestone.offsetDays >= -3 && milestone.offsetDays <= 0 ? 2 : 1,
        status: milestone.status,
        verificationRequired: true
      });
    });
  }

  function getSoftCap(studentInput) {
    var student = createStudentProfile(studentInput || {});
    if (student.academicStage === "elementary") {
      if (student.grade <= 2) {
        return { sessionMinutes: 15, weeklyMinutes: 45, maxActiveCampaigns: 1, restDays: 1 };
      }
      if (student.grade <= 4) {
        return { sessionMinutes: 20, weeklyMinutes: 80, maxActiveCampaigns: 2, restDays: 1 };
      }
      return { sessionMinutes: 30, weeklyMinutes: 120, maxActiveCampaigns: 2, restDays: 1 };
    }
    return student.academicStage === "middle"
      ? { sessionMinutes: 45, weeklyMinutes: 240, maxActiveCampaigns: 3, restDays: 1 }
      : { sessionMinutes: 60, weeklyMinutes: 360, maxActiveCampaigns: 3, restDays: 1 };
  }

  function analyzeWorkload(input) {
    var source = input || {};
    var student = createStudentProfile(source.student || {});
    var cap = getSoftCap(student);
    var weekStart = startOfWeek(text(source.anchorDate, todayDate(student.timeZone)), 1);
    var weekEnd = addDays(weekStart, 6);
    var dailyMinutes = {};
    var warnings = [];
    asArray(source.items).filter(function (item) {
      return compareDates(item.date, weekStart) >= 0 &&
        compareDates(item.date, weekEnd) <= 0 &&
        ["canceled", "carried_over"].indexOf(item.status) < 0;
    }).forEach(function (item) {
      var minutes = nonNegative(item.minutes, 0);
      dailyMinutes[item.date] = (dailyMinutes[item.date] || 0) + minutes;
      // 정기 진단/평가는 시험 자체 소요시간이므로 일반 자율학습의 1회 권장량과
      // 직접 비교하지 않는다. 주간 총량에는 포함해 일정 과밀은 계속 알린다.
      if (item.sourceType !== "assessment" && minutes > cap.sessionMinutes) {
        warnings.push({
          code: "SESSION_SOFT_CAP",
          soft: true,
          itemId: item.itemId,
          message: item.title + "의 예상 시간이 1회 권장량 " + cap.sessionMinutes + "분을 넘습니다."
        });
      }
    });
    var weeklyMinutes = Object.keys(dailyMinutes).reduce(function (sum, date) {
      return sum + dailyMinutes[date];
    }, 0);
    if (weeklyMinutes > cap.weeklyMinutes) {
      warnings.push({
        code: "WEEKLY_SOFT_CAP",
        soft: true,
        message: "이번 주 예정량 " + weeklyMinutes + "분이 권장량 " + cap.weeklyMinutes + "분을 넘습니다."
      });
    }
    var activeCampaignCount = asArray(source.campaigns).filter(function (campaign) {
      return ["planned", "active", "exam_ready"].indexOf(campaign.status) >= 0;
    }).length;
    if (activeCampaignCount > cap.maxActiveCampaigns) {
      warnings.push({
        code: "CAMPAIGN_SOFT_CAP",
        soft: true,
        message: "동시 시험대비 캠페인이 권장 개수 " + cap.maxActiveCampaigns + "개를 넘습니다."
      });
    }
    var activeDays = Object.keys(dailyMinutes).filter(function (date) {
      return dailyMinutes[date] > 0;
    }).length;
    if (7 - activeDays < cap.restDays) {
      warnings.push({
        code: "REST_DAY_REQUIRED",
        soft: true,
        message: "이번 주에는 캠페인 과제가 없는 날을 하루 이상 확보해 주세요."
      });
    }
    return {
      weekStart: weekStart,
      weekEnd: weekEnd,
      cap: cap,
      dailyMinutes: dailyMinutes,
      weeklyMinutes: weeklyMinutes,
      activeCampaignCount: activeCampaignCount,
      warnings: warnings,
      exceeded: warnings.length > 0
    };
  }

  function createWrongAnswerCase(input) {
    var source = input || {};
    var studentCode = text(source.studentCode);
    var textbookId = text(source.textbookId);
    var page = text(source.page);
    var problemNo = text(source.problemNo);
    ensure(studentCode, "wrong-answer studentCode is required");
    ensure(textbookId, "textbookId is required");
    ensure(page && problemNo, "page and problemNo are required");
    var createdAt = text(source.createdAt, new Date().toISOString());
    return {
      caseId: text(source.caseId, stableId("wrong", studentCode, textbookId, source.edition, page, problemNo)),
      studentCode: studentCode,
      textbookId: textbookId,
      edition: text(source.edition),
      unitId: text(source.unitId),
      page: page,
      problemNo: problemNo,
      skillCode: text(source.skillCode),
      status: WRONG_ANSWER_STATUSES.indexOf(source.status) >= 0 ? source.status : "captured",
      generationRequestId: text(source.generationRequestId),
      metaMathProblemSetId: text(source.metaMathProblemSetId),
      assignmentId: text(source.assignmentId),
      attemptNo: Math.max(0, Math.floor(nonNegative(source.attemptNo, 0))),
      attempts: asArray(source.attempts),
      nextRecheckDate: text(source.nextRecheckDate),
      masteryRule: text(source.masteryRule, "teacher_verified"),
      verifiedBy: text(source.verifiedBy),
      revision: Math.max(1, Math.floor(nonNegative(source.revision, 1))),
      history: asArray(source.history).length ? asArray(source.history) : [{
        from: "",
        to: "captured",
        at: createdAt,
        actor: text(source.createdBy, "system")
      }]
    };
  }

  function transitionWrongAnswerCase(caseInput, nextStatus, metadata) {
    var current = createWrongAnswerCase(caseInput);
    var meta = metadata || {};
    ensure(WRONG_ANSWER_STATUSES.indexOf(nextStatus) >= 0, "wrong-answer status is invalid");
    ensure(WRONG_TRANSITIONS[current.status].indexOf(nextStatus) >= 0, "invalid transition: " + current.status + " -> " + nextStatus);
    if (nextStatus === "mastered") {
      ensure(text(meta.verifiedBy), "mastery requires verifiedBy");
    }
    var next = clone(current);
    next.status = nextStatus;
    next.revision += 1;
    next.verifiedBy = nextStatus === "mastered" ? text(meta.verifiedBy) : next.verifiedBy;
    if (meta.generationRequestId !== undefined) {
      next.generationRequestId = text(meta.generationRequestId);
    }
    if (meta.metaMathProblemSetId !== undefined) {
      next.metaMathProblemSetId = text(meta.metaMathProblemSetId);
    }
    if (meta.assignmentId !== undefined) {
      next.assignmentId = text(meta.assignmentId);
    }
    if (meta.nextRecheckDate !== undefined) {
      parseDateOnly(meta.nextRecheckDate, "next recheck date");
      next.nextRecheckDate = meta.nextRecheckDate;
    }
    next.history.push({
      from: current.status,
      to: nextStatus,
      at: text(meta.at, new Date().toISOString()),
      actor: text(meta.actor, meta.verifiedBy || "system"),
      note: text(meta.note)
    });
    return next;
  }

  function requestTwinGeneration(caseInput, metadata) {
    var meta = metadata || {};
    return transitionWrongAnswerCase(caseInput, "generation_requested", {
      generationRequestId: text(meta.generationRequestId, stableId("generation", caseInput.caseId, Number(caseInput.attemptNo || 0) + 1)),
      actor: meta.actor,
      at: meta.at,
      note: meta.note
    });
  }

  function recordTwinResult(caseInput, result) {
    var current = createWrongAnswerCase(caseInput);
    var input = result || {};
    ensure(["submitted", "result_waiting"].indexOf(current.status) >= 0, "result can only be recorded after submission");
    ensure(text(input.externalResultRef), "externalResultRef is required");
    var next = clone(current);
    next.attemptNo = Number(current.attemptNo || 0) + 1;
    next.attempts.push({
      attemptNo: next.attemptNo,
      externalResultRef: text(input.externalResultRef),
      correctCount: Math.floor(nonNegative(input.correctCount, 0)),
      totalCount: Math.floor(nonNegative(input.totalCount, 0)),
      receivedAt: text(input.receivedAt, new Date().toISOString())
    });
    next.status = "verification_waiting";
    next.revision += 1;
    next.history.push({
      from: current.status,
      to: "verification_waiting",
      at: text(input.receivedAt, new Date().toISOString()),
      actor: text(input.actor, "program_result"),
      note: "결과 수신 후 사람 확인대기"
    });
    return next;
  }

  function reviewTwinResult(caseInput, review) {
    var input = review || {};
    ensure(text(input.verifiedBy), "verifiedBy is required");
    if (input.mastered === true) {
      return transitionWrongAnswerCase(caseInput, "mastered", input);
    }
    if (input.nextRecheckDate) {
      return transitionWrongAnswerCase(caseInput, "recheck_scheduled", input);
    }
    return transitionWrongAnswerCase(caseInput, "retry_required", input);
  }

  function addRemediationCase(state, caseInput) {
    var remediation = createWrongAnswerCase(caseInput);
    var next = clone(state);
    var index = next.remediationCases.findIndex(function (item) {
      return item.caseId === remediation.caseId;
    });
    if (index >= 0) {
      remediation.revision = Number(next.remediationCases[index].revision || 0) + 1;
      next.remediationCases[index] = remediation;
    } else {
      next.remediationCases.push(remediation);
    }
    return next;
  }

  function classifyLegacyExam(exam) {
    var source = [exam.type, exam.title, exam.name, exam.provider].map(text).join(" ");
    if (/NELT/i.test(source)) {
      return "nelt";
    }
    if (/\bKMT\b|한국수학/i.test(source)) {
      return "kmt";
    }
    if (/영재/i.test(source)) {
      return "gifted_admission";
    }
    if (/입학/i.test(source)) {
      return "entrance";
    }
    if (/레벨|placement/i.test(source)) {
      return "level_test";
    }
    if (/경시|올림피아드|contest/i.test(source)) {
      return "contest";
    }
    if (/중간|기말|정기시험|school.?exam/i.test(source)) {
      return "school_regular";
    }
    return "custom";
  }

  function migrateLearningPlatformState(legacyInput, options) {
    var legacy = stripCredentialFields(clone(legacyInput || {}));
    var sourceStudent = legacy.student || {
      studentCode: legacy.studentCode,
      displayName: legacy.studentName || legacy.displayName,
      academicStage: legacy.academicStage,
      grade: legacy.grade
    };
    var state = createDefaultState({ student: sourceStudent });
    var registry = createProviderRegistry(options && options.customProviders);
    var report = {
      fromVersion: Number(legacy.schemaVersion || 0),
      toVersion: SCHEMA_VERSION,
      programs: 0,
      plannerItems: 0,
      campaigns: 0,
      remediationCases: 0,
      warnings: []
    };

    if (Number(legacy.schemaVersion) === SCHEMA_VERSION) {
      state.settings = Object.assign({}, state.settings, legacy.settings || {});
      if (state.student.academicStage === "elementary") {
        state.settings.schoolRegularExamEnabled = false;
      }
      asArray(legacy.programStates).forEach(function (program) {
        var requestedProvider = text(program.providerId).toLowerCase();
        var providerId = registry[requestedProvider] ? requestedProvider : "manual";
        try {
          state = upsertStudentProgramState(state, Object.assign({}, program, {
            providerId: providerId,
            studentCode: text(program.studentCode, state.student.studentCode),
            checkNeededReason: registry[requestedProvider]
              ? program.checkNeededReason
              : "프로그램 공급자 확인필요"
          }), registry);
          report.programs += 1;
        } catch (error) {
          report.warnings.push("프로그램 정규화 보류: " + error.message);
        }
      });
      asArray(legacy.plannerItems).forEach(function (item) {
        try {
          state = addPlannerItem(state, item);
          report.plannerItems += 1;
        } catch (error) {
          report.warnings.push("플래너 정규화 보류: " + error.message);
        }
      });
      state.assessmentSchedules = asArray(legacy.assessmentSchedules).map(function (schedule) {
        return createAssessmentSchedule(schedule);
      });
      state.assessmentOccurrences = clone(asArray(legacy.assessmentOccurrences));
      asArray(legacy.prepCampaigns).forEach(function (campaign) {
        try {
          state = addPrepCampaign(state, campaign);
          report.campaigns += 1;
        } catch (error) {
          report.warnings.push("캠페인 정규화 보류: " + error.message);
        }
      });
      asArray(legacy.remediationCases).forEach(function (remediation) {
        try {
          state = addRemediationCase(state, remediation);
          report.remediationCases += 1;
        } catch (error) {
          report.warnings.push("오답 정규화 보류: " + error.message);
        }
      });
      state.migrationIssues = asArray(legacy.migrationIssues).concat(report.warnings);
      report.alreadyCurrent = true;
      return { state: state, report: report };
    }

    var programSource = asArray(legacy.programStates).length
      ? legacy.programStates
      : asArray(legacy.onlinePrograms).length
        ? legacy.onlinePrograms
        : asArray(legacy.programs);
    programSource.forEach(function (program) {
      var requestedProvider = text(program.providerId || program.programId || program.name).toLowerCase();
      var providerId = registry[requestedProvider] ? requestedProvider : "manual";
      try {
        state = upsertStudentProgramState(state, {
          programStateId: program.programStateId,
          studentCode: text(program.studentCode, state.student.studentCode),
          providerId: providerId,
          accountIdRef: program.accountIdRef || program.accountId,
          status: program.status,
          assignedCount: program.assignedCount,
          completedCount: program.completedCount,
          lastCheckedAt: program.lastCheckedAt,
          evidenceRefs: program.evidenceRefs,
          checkNeededReason: registry[requestedProvider] ? program.checkNeededReason : "기존 프로그램 공급자 확인필요",
          deepLink: program.deepLink
        }, registry);
        report.programs += 1;
      } catch (error) {
        report.warnings.push("프로그램 이전 보류: " + error.message);
      }
    });

    var plannerSource = asArray(legacy.plannerItems).length
      ? legacy.plannerItems
      : asArray(legacy.plans).length
        ? legacy.plans
        : asArray(legacy.tasks);
    plannerSource.forEach(function (item, index) {
      var date = text(item.date || item.plannerDate || item.dueDate);
      if (!date) {
        report.warnings.push("날짜 없는 기존 할 일 #" + (index + 1) + " 보류");
        return;
      }
      try {
        state = addPlannerItem(state, {
          itemId: item.itemId || item.id,
          studentCode: text(item.studentCode, state.student.studentCode),
          date: date,
          title: item.title || item.name,
          detail: item.detail,
          sourceType: item.sourceType || "legacy",
          providerId: item.providerId,
          campaignId: item.campaignId,
          minutes: item.minutes || item.estimatedMinutes,
          status: item.status,
          verificationRequired: item.verificationRequired === undefined ? true : item.verificationRequired,
          evidenceRefs: item.evidenceRefs
        });
        report.plannerItems += 1;
      } catch (error) {
        report.warnings.push("플래너 이전 보류 #" + (index + 1) + ": " + error.message);
      }
    });

    var examSource = asArray(legacy.prepCampaigns).length
      ? legacy.prepCampaigns
      : asArray(legacy.exams).length
        ? legacy.exams
        : asArray(legacy.tests);
    examSource.forEach(function (exam, index) {
      var examDate = text(exam.examDate || exam.date);
      if (!examDate) {
        report.warnings.push("날짜 없는 기존 시험 #" + (index + 1) + " 보류");
        return;
      }
      var campaignType = exam.campaignType && CAMPAIGN_TYPES[exam.campaignType]
        ? exam.campaignType
        : classifyLegacyExam(exam);
      try {
        state = addPrepCampaign(state, {
          campaignId: exam.campaignId || exam.id,
          campaignType: campaignType,
          title: exam.title || exam.name,
          provider: exam.provider,
          examDate: examDate,
          startDate: exam.startDate,
          status: "draft",
          consentStatus: state.student.academicStage === "elementary" ? "pending" : "not_required",
          migrationReviewRequired: true,
          participationSource: "legacy_migration",
          subjectCodes: exam.subjectCodes || exam.subjects,
          syllabusSnapshot: exam.syllabusSnapshot || exam.scope
        });
        report.campaigns += 1;
      } catch (error) {
        report.warnings.push("시험 이전 보류 #" + (index + 1) + ": " + error.message);
      }
    });

    asArray(legacy.wrongAnswers).forEach(function (wrongAnswer, index) {
      try {
        state = addRemediationCase(state, {
          caseId: wrongAnswer.caseId || wrongAnswer.id,
          studentCode: text(wrongAnswer.studentCode, state.student.studentCode),
          textbookId: wrongAnswer.textbookId || wrongAnswer.bookId || "legacy-textbook",
          edition: wrongAnswer.edition,
          unitId: wrongAnswer.unitId,
          page: wrongAnswer.page,
          problemNo: wrongAnswer.problemNo || wrongAnswer.questionNo,
          skillCode: wrongAnswer.skillCode,
          status: wrongAnswer.result ? "check_needed" : "captured",
          createdAt: wrongAnswer.createdAt
        });
        report.remediationCases += 1;
      } catch (error) {
        report.warnings.push("오답 이전 보류 #" + (index + 1) + ": " + error.message);
      }
    });

    if (state.student.academicStage === "elementary") {
      state.settings.schoolRegularExamEnabled = false;
      state.prepCampaigns = state.prepCampaigns.map(function (campaign) {
        if (campaign.campaignType === "school_regular") {
          campaign.status = "draft";
          campaign.activationBlockedReason = "ELEMENTARY_REGULAR_EXAM_DISABLED";
          campaign.migrationReviewRequired = true;
        }
        return campaign;
      });
    }
    state.migrationIssues = report.warnings.slice();
    return { state: state, report: report };
  }

  function dDayLabel(examDate, currentDate) {
    var delta = daysBetween(text(currentDate, todayDate("Asia/Seoul")), examDate);
    return delta === 0 ? "D-day" : delta > 0 ? "D-" + delta : "D+" + Math.abs(delta);
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function badge(label, status) {
    return '<span class="wb-lp__badge wb-lp__badge--' + escapeHtml(status) + '">' + escapeHtml(label) + "</span>";
  }

  function emptyMessage(message) {
    return '<p class="wb-lp__empty">' + escapeHtml(message) + "</p>";
  }

  function plannerItemHtml(item, interactive) {
    var action = interactive && ["planned", "in_progress", "check_needed"].indexOf(item.status) >= 0
      ? '<button class="wb-lp__button wb-lp__button--small" type="button" data-wb-action="claim" data-item-id="' +
        escapeHtml(item.itemId) + '">수행 완료 요청</button>'
      : "";
    return '<li class="wb-lp__task">' +
      '<div class="wb-lp__task-main"><strong>' + escapeHtml(item.title) + "</strong>" +
      '<span class="wb-lp__meta">' + escapeHtml(item.minutes ? item.minutes + "분" : "시간 미정") +
      " · " + escapeHtml(item.sourceType) + "</span></div>" +
      '<div class="wb-lp__task-side">' +
      badge(LABELS.planner[item.status] || item.status, item.status) + action + "</div></li>";
  }

  function renderTodayPlanner(state, date, interactive) {
    var plan = getTodayPlan(state, date);
    var workload = analyzeWorkload({
      student: state.student,
      items: state.plannerItems,
      campaigns: state.prepCampaigns,
      anchorDate: date
    });
    var warningHtml = workload.warnings.length
      ? '<aside class="wb-lp__notice" role="status" aria-label="학습량 안내"><strong>학습량을 한번 살펴봐 주세요.</strong><ul>' +
        workload.warnings.map(function (warning) {
          return "<li>" + escapeHtml(warning.message) + "</li>";
        }).join("") + "</ul></aside>"
      : '<p class="wb-lp__calm" role="status">이번 주 학습량은 현재 소프트캡 안에 있습니다.</p>';
    function group(title, items) {
      return '<section class="wb-lp__group"><h3>' + escapeHtml(title) + "</h3>" +
        (items.length ? '<ul class="wb-lp__task-list">' + items.map(function (item) {
          return plannerItemHtml(item, interactive);
        }).join("") + "</ul>" : emptyMessage("해당 항목이 없습니다.")) + "</section>";
    }
    return '<div class="wb-lp__panel-grid">' +
      '<section class="wb-lp__summary"><h2>' + escapeHtml(date) + " 오늘</h2>" +
      '<p><strong>' + plan.active.length + '</strong>개 수행 예정 · <strong>' +
      plan.verificationWaiting.length + "</strong>개 확인대기</p></section>" +
      warningHtml +
      group("오늘 할 일", plan.active) +
      group("선생님 확인대기", plan.verificationWaiting) +
      group("이월 후보", plan.carryover) +
      group("완료", plan.completed) +
      "</div>";
  }

  function renderWeekPlanner(state, date) {
    var week = getWeekPlan(state, date);
    return '<section><h2>' + escapeHtml(week.weekStart) + " – " + escapeHtml(week.weekEnd) + "</h2>" +
      '<ol class="wb-lp__week">' + week.days.map(function (day) {
        return '<li class="wb-lp__day"><h3>' + escapeHtml(day.date) + "</h3>" +
          (day.items.length ? '<ul class="wb-lp__compact-list">' + day.items.map(function (item) {
            return "<li><span>" + escapeHtml(item.title) + "</span>" +
              badge(LABELS.planner[item.status] || item.status, item.status) + "</li>";
          }).join("") + "</ul>" : emptyMessage("계획 없음")) + "</li>";
      }).join("") + "</ol></section>";
  }

  function renderPrograms(state, registryInput) {
    var registry = registryInput || DEFAULT_PROVIDERS;
    return '<section><div class="wb-lp__section-head"><div><h2>온라인 프로그램</h2>' +
      "<p>계정 비밀번호는 저장하지 않으며, 외부 결과는 확인 후보로만 반영합니다.</p></div></div>" +
      (state.programStates.length ? '<ul class="wb-lp__card-grid">' + state.programStates.map(function (program) {
        var provider = registry[program.providerId] || registry.manual;
        var progress = program.assignedCount > 0
          ? Math.min(100, Math.round(program.completedCount / program.assignedCount * 100))
          : 0;
        var link = program.deepLink
          ? '<a class="wb-lp__button wb-lp__button--secondary" href="' + escapeHtml(program.deepLink) +
            '" target="_blank" rel="noopener noreferrer">프로그램 열기</a>'
          : "";
        return '<li class="wb-lp__card"><div class="wb-lp__card-title"><strong>' +
          escapeHtml(provider.label) + "</strong>" +
          badge(LABELS.program[program.status] || program.status, program.status) + "</div>" +
          '<p class="wb-lp__meta">' + escapeHtml(program.completedCount + "/" + program.assignedCount + " 수행") + "</p>" +
          '<progress max="100" value="' + progress + '" aria-label="' + escapeHtml(provider.label + " 수행률 " + progress + "%") +
          '"></progress>' + link + "</li>";
      }).join("") + "</ul>" : emptyMessage("연결된 온라인 프로그램이 없습니다.")) + "</section>";
  }

  function renderCampaigns(state, date) {
    var options = state.student.academicStage === "elementary"
      ? '<section class="wb-lp__chooser" aria-labelledby="wb-lp-campaign-options"><h3 id="wb-lp-campaign-options">선택 가능한 캠페인</h3>' +
        '<ul class="wb-lp__chip-list">' + getElementaryCampaignOptions().map(function (option) {
          return "<li>" + escapeHtml(option.label) + "</li>";
        }).join("") + "</ul><p>학교 정기시험은 초등 기본값에서 생성되지 않습니다.</p></section>"
      : "";
    return '<section><h2>시험대비 캠페인</h2>' + options +
      (state.prepCampaigns.length ? '<ul class="wb-lp__card-grid">' + state.prepCampaigns.map(function (campaign) {
        var config = CAMPAIGN_TYPES[campaign.campaignType] || CAMPAIGN_TYPES.custom;
        var blocked = campaign.activationBlockedReason
          ? '<p class="wb-lp__warning-text">활성화 전 사람 확인이 필요합니다.</p>'
          : "";
        return '<li class="wb-lp__card"><div class="wb-lp__card-title"><strong>' +
          escapeHtml(campaign.title) + "</strong>" +
          badge(LABELS.campaign[campaign.status] || campaign.status, campaign.status) + "</div>" +
          '<p class="wb-lp__d-day">' + escapeHtml(dDayLabel(campaign.examDate, date)) + "</p>" +
          '<p class="wb-lp__meta">' + escapeHtml(config.label + " · " + campaign.examDate) + "</p>" +
          blocked + "</li>";
      }).join("") + "</ul>" : emptyMessage("활성 캠페인이 없습니다.")) + "</section>";
  }

  function renderRemediation(state) {
    return '<section><h2>오답 재학습</h2><p>교재 오답 → 쌍둥이 문제 → 사람 확인 → 숙달 이력을 보존합니다.</p>' +
      (state.remediationCases.length ? '<ul class="wb-lp__card-grid">' + state.remediationCases.map(function (item) {
        return '<li class="wb-lp__card"><div class="wb-lp__card-title"><strong>' +
          escapeHtml(item.textbookId + " " + item.page + "쪽 " + item.problemNo + "번") + "</strong>" +
          badge(LABELS.remediation[item.status] || item.status, item.status) + "</div>" +
          '<p class="wb-lp__meta">시도 ' + escapeHtml(item.attemptNo) +
          "회" + (item.skillCode ? " · " + escapeHtml(item.skillCode) : "") + "</p></li>";
      }).join("") + "</ul>" : emptyMessage("등록된 오답 재학습 사례가 없습니다.")) + "</section>";
  }

  function tabButton(mountId, tab, label, active) {
    return '<button id="' + mountId + "-tab-" + tab + '" class="wb-lp__tab" type="button" role="tab" ' +
      'aria-selected="' + (active ? "true" : "false") + '" aria-controls="' + mountId + "-panel" +
      '" tabindex="' + (active ? "0" : "-1") + '" data-wb-action="tab" data-tab="' + tab + '">' +
      escapeHtml(label) + "</button>";
  }

  function mountLearningPlatform(rootElement, options) {
    ensure(rootElement && rootElement.nodeType === 1, "mount root element is required");
    var config = options || {};
    var state = clone(config.state || createDemoState(config.today));
    var registry = config.registry || DEFAULT_PROVIDERS;
    var activeTab = text(config.initialTab, "today");
    var currentDate = text(config.today, todayDate(state.student.timeZone));
    var mountId = text(rootElement.id, "wb-lp-" + (++mountSequence));
    var destroyed = false;

    function announce(message) {
      var live = rootElement.querySelector("[data-wb-live]");
      if (live) {
        live.textContent = message;
      }
    }

    function panelHtml() {
      if (activeTab === "week") {
        return renderWeekPlanner(state, currentDate);
      }
      if (activeTab === "programs") {
        return renderPrograms(state, registry);
      }
      if (activeTab === "campaigns") {
        return renderCampaigns(state, currentDate);
      }
      if (activeTab === "remediation") {
        return renderRemediation(state);
      }
      return renderTodayPlanner(state, currentDate, true);
    }

    function render(focusTab) {
      if (destroyed) {
        return;
      }
      rootElement.innerHTML = '<div class="wb-lp">' +
        '<header class="wb-lp__header"><div><p class="wb-lp__eyebrow">WB 학습 플래너</p><h1>' +
        escapeHtml(state.student.displayName) + "</h1></div>" +
        '<p class="wb-lp__privacy">학생 기록은 역할별 공개 범위를 따릅니다.</p></header>' +
        '<div class="wb-lp__sr-only" role="status" aria-live="polite" aria-atomic="true" data-wb-live></div>' +
        '<nav class="wb-lp__tabs" role="tablist" aria-label="학습 플래너 보기">' +
        tabButton(mountId, "today", "오늘", activeTab === "today") +
        tabButton(mountId, "week", "주간", activeTab === "week") +
        tabButton(mountId, "programs", "온라인 프로그램", activeTab === "programs") +
        tabButton(mountId, "campaigns", "시험대비", activeTab === "campaigns") +
        tabButton(mountId, "remediation", "오답 재학습", activeTab === "remediation") +
        '</nav><main id="' + mountId + '-panel" class="wb-lp__tabpanel" role="tabpanel" aria-labelledby="' +
        mountId + "-tab-" + activeTab + '">' + panelHtml() + "</main></div>";
      if (focusTab) {
        var activeButton = rootElement.querySelector('[data-wb-action="tab"][data-tab="' + activeTab + '"]');
        if (activeButton) {
          activeButton.focus();
        }
      }
    }

    function emitChange(action) {
      if (typeof config.onChange === "function") {
        config.onChange(clone(state), action);
      }
    }

    function clickHandler(event) {
      var actionElement = event.target.closest ? event.target.closest("[data-wb-action]") : null;
      if (!actionElement || !rootElement.contains(actionElement)) {
        return;
      }
      var action = actionElement.getAttribute("data-wb-action");
      if (action === "tab") {
        activeTab = actionElement.getAttribute("data-tab");
        render(true);
        return;
      }
      if (action === "claim") {
        var itemId = actionElement.getAttribute("data-item-id");
        try {
          var item = state.plannerItems.find(function (candidate) { return candidate.itemId === itemId; });
          ensure(item, "planner item not found: " + itemId);
          var expectedRevision = Number(item.revision || 1);
          var itemDate = item.date;
          state = claimPlannerItemCompletion(state, itemId, "", new Date().toISOString());
          render(false);
          announce("수행 완료 요청을 선생님 확인대기로 보냈습니다.");
          emitChange({
            type: "planner_completion_claimed",
            itemId: itemId,
            expectedRevision: expectedRevision,
            date: itemDate
          });
        } catch (error) {
          announce(error.message);
        }
      }
    }

    function keyHandler(event) {
      var tab = event.target.closest ? event.target.closest('[role="tab"]') : null;
      if (!tab || !rootElement.contains(tab)) {
        return;
      }
      var tabs = Array.prototype.slice.call(rootElement.querySelectorAll('[role="tab"]'));
      var index = tabs.indexOf(tab);
      var nextIndex = null;
      if (event.key === "ArrowRight") {
        nextIndex = (index + 1) % tabs.length;
      } else if (event.key === "ArrowLeft") {
        nextIndex = (index - 1 + tabs.length) % tabs.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = tabs.length - 1;
      }
      if (nextIndex !== null) {
        event.preventDefault();
        tabs[nextIndex].click();
      }
    }

    rootElement.addEventListener("click", clickHandler);
    rootElement.addEventListener("keydown", keyHandler);
    render(false);
    return {
      getState: function () {
        return clone(state);
      },
      setState: function (nextState) {
        state = clone(nextState);
        render(false);
      },
      selectTab: function (tab) {
        ensure(["today", "week", "programs", "campaigns", "remediation"].indexOf(tab) >= 0, "tab is invalid");
        activeTab = tab;
        render(false);
      },
      destroy: function () {
        destroyed = true;
        rootElement.removeEventListener("click", clickHandler);
        rootElement.removeEventListener("keydown", keyHandler);
        rootElement.innerHTML = "";
      }
    };
  }

  function createDemoState(dateInput) {
    var date = text(dateInput, todayDate("Asia/Seoul"));
    var state = createDefaultState({
      student: {
        studentCode: "DEMO-E3",
        displayName: "데모 학생",
        academicStage: "elementary",
        grade: 3
      }
    });
    state = upsertStudentProgramState(state, {
      providerId: "studyforce",
      status: "active",
      assignedCount: 5,
      completedCount: 3,
      accountIdRef: "demo-studyforce"
    });
    state = upsertStudentProgramState(state, {
      providerId: "classcard",
      status: "partial",
      assignedCount: 4,
      completedCount: 2,
      accountIdRef: "demo-classcard"
    });
    state = addPlannerItem(state, {
      studentCode: state.student.studentCode,
      date: date,
      title: "스터디포스 독해 훈련",
      sourceType: "online_program",
      providerId: "studyforce",
      minutes: 20,
      verificationRequired: true
    });
    state = addPlannerItem(state, {
      studentCode: state.student.studentCode,
      date: addDays(date, 1),
      title: "클래스카드 단어 복습",
      sourceType: "online_program",
      providerId: "classcard",
      minutes: 15,
      verificationRequired: true
    });
    state = addPrepCampaign(state, {
      campaignType: "nelt",
      title: "가을 NELT",
      examDate: addDays(date, 21),
      consentStatus: "approved",
      status: "active",
      provider: "nelt"
    });
    state = addRemediationCase(state, {
      studentCode: state.student.studentCode,
      textbookId: "수학 3-2",
      page: "72",
      problemNo: "13",
      skillCode: "분수 비교"
    });
    return state;
  }

  function autoMount() {
    if (typeof document === "undefined") {
      return [];
    }
    return Array.prototype.slice.call(document.querySelectorAll("[data-wb-learning-platform]")).map(function (element) {
      var date = element.getAttribute("data-today") || undefined;
      return mountLearningPlatform(element, { state: createDemoState(date), today: date });
    });
  }

  return deepFreeze({
    SCHEMA_VERSION: SCHEMA_VERSION,
    PROGRAM_STATUSES: PROGRAM_STATUSES,
    PLANNER_STATUSES: PLANNER_STATUSES,
    CAMPAIGN_STATUSES: CAMPAIGN_STATUSES,
    WRONG_ANSWER_STATUSES: WRONG_ANSWER_STATUSES,
    CAMPAIGN_TYPES: CAMPAIGN_TYPES,
    DEFAULT_PROVIDERS: DEFAULT_PROVIDERS,
    LABELS: LABELS,
    createProviderRegistry: createProviderRegistry,
    createStudentProfile: createStudentProfile,
    createDefaultState: createDefaultState,
    isOpaqueAccountRef: isOpaqueAccountRef,
    upsertStudentProgramState: upsertStudentProgramState,
    applyApprovedProgramImport: applyApprovedProgramImport,
    createPlannerItem: createPlannerItem,
    addPlannerItem: addPlannerItem,
    claimPlannerItemCompletion: claimPlannerItemCompletion,
    verifyPlannerItemCompletion: verifyPlannerItemCompletion,
    requestPlannerCarryover: requestPlannerCarryover,
    approvePlannerCarryover: approvePlannerCarryover,
    getTodayPlan: getTodayPlan,
    getWeekPlan: getWeekPlan,
    createAssessmentSchedule: createAssessmentSchedule,
    createNeltSchedule: createNeltSchedule,
    createMetaMathSchedule: createMetaMathSchedule,
    expandAssessmentSchedule: expandAssessmentSchedule,
    assessmentOccurrenceToPlannerItem: assessmentOccurrenceToPlannerItem,
    addAssessmentSchedule: addAssessmentSchedule,
    getElementaryCampaignOptions: getElementaryCampaignOptions,
    createPrepCampaign: createPrepCampaign,
    addPrepCampaign: addPrepCampaign,
    activatePrepCampaign: activatePrepCampaign,
    buildCampaignMilestones: buildCampaignMilestones,
    campaignMilestonesToPlannerItems: campaignMilestonesToPlannerItems,
    getSoftCap: getSoftCap,
    analyzeWorkload: analyzeWorkload,
    createWrongAnswerCase: createWrongAnswerCase,
    transitionWrongAnswerCase: transitionWrongAnswerCase,
    requestTwinGeneration: requestTwinGeneration,
    recordTwinResult: recordTwinResult,
    reviewTwinResult: reviewTwinResult,
    addRemediationCase: addRemediationCase,
    classifyLegacyExam: classifyLegacyExam,
    migrateLearningPlatformState: migrateLearningPlatformState,
    dDayLabel: dDayLabel,
    renderTodayPlanner: renderTodayPlanner,
    renderWeekPlanner: renderWeekPlanner,
    renderPrograms: renderPrograms,
    renderCampaigns: renderCampaigns,
    renderRemediation: renderRemediation,
    mountLearningPlatform: mountLearningPlatform,
    createDemoState: createDemoState,
    autoMount: autoMount,
    date: {
      today: todayDate,
      addDays: addDays,
      addMonthsClamped: addMonthsClamped,
      daysBetween: daysBetween,
      startOfWeek: startOfWeek
    }
  });
});
