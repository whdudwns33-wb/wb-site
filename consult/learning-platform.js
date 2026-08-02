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
  var PLANNER_HISTORY_LIMIT = 30;
  var LEGACY_PLANNER_ACTOR = "legacy";
  var PROVIDER_HISTORY_LIMIT = 50;
  var ASSESSMENT_HISTORY_LIMIT = 50;
  var ASSESSMENT_RESULT_HISTORY_LIMIT = 20;
  var ASSESSMENT_OCCURRENCE_RANGE_LIMIT = 1000;
  var CAMPAIGN_HISTORY_LIMIT = 50;
  var CAMPAIGN_RESULT_HISTORY_LIMIT = 20;
  var INACTIVE_PROVIDER_RESTORE = {};
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

  var DEFAULT_PROVIDER_IMPORT_ALIASES = deepFreeze({
    studyforce: ["studyforce", "스터디포스", "StudyForce", "study force", "스터디 포스"],
    classcard: ["classcard", "클래스카드", "ClassCard", "class card", "클래스 카드"],
    metamath: ["metamath", "메타수학", "MetaMath", "meta math", "메타 수학"],
    nelt: ["nelt", "넬트", "NELT", "nelt assessment"],
    manual: ["manual", "직접 관리"]
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

  var CAMPAIGN_TRANSITIONS = deepFreeze({
    active: ["exam_ready"],
    exam_ready: ["taken"],
    taken: ["result_waiting"],
    result_waiting: ["result_review"],
    result_review: ["completed"]
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

  function isoTimestamp(value, fieldName) {
    var normalized = text(value);
    ensure(normalized, (fieldName || "timestamp") + " is required");
    ensure(Number.isFinite(Date.parse(normalized)), (fieldName || "timestamp") + " must be a timestamp");
    return new Date(Date.parse(normalized)).toISOString();
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

  function timestampDateInTimeZone(timestamp, timeZone) {
    var instant = timestamp instanceof Date ? timestamp : new Date(Date.parse(timestamp));
    ensure(Number.isFinite(instant.getTime()), "timestamp must be valid");
    try {
      var values = {};
      new Intl.DateTimeFormat("en-CA", {
        timeZone: text(timeZone, "Asia/Seoul"),
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(instant).forEach(function (part) {
        values[part.type] = part.value;
      });
      return values.year + "-" + values.month + "-" + values.day;
    } catch (_error) {
      throw new Error("학생 시간대 설정이 올바르지 않아 평가 결과를 승인할 수 없습니다.");
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

  function normalizeWeekday(value, fieldName) {
    var validNumber = typeof value === "number" && Number.isInteger(value);
    var validString = typeof value === "string" && /^[0-6]$/.test(value);
    ensure(validNumber || validString,
      (fieldName || "weekday") + " must be an integer from 0 to 6");
    var normalized = Number(value);
    ensure(normalized >= 0 && normalized <= 6,
      (fieldName || "weekday") + " must be an integer from 0 to 6");
    return normalized;
  }

  function nextOrSameWeekday(dateOnly, weekday) {
    var date = parseDateOnly(dateOnly);
    var target = normalizeWeekday(weekday, "weekday");
    return addDays(dateOnly, (target - date.getUTCDay() + 7) % 7);
  }

  function lastLearningDayOfMonth(year, monthIndex, activeWeekdays) {
    var weekdays = asArray(activeWeekdays);
    var date = new Date(Date.UTC(year, monthIndex + 1, 0));
    var offset;
    for (offset = 0; offset < 7; offset += 1) {
      if (weekdays.indexOf(date.getUTCDay()) >= 0) {
        return formatDateOnly(date);
      }
      date.setUTCDate(date.getUTCDate() - 1);
    }
    throw new Error("activeWeekdays did not match a day in the month");
  }

  function normalizeActiveWeekdays(value) {
    var source = value === undefined ? [1, 2, 3, 4, 5] : value;
    ensure(Array.isArray(source) && source.length > 0, "activeWeekdays must be a non-empty array");
    var output = [];
    source.forEach(function (weekday) {
      var normalized = normalizeWeekday(weekday, "activeWeekdays");
      if (output.indexOf(normalized) < 0) output.push(normalized);
    });
    ensure(output.length > 0, "activeWeekdays must be a non-empty array");
    return output;
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

  function boundAuditHistory(historyInput, limit, retentionInput) {
    var history = clone(asArray(historyInput));
    var previousRetention = retentionInput || {};
    var droppedNow = Math.max(0, history.length - limit);
    if (droppedNow) history = history.slice(-limit);
    return {
      history: history,
      historyRetention: {
        maxEntries: limit,
        droppedCount: Math.floor(nonNegative(previousRetention.droppedCount, 0)) + droppedNow,
        oldestRetainedAt: history.length ? text(history[0] &&
          (history[0].at || history[0].verifiedAt || history[0].reviewedAt)) : "",
        newestRetainedAt: history.length ? text(history[history.length - 1] &&
          (history[history.length - 1].at || history[history.length - 1].verifiedAt ||
            history[history.length - 1].reviewedAt)) : ""
      }
    };
  }

  function normalizeProviderAliasKey(value) {
    var normalized = text(value);
    if (normalized.normalize) normalized = normalized.normalize("NFKC");
    return normalized.toLowerCase().replace(/[\s_\-./()[\]{}:]+/g, "");
  }

  function normalizeCustomProvider(provider) {
    ensure(isObject(provider), "provider must be an object");
    ensure(!hasCredentialField(provider), "provider credentials must not be stored");
    var id = text(provider.id || provider.providerId).toLowerCase();
    ensure(/^[a-z0-9][a-z0-9-]{0,63}$/.test(id), "provider id is invalid");
    ensure(!DEFAULT_PROVIDERS[id], "built-in provider id cannot be replaced");
    var label = text(provider.label);
    ensure(label && label.length <= 80, "provider label is required");
    ensure(normalizeProviderAliasKey(label), "온라인 프로그램 이름은 식별 가능한 문자를 포함해야 합니다.");
    var aliasKeys = {};
    aliasKeys[normalizeProviderAliasKey(id)] = true;
    aliasKeys[normalizeProviderAliasKey(label)] = true;
    var aliases = [];
    asArray(provider.aliases).forEach(function (value) {
      var alias = text(value);
      ensure(alias && alias.length <= 80, "온라인 프로그램 별칭은 80자 이내여야 합니다.");
      var key = normalizeProviderAliasKey(alias);
      ensure(key, "온라인 프로그램 별칭은 식별 가능한 문자를 포함해야 합니다.");
      if (!aliasKeys[key]) {
        aliasKeys[key] = true;
        aliases.push(alias);
      }
    });
    ensure(aliases.length <= 20, "provider aliases exceed limit");
    var boundedHistory = boundAuditHistory(provider.history, PROVIDER_HISTORY_LIMIT, provider.historyRetention);
    var capabilities = Array.from(new Set(asArray(provider.capabilities).map(function (value) {
      return text(value).toLowerCase();
    }).filter(function (value) {
      ensure(/^[a-z][a-z0-9_-]{0,63}$/.test(value), "provider capability is invalid");
      return Boolean(value);
    })));
    ensure(capabilities.length <= 20, "provider capabilities exceed limit");
    return {
      id: id,
      label: label,
      aliases: aliases,
      category: "custom",
      evidenceMode: "teacher_check",
      capabilities: capabilities,
      active: provider.active !== false,
      createdAt: text(provider.createdAt),
      createdBy: text(provider.createdBy),
      updatedAt: text(provider.updatedAt),
      updatedBy: text(provider.updatedBy),
      revision: Math.max(1, Math.floor(nonNegative(provider.revision, 1))),
      history: boundedHistory.history,
      historyRetention: boundedHistory.historyRetention
    };
  }

  function normalizeCustomProviders(customProviders) {
    var seen = {};
    return asArray(customProviders).map(function (provider) {
      var normalized = normalizeCustomProvider(provider);
      ensure(!seen[normalized.id], "duplicate custom provider: " + normalized.id);
      seen[normalized.id] = true;
      return normalized;
    });
  }

  function providerAliasValues(provider) {
    return [provider.id, provider.label].concat(asArray(provider.aliases)).map(text).filter(Boolean);
  }

  function ensureProviderAliasesAvailable(provider, otherProviders) {
    var owners = {};
    Object.keys(DEFAULT_PROVIDER_IMPORT_ALIASES).forEach(function (providerId) {
      DEFAULT_PROVIDER_IMPORT_ALIASES[providerId].forEach(function (alias) {
        var key = normalizeProviderAliasKey(alias);
        if (!owners[key]) owners[key] = { kind: "built_in", providerId: providerId };
      });
    });
    asArray(otherProviders).forEach(function (other) {
      if (!other || other.id === provider.id) return;
      providerAliasValues(other).forEach(function (alias) {
        var key = normalizeProviderAliasKey(alias);
        if (!owners[key]) owners[key] = { kind: "custom", providerId: other.id, label: other.label };
      });
    });
    var ownKeys = {};
    providerAliasValues(provider).forEach(function (alias) {
      var key = normalizeProviderAliasKey(alias);
      ensure(key, "온라인 프로그램 이름/별칭은 식별 가능한 문자를 포함해야 합니다.");
      if (ownKeys[key]) return;
      ownKeys[key] = true;
      var owner = owners[key];
      if (!owner) return;
      if (owner.kind === "built_in") {
        ensure(false, "온라인 프로그램 이름/별칭 '" + alias + "'은(는) 기본 온라인 프로그램 '" +
          DEFAULT_PROVIDERS[owner.providerId].label + "'과 충돌합니다.");
      }
      ensure(false, "온라인 프로그램 이름/별칭 '" + alias + "'은(는) 다른 사용자 지정 프로그램 '" +
        text(owner.label, owner.providerId) + "'과 충돌합니다.");
    });
    return provider;
  }

  function createProviderRegistry(customProviders) {
    var registry = clone(DEFAULT_PROVIDERS);
    Object.keys(registry).forEach(function (id) {
      registry[id].active = true;
      registry[id].builtIn = true;
    });
    normalizeCustomProviders(customProviders).forEach(function (provider) {
      registry[provider.id] = Object.assign({}, provider, { builtIn: false });
    });
    return registry;
  }

  function registerCustomProvider(state, providerInput, metadata) {
    ensure(isObject(state), "state is required");
    var meta = metadata || {};
    var provider = normalizeCustomProvider(providerInput);
    var next = clone(state);
    next.settings = Object.assign({}, next.settings || {});
    var customProviders = normalizeCustomProviders(next.settings.customProviders);
    ensure(!customProviders.some(function (item) { return item.id === provider.id; }), "custom provider already exists");
    ensureProviderAliasesAvailable(provider, customProviders);
    provider.createdAt = text(meta.at, new Date().toISOString());
    provider.createdBy = text(meta.actor, "system");
    provider.updatedAt = provider.createdAt;
    provider.updatedBy = provider.createdBy;
    provider.history = [{
      action: "registered",
      at: provider.createdAt,
      actor: provider.createdBy,
      active: provider.active,
      capabilities: clone(provider.capabilities)
    }];
    var registeredHistory = boundAuditHistory(provider.history, PROVIDER_HISTORY_LIMIT, provider.historyRetention);
    provider.history = registeredHistory.history;
    provider.historyRetention = registeredHistory.historyRetention;
    next.settings.customProviders = customProviders.concat([provider]);
    return next;
  }

  function setCustomProviderActive(state, providerId, active, metadata) {
    ensure(typeof active === "boolean", "provider active decision is required");
    var next = clone(state);
    next.settings = Object.assign({}, next.settings || {});
    var providers = normalizeCustomProviders(next.settings.customProviders);
    var index = providers.findIndex(function (provider) { return provider.id === text(providerId).toLowerCase(); });
    ensure(index >= 0, "custom provider not found");
    var meta = metadata || {};
    var at = text(meta.at, new Date().toISOString());
    var actor = text(meta.actor, "system");
    var provider = providers[index];
    if (active) ensureProviderAliasesAvailable(provider, providers);
    if (provider.active !== active) {
      provider.active = active;
      provider.revision += 1;
      provider.updatedAt = at;
      provider.updatedBy = actor;
      provider.history.push({ action: active ? "enabled" : "disabled", at: at, actor: actor });
      var boundedHistory = boundAuditHistory(provider.history, PROVIDER_HISTORY_LIMIT, provider.historyRetention);
      provider.history = boundedHistory.history;
      provider.historyRetention = boundedHistory.historyRetention;
    }
    next.settings.customProviders = providers;
    return next;
  }

  function createProgramImportProviderDefinitions(customProviders) {
    var activeProviders = normalizeCustomProviders(customProviders).filter(function (provider) {
      return provider.active;
    });
    activeProviders.forEach(function (provider) {
      ensureProviderAliasesAvailable(provider, activeProviders);
    });
    return activeProviders.map(function (provider) {
      var capabilities = {};
      provider.capabilities.forEach(function (capability) { capabilities[capability] = true; });
      return {
        id: provider.id,
        label: provider.label,
        aliases: clone(provider.aliases),
        capabilities: capabilities,
        required: ["check_date"],
        requiredAny: [["reported_status", "current_unit", "progress_pct", "score"]]
      };
    });
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
        notificationQuietHours: { start: "20:00", end: "08:00" },
        customProviders: []
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

  function upsertStudentProgramState(state, input, registryInput, restoreToken) {
    ensure(isObject(state), "state is required");
    ensure(isObject(input), "program state is required");
    ensure(!hasCredentialField(input), "credentials and passwords must not be stored");
    var registry = registryInput || createProviderRegistry(state.settings && state.settings.customProviders);
    var currentRegistry = createProviderRegistry(state.settings && state.settings.customProviders);
    var providerId = text(input.providerId).toLowerCase();
    ensure(Boolean(registry[providerId]) && Boolean(currentRegistry[providerId]), "unknown provider: " + providerId);
    ensure((registry[providerId].active !== false && currentRegistry[providerId].active !== false) ||
      restoreToken === INACTIVE_PROVIDER_RESTORE,
      "사용 중지된 온라인 프로그램에는 새 상태나 승인 결과를 반영할 수 없습니다.");
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
    var inputDroppedCount = Math.floor(nonNegative(
      input && input.historyRetention && input.historyRetention.droppedCount, 0
    ));
    var historyRetention = {
      maxEntries: PROGRAM_HISTORY_LIMIT,
      maxBytes: PROGRAM_HISTORY_MAX_BYTES,
      droppedCount: Math.max(previousDroppedCount, inputDroppedCount) + boundedHistory.droppedCount,
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
    var assignedCountKnown = previous
      ? previous.assignedCountKnown === true || assignedCount > 0
      : hasOwn(input, "assignedCountKnown") ? input.assignedCountKnown === true : false;
    var completedCountKnown = previous
      ? previous.completedCountKnown === true || completedCount > 0
      : hasOwn(input, "completedCountKnown") ? input.completedCountKnown === true : false;
    if (hasOwn(input, "assignedCount") && input.assignedCount !== "" && input.assignedCount != null) {
      assignedCount = Math.floor(nonNegative(input.assignedCount, assignedCount));
      if (!hasOwn(input, "assignedCountKnown")) assignedCountKnown = true;
    }
    if (hasOwn(input, "completedCount") && input.completedCount !== "" && input.completedCount != null) {
      completedCount = Math.floor(nonNegative(input.completedCount, completedCount));
      if (!hasOwn(input, "completedCountKnown")) completedCountKnown = true;
    }
    if (hasOwn(input, "assignedCountKnown")) assignedCountKnown = input.assignedCountKnown === true;
    if (hasOwn(input, "completedCountKnown")) completedCountKnown = input.completedCountKnown === true;
    // 양수 수량은 이미 관측된 값이므로 explicit false보다 내부 불변식을 우선한다.
    if (assignedCount > 0) assignedCountKnown = true;
    if (completedCount > 0) completedCountKnown = true;
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
      assignedCountKnown: assignedCountKnown,
      completedCountKnown: completedCountKnown,
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

  function deterministicLegacyPlannerCreatedAt(source, date) {
    var sourceUpdatedAt = text(source && source.updatedAt);
    if (sourceUpdatedAt && Number.isFinite(Date.parse(sourceUpdatedAt))) return sourceUpdatedAt;
    return date + "T00:00:00.000Z";
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
      ? true
      : Boolean(source.verificationRequired);
    var status = normalizePlannerStatus(source.status);
    var createdAt = text(source.createdAt);
    if (!createdAt) createdAt = deterministicLegacyPlannerCreatedAt(source, date);
    var createdBy = text(source.createdBy, LEGACY_PLANNER_ACTOR);
    var history = clone(asArray(source.history));
    if (!history.length) {
      history.push({ action: "created", fromStatus: "", toStatus: status, at: createdAt, actor: createdBy });
    }
    var boundedHistory = boundAuditHistory(history, PLANNER_HISTORY_LIMIT, source.historyRetention);
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
      status: status,
      verificationRequired: verificationRequired,
      evidenceRefs: asArray(source.evidenceRefs).map(String),
      verificationEvidenceRefs: asArray(source.verificationEvidenceRefs).map(String),
      verificationDecision: text(source.verificationDecision),
      carryoverRequestedDate: text(source.carryoverRequestedDate),
      carryoverRequestReason: text(source.carryoverRequestReason),
      carryoverRequestedBy: text(source.carryoverRequestedBy),
      carryoverRequestedAt: text(source.carryoverRequestedAt),
      carryoverPreviousStatus: text(source.carryoverPreviousStatus),
      carryoverDecision: text(source.carryoverDecision),
      carryoverDecisionReason: text(source.carryoverDecisionReason),
      carryoverReviewedBy: text(source.carryoverReviewedBy),
      carryoverReviewedAt: text(source.carryoverReviewedAt),
      cancelReason: text(source.cancelReason),
      canceledAt: text(source.canceledAt),
      canceledBy: text(source.canceledBy),
      systemHidden: source.systemHidden === true,
      systemHiddenReason: text(source.systemHiddenReason),
      systemHiddenAt: text(source.systemHiddenAt),
      systemHiddenBy: text(source.systemHiddenBy),
      systemReactivatedAt: text(source.systemReactivatedAt),
      systemReactivatedBy: text(source.systemReactivatedBy),
      completedAt: text(source.completedAt),
      verifiedAt: text(source.verifiedAt),
      verifiedBy: text(source.verifiedBy),
      createdAt: createdAt,
      createdBy: createdBy,
      updatedAt: text(source.updatedAt, createdAt),
      updatedBy: text(source.updatedBy, createdBy),
      history: boundedHistory.history,
      historyRetention: boundedHistory.historyRetention,
      revision: Math.max(1, Math.floor(nonNegative(source.revision, 1)))
    };
  }

  function appendPlannerAudit(item, action, metadata, fromStatus, details) {
    var meta = metadata || {};
    var at = text(meta.at, new Date().toISOString());
    var actor = text(meta.actor || meta.by, "system");
    item.updatedAt = at;
    item.updatedBy = actor;
    item.history = clone(asArray(item.history));
    item.history.push(Object.assign({
      action: action,
      fromStatus: text(fromStatus),
      toStatus: item.status,
      at: at,
      actor: actor,
      reason: text(meta.reason)
    }, details || {}));
    return item;
  }

  function addPlannerItem(state, itemInput) {
    var item = createPlannerItem(itemInput);
    var next = clone(state);
    var index = next.plannerItems.findIndex(function (existing) {
      return existing.itemId === item.itemId;
    });
    if (index >= 0) {
      var previous = createPlannerItem(next.plannerItems[index]);
      // 감사 tombstone은 stale planner snapshot으로 근거·revision까지 변하면 안 된다.
      // 복구는 평가 일정의 명시 reactivation 경로에서만 수행한다.
      if (previous.systemHidden === true) return next;
      var evidenceRefs = Array.from(new Set(previous.evidenceRefs.concat(item.evidenceRefs)));
      var verificationEvidenceRefs = Array.from(new Set(
        previous.verificationEvidenceRefs.concat(item.verificationEvidenceRefs)
      ));
      var refsChanged = evidenceRefs.length !== previous.evidenceRefs.length ||
        verificationEvidenceRefs.length !== previous.verificationEvidenceRefs.length;
      if (!refsChanged) return next;
      previous.evidenceRefs = evidenceRefs;
      previous.verificationEvidenceRefs = verificationEvidenceRefs;
      previous.revision = Number(previous.revision || 0) + 1;
      next.plannerItems[index] = createPlannerItem(previous);
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
    var current = createPlannerItem(next.plannerItems[index]);
    var updated = updater(clone(current));
    updated.itemId = current.itemId;
    updated.revision = Number(current.revision || 0) + 1;
    next.plannerItems[index] = createPlannerItem(updated);
    return next;
  }

  function editPlannerItem(state, itemId, changes, metadata) {
    var input = changes || {};
    var meta = metadata || {};
    return updatePlannerItem(state, itemId, function (item) {
      ensure(!item.occurrenceId, "평가 연결 플래너는 평가 일정/결과 전용 경로를 사용해야 합니다.");
      ensure(["planned", "in_progress", "check_needed"].indexOf(item.status) >= 0,
        "planner item cannot be edited from " + item.status);
      var before = item.status;
      var auditChanges = {};
      if (hasOwn(input, "title")) {
        var nextTitle = text(input.title);
        ensure(nextTitle, "planner item title is required");
        if (nextTitle !== item.title) auditChanges.title = { from: item.title, to: nextTitle };
        item.title = nextTitle;
      }
      if (hasOwn(input, "minutes")) {
        var nextMinutes = Number(input.minutes);
        ensure(Number.isFinite(nextMinutes) && nextMinutes >= 0, "planner minutes must be non-negative");
        nextMinutes = Math.floor(nextMinutes);
        if (nextMinutes !== item.minutes) auditChanges.minutes = { from: item.minutes, to: nextMinutes };
        item.minutes = nextMinutes;
      }
      if (hasOwn(input, "date")) {
        var nextDate = text(input.date);
        parseDateOnly(nextDate, "planner item date");
        if (nextDate !== item.date) auditChanges.date = { from: item.date, to: nextDate };
        item.date = nextDate;
        item.planId = stableId("daily", item.studentCode, nextDate);
      }
      ensure(Object.keys(auditChanges).length > 0, "planner edit has no changes");
      return appendPlannerAudit(item, "edited", meta, before, { changes: auditChanges });
    });
  }

  function cancelPlannerItem(state, itemId, cancellation) {
    var input = cancellation || {};
    ensure(text(input.reason), "cancel reason is required");
    ensure(text(input.canceledBy || input.actor), "canceledBy is required");
    return updatePlannerItem(state, itemId, function (item) {
      ensure(!item.occurrenceId, "평가 연결 플래너는 평가 일정/결과 전용 경로를 사용해야 합니다.");
      ensure(["planned", "in_progress", "check_needed"].indexOf(item.status) >= 0,
        "planner item cannot be canceled from " + item.status);
      var before = item.status;
      item.status = "canceled";
      item.cancelReason = text(input.reason);
      item.canceledBy = text(input.canceledBy || input.actor);
      item.canceledAt = text(input.canceledAt || input.at, new Date().toISOString());
      return appendPlannerAudit(item, "canceled", {
        actor: item.canceledBy, at: item.canceledAt, reason: item.cancelReason
      }, before);
    });
  }

  function claimPlannerItemCompletion(state, itemId, evidenceRef, claimedAt) {
    return updatePlannerItem(state, itemId, function (item) {
      ensure(["planned", "in_progress", "check_needed"].indexOf(item.status) >= 0, "item cannot be claimed from " + item.status);
      var before = item.status;
      if (text(evidenceRef)) item.evidenceRefs = item.evidenceRefs.concat([String(evidenceRef)]);
      item.completedAt = text(claimedAt, new Date().toISOString());
      item.verificationRequired = true;
      item.status = "verification_waiting";
      return appendPlannerAudit(item, "completion_claimed", {
        actor: "student_claim", at: item.completedAt
      }, before, { evidenceRef: text(evidenceRef) });
    });
  }

  function verifyPlannerItemCompletion(state, itemId, verification) {
    var input = verification || {};
    ensure(typeof input.approved === "boolean", "approved decision is required");
    ensure(text(input.verifiedBy), "verifiedBy is required");
    ensure(text(input.evidenceRef), "verification evidenceRef is required");
    return updatePlannerItem(state, itemId, function (item) {
      ensure(item.status === "verification_waiting", "only verification_waiting items can be verified");
      ensure(!item.occurrenceId, "assessment completion requires an approved assessment result");
      var before = item.status;
      item.status = input.approved ? "completed" : "check_needed";
      item.verificationDecision = input.approved ? "approved" : "rejected";
      item.verificationEvidenceRefs = item.verificationEvidenceRefs.concat([text(input.evidenceRef)]);
      item.verifiedBy = text(input.verifiedBy);
      item.verifiedAt = text(input.verifiedAt, new Date().toISOString());
      return appendPlannerAudit(item, input.approved ? "completion_approved" : "completion_rejected", {
        actor: item.verifiedBy, at: item.verifiedAt, reason: text(input.reason)
      }, before, { evidenceRef: text(input.evidenceRef) });
    });
  }

  function requestPlannerCarryover(state, itemId, requestedDate, request) {
    parseDateOnly(requestedDate, "carryover requestedDate");
    var input = request || {};
    return updatePlannerItem(state, itemId, function (item) {
      ensure(!item.occurrenceId, "평가 연결 플래너는 평가 일정/결과 전용 경로를 사용해야 합니다.");
      ensure(["planned", "in_progress", "check_needed"].indexOf(item.status) >= 0, "item cannot be carried over");
      ensure(compareDates(requestedDate, item.date) > 0,
        "carryover requestedDate must be later than planner item date");
      var before = item.status;
      item.status = "carryover_candidate";
      item.carryoverPreviousStatus = before;
      item.carryoverRequestedDate = requestedDate;
      item.carryoverRequestReason = text(input.reason);
      item.carryoverRequestedBy = text(input.requestedBy || input.actor, "system");
      item.carryoverRequestedAt = text(input.requestedAt || input.at, new Date().toISOString());
      item.carryoverDecision = "pending";
      return appendPlannerAudit(item, "carryover_requested", {
        actor: item.carryoverRequestedBy, at: item.carryoverRequestedAt, reason: item.carryoverRequestReason
      }, before, {
        requestedDate: requestedDate,
        requestedBy: item.carryoverRequestedBy
      });
    });
  }

  function reviewPlannerCarryover(state, itemId, review) {
    var input = review || {};
    ensure(typeof input.approved === "boolean", "carryover approved decision is required");
    var reviewedBy = text(input.reviewedBy || input.approvedBy);
    ensure(reviewedBy, "carryover reviewedBy is required");
    if (!input.approved) ensure(text(input.reason), "carryover rejection reason is required");
    var currentInput = asArray(state && state.plannerItems).find(function (item) { return item.itemId === itemId; });
    ensure(currentInput, "planner item not found: " + itemId);
    var current = createPlannerItem(currentInput);
    ensure(!current.occurrenceId, "평가 연결 플래너는 평가 일정/결과 전용 경로를 사용해야 합니다.");
    ensure(current.status === "carryover_candidate", "carryover candidate not found");
    var reviewedAt = text(input.reviewedAt || input.approvedAt, new Date().toISOString());
    if (!input.approved) {
      return updatePlannerItem(state, itemId, function (item) {
        var before = item.status;
        item.status = ["planned", "in_progress", "check_needed"].indexOf(item.carryoverPreviousStatus) >= 0
          ? item.carryoverPreviousStatus : "check_needed";
        item.carryoverDecision = "rejected";
        item.carryoverDecisionReason = text(input.reason);
        item.carryoverReviewedBy = reviewedBy;
        item.carryoverReviewedAt = reviewedAt;
        return appendPlannerAudit(item, "carryover_rejected", {
          actor: reviewedBy, at: reviewedAt, reason: item.carryoverDecisionReason
        }, before, {
          requestedDate: item.carryoverRequestedDate,
          requestedBy: item.carryoverRequestedBy,
          reviewedBy: reviewedBy
        });
      });
    }
    var targetDate = text(input.date, current.carryoverRequestedDate);
    parseDateOnly(targetDate, "carryover date");
    ensure(compareDates(targetDate, current.date) > 0,
      "carryover date must be later than planner item date");
    var next = updatePlannerItem(state, itemId, function (item) {
      var before = item.status;
      item.status = "carried_over";
      item.carryoverDecision = "approved";
      item.carryoverDecisionReason = text(input.reason);
      item.carryoverReviewedBy = reviewedBy;
      item.carryoverReviewedAt = reviewedAt;
      return appendPlannerAudit(item, "carryover_approved", {
        actor: reviewedBy, at: reviewedAt, reason: item.carryoverDecisionReason
      }, before, {
        targetDate: targetDate,
        requestedBy: item.carryoverRequestedBy,
        reviewedBy: reviewedBy
      });
    });
    return addPlannerItem(next, Object.assign({}, current, {
      itemId: stableId("plan", current.studentCode, targetDate, current.sourceType, current.title, current.itemId),
      planId: stableId("daily", current.studentCode, targetDate),
      date: targetDate,
      originItemId: current.itemId,
      status: "planned",
      verificationRequired: true,
      verificationEvidenceRefs: [],
      verificationDecision: "",
      carryoverRequestedDate: "",
      carryoverRequestReason: "",
      carryoverRequestedBy: "",
      carryoverRequestedAt: "",
      carryoverPreviousStatus: "",
      carryoverDecision: "",
      carryoverDecisionReason: "",
      carryoverReviewedBy: "",
      carryoverReviewedAt: "",
      cancelReason: "",
      canceledAt: "",
      canceledBy: "",
      completedAt: "",
      verifiedAt: "",
      verifiedBy: "",
      createdAt: reviewedAt,
      createdBy: reviewedBy,
      updatedAt: reviewedAt,
      updatedBy: reviewedBy,
      history: [{
        action: "carried_over_created", fromStatus: "", toStatus: "planned",
        at: reviewedAt, actor: reviewedBy, originItemId: current.itemId
      }],
      revision: 1
    }));
  }

  function approvePlannerCarryover(state, itemId, approval) {
    return reviewPlannerCarryover(state, itemId, Object.assign({}, approval || {}, { approved: true }));
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
      return item.date === date && item.systemHidden !== true;
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
      canceled: items.filter(function (item) {
        return item.status === "canceled";
      }),
      all: items
    };
  }

  function getWeekPlan(state, anchorDate) {
    var weekStart = startOfWeek(anchorDate, state.settings && state.settings.weekStartsOn);
    var weekEnd = addDays(weekStart, 6);
    var items = asArray(state.plannerItems).filter(function (item) {
      return item.systemHidden !== true &&
        compareDates(item.date, weekStart) >= 0 &&
        compareDates(item.date, weekEnd) <= 0;
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

  function assessmentScheduleSemanticKey(studentCode, scheduleType, scheduleId) {
    return text(scheduleType) === "custom"
      ? stableId("assessment_schedule", text(studentCode), text(scheduleType), text(scheduleId))
      : stableId("assessment_schedule", text(studentCode), text(scheduleType));
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
    var weekday = cadence.kind === "weekly" ? normalizeWeekday(cadence.weekday, "weekday") : null;
    var activeWeekdays = normalizeActiveWeekdays(cadence.activeWeekdays);
    var title = text(source.title, assessmentTitle(scheduleType));
    var defaultScheduleId = scheduleType === "custom"
      ? stableId("schedule", studentCode, scheduleType, text(source.providerId, "manual"), title,
        source.anchorDate, cadence.kind)
      : stableId("schedule", studentCode, scheduleType);
    var scheduleId = text(source.scheduleId, defaultScheduleId);
    var semanticKey = assessmentScheduleSemanticKey(studentCode, scheduleType, scheduleId);
    return {
      // 표준 일정은 anchor와 무관한 ID를 쓰고 custom 일정은 명시 ID를 우선한다.
      // 저장된 scheduleId가 있으면 그대로 보존해 occurrence/planner 참조를 깨지 않는다.
      scheduleId: scheduleId,
      semanticKey: semanticKey,
      studentCode: studentCode,
      scheduleType: scheduleType,
      providerId: text(source.providerId, scheduleType.indexOf("metamath") === 0 ? "metamath" : scheduleType === "nelt" ? "nelt" : "manual"),
      title: title,
      anchorDate: source.anchorDate,
      cadence: {
        kind: cadence.kind,
        interval: Math.max(1, Math.floor(nonNegative(cadence.interval, 1))),
        weekday: weekday,
        activeWeekdays: activeWeekdays
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
          weekday: source.weekday === undefined ? 5 : source.weekday
        }
        : {
          kind: "month_end",
          interval: Math.max(1, Math.floor(nonNegative(source.intervalMonths, 1))),
          activeWeekdays: source.activeWeekdays
        }
    }));
  }

  function createOccurrence(schedule, date) {
    return {
      occurrenceId: stableId("occurrence", schedule.scheduleId, date),
      scheduleId: schedule.scheduleId,
      scheduleSemanticKey: assessmentScheduleSemanticKey(
        schedule.studentCode, schedule.scheduleType, schedule.scheduleId),
      studentCode: schedule.studentCode,
      scheduleType: schedule.scheduleType,
      providerId: schedule.providerId,
      title: schedule.title,
      scheduledDate: date,
      durationMinutes: schedule.durationMinutes,
      status: "scheduled",
      verificationStatus: schedule.verificationRequired ? "required" : "not_required",
      externalRef: "",
      resultHistory: [],
      history: [],
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
    function appendOccurrence(date) {
      ensure(output.length < ASSESSMENT_OCCURRENCE_RANGE_LIMIT,
        "assessment range exceeds " + ASSESSMENT_OCCURRENCE_RANGE_LIMIT +
        " occurrences; use a smaller range");
      output.push(createOccurrence(schedule, date));
    }
    if (cadence.kind === "months") {
      var monthAnchor = parseDateOnly(schedule.anchorDate);
      var monthFrom = parseDateOnly(fromDate);
      var monthDifference = (monthFrom.getUTCFullYear() - monthAnchor.getUTCFullYear()) * 12 +
        monthFrom.getUTCMonth() - monthAnchor.getUTCMonth();
      var monthOccurrenceIndex = Math.max(0, Math.floor(monthDifference / cadence.interval));
      var monthDate = addMonthsClamped(schedule.anchorDate, monthOccurrenceIndex * cadence.interval);
      if (compareDates(monthDate, fromDate) < 0) {
        monthOccurrenceIndex += 1;
        monthDate = addMonthsClamped(schedule.anchorDate, monthOccurrenceIndex * cadence.interval);
      }
      while (compareDates(monthDate, toDate) <= 0) {
        appendOccurrence(monthDate);
        monthOccurrenceIndex += 1;
        monthDate = addMonthsClamped(schedule.anchorDate, monthOccurrenceIndex * cadence.interval);
      }
      return output;
    }
    if (cadence.kind === "weekly") {
      var firstWeeklyDate = nextOrSameWeekday(schedule.anchorDate, cadence.weekday);
      var weeklyPeriodDays = 7 * cadence.interval;
      var weeklyOffset = compareDates(firstWeeklyDate, fromDate) >= 0
        ? 0
        : Math.ceil(daysBetween(firstWeeklyDate, fromDate) / weeklyPeriodDays);
      var weeklyDate = addDays(firstWeeklyDate, weeklyOffset * weeklyPeriodDays);
      while (compareDates(weeklyDate, toDate) <= 0) {
        if (compareDates(weeklyDate, fromDate) >= 0) appendOccurrence(weeklyDate);
        weeklyDate = addDays(weeklyDate, weeklyPeriodDays);
      }
      return output;
    }
    if (cadence.kind === "month_end") {
      var from = parseDateOnly(fromDate);
      var anchor = parseDateOnly(schedule.anchorDate);
      var anchorMonthNumber = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth();
      var fromMonthNumber = from.getUTCFullYear() * 12 + from.getUTCMonth();
      var firstPhaseOffset = Math.max(0,
        Math.ceil((fromMonthNumber - anchorMonthNumber) / cadence.interval) * cadence.interval);
      for (iteration = 0; ; iteration += 1) {
        var cursor = new Date(Date.UTC(anchor.getUTCFullYear(),
          anchor.getUTCMonth() + firstPhaseOffset + (iteration * cadence.interval), 1));
        if (compareDates(formatDateOnly(cursor), toDate) > 0) break;
        var endDate = lastLearningDayOfMonth(cursor.getUTCFullYear(), cursor.getUTCMonth(), cadence.activeWeekdays);
        if (compareDates(endDate, toDate) > 0) {
          break;
        }
        if (compareDates(endDate, fromDate) >= 0 && compareDates(endDate, schedule.anchorDate) >= 0) {
          appendOccurrence(endDate);
        }
      }
      return output;
    }
    if (compareDates(schedule.anchorDate, fromDate) >= 0 && compareDates(schedule.anchorDate, toDate) <= 0) {
      output.push(createOccurrence(schedule, schedule.anchorDate));
    }
    return output;
  }

  function assessmentOccurrenceToPlannerItem(occurrence, creation) {
    var meta = creation || {};
    var createdAt = text(meta.createdAt || meta.at, new Date().toISOString());
    var createdBy = text(meta.createdBy || meta.actor, "assessment_schedule");
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
      verificationRequired: occurrence.verificationStatus === "required",
      createdAt: createdAt,
      createdBy: createdBy
    });
  }

  function assessmentScheduleMatches(left, right) {
    if (text(left && left.studentCode) !== text(right && right.studentCode) ||
        text(left && left.scheduleType) !== text(right && right.scheduleType)) return false;
    if (text(right && right.scheduleType) !== "custom") return true;
    return text(left && left.scheduleId) === text(right && right.scheduleId);
  }

  function assessmentOccurrenceMatches(occurrence, schedule) {
    if (!occurrence) return false;
    if (text(occurrence.studentCode) !== text(schedule.studentCode)) return false;
    if (text(occurrence.scheduleType)) {
      if (text(occurrence.scheduleType) !== text(schedule.scheduleType)) return false;
      if (text(schedule.scheduleType) !== "custom") return true;
      return text(occurrence.scheduleId) === text(schedule.scheduleId);
    }
    return text(occurrence.scheduleId) === text(schedule.scheduleId);
  }

  function occurrenceHasProtectedHistory(state, occurrence) {
    if (text(occurrence.externalRef)) return true;
    if (["", "scheduled", "planned"].indexOf(text(occurrence.status)) < 0) return true;
    var linked = asArray(state.plannerItems).filter(function (item) {
      return text(item.occurrenceId) === text(occurrence.occurrenceId);
    });
    return linked.some(function (item) {
      return item.systemHidden !== true && item.status !== "planned";
    });
  }

  function assessmentScheduleAuditMetadata(range) {
    var source = range || {};
    return {
      at: text(source.at || source.changedAt, new Date().toISOString()),
      actor: text(source.actor || source.by, "assessment_schedule")
    };
  }

  function tombstoneAssessmentPlannerItem(itemInput, schedule, range) {
    var item = createPlannerItem(itemInput);
    var before = item.status;
    var metadata = assessmentScheduleAuditMetadata(range);
    item.status = "canceled";
    item.systemHidden = true;
    item.systemHiddenReason = "assessment_schedule_removed";
    item.systemHiddenAt = metadata.at;
    item.systemHiddenBy = metadata.actor;
    item.revision = Number(item.revision || 0) + 1;
    appendPlannerAudit(item, "assessment_schedule_tombstoned", metadata, before, {
      occurrenceId: item.occurrenceId,
      scheduleId: schedule.scheduleId,
      scheduledDate: item.date,
      systemHidden: true
    });
    return createPlannerItem(item);
  }

  function reactivateAssessmentPlannerItem(itemInput, occurrence, range) {
    var item = createPlannerItem(itemInput);
    var before = item.status;
    var metadata = assessmentScheduleAuditMetadata(range);
    item.status = "planned";
    item.systemHidden = false;
    item.systemReactivatedAt = metadata.at;
    item.systemReactivatedBy = metadata.actor;
    item.revision = Number(item.revision || 0) + 1;
    appendPlannerAudit(item, "assessment_schedule_reactivated", metadata, before, {
      occurrenceId: occurrence.occurrenceId,
      scheduleId: occurrence.scheduleId,
      scheduledDate: occurrence.scheduledDate,
      priorSystemHiddenReason: item.systemHiddenReason
    });
    return createPlannerItem(item);
  }

  function removeReplaceableAssessmentWindow(state, schedule, range) {
    if (!range || !range.fromDate || !range.toDate) return state;
    parseDateOnly(range.fromDate, "range fromDate");
    parseDateOnly(range.toDate, "range toDate");
    var removableOccurrenceIds = new Set();
    asArray(state.assessmentOccurrences).forEach(function (occurrence) {
      if (!assessmentOccurrenceMatches(occurrence, schedule)) return;
      if (compareDates(occurrence.scheduledDate, range.fromDate) < 0 ||
          compareDates(occurrence.scheduledDate, range.toDate) > 0) return;
      if (!occurrenceHasProtectedHistory(state, occurrence)) {
        removableOccurrenceIds.add(occurrence.occurrenceId);
      }
    });
    if (!removableOccurrenceIds.size) return state;
    state.assessmentOccurrences = state.assessmentOccurrences.filter(function (occurrence) {
      return !removableOccurrenceIds.has(occurrence.occurrenceId);
    });
    state.plannerItems = state.plannerItems.map(function (item) {
      if (!removableOccurrenceIds.has(item.occurrenceId) || item.status !== "planned") return item;
      return tombstoneAssessmentPlannerItem(item, schedule, range);
    });
    return state;
  }

  function addAssessmentSchedule(state, scheduleInput, range) {
    var schedule = createAssessmentSchedule(scheduleInput);
    var next = clone(state);
    var plannerCreation = range && range.fromDate && range.toDate
      ? assessmentScheduleAuditMetadata(range) : null;
    var matchingIndexes = [];
    next.assessmentSchedules.forEach(function (item, itemIndex) {
      if (assessmentScheduleMatches(item, schedule)) matchingIndexes.push(itemIndex);
    });
    var index = matchingIndexes.length ? matchingIndexes[0] : -1;
    var existing = index >= 0 ? createAssessmentSchedule(next.assessmentSchedules[index]) : null;
    var resetAnchor = Boolean((range && range.resetAnchor === true) ||
      (scheduleInput && scheduleInput.resetAnchor === true));
    if (existing) {
      schedule.scheduleId = existing.scheduleId;
      if (!resetAnchor) schedule.anchorDate = existing.anchorDate;
      schedule.semanticKey = assessmentScheduleSemanticKey(
        schedule.studentCode, schedule.scheduleType, schedule.scheduleId);
      schedule.revision = Math.max.apply(null, matchingIndexes.map(function (itemIndex) {
        return Number(next.assessmentSchedules[itemIndex].revision || 0);
      })) + 1;
      next.assessmentSchedules = next.assessmentSchedules.filter(function (item) {
        return !assessmentScheduleMatches(item, schedule);
      });
      next.assessmentSchedules.splice(index, 0, schedule);
    } else {
      next.assessmentSchedules.push(schedule);
    }
    // 기존 anchor 기반 scheduleId로 생성된 회차도 새 semantic 일정에 귀속시킨다.
    next.assessmentOccurrences = next.assessmentOccurrences.map(function (occurrence) {
      if (!assessmentOccurrenceMatches(occurrence, schedule)) return occurrence;
      return Object.assign({}, occurrence, {
        scheduleId: schedule.scheduleId,
        scheduleSemanticKey: schedule.semanticKey,
        scheduleType: schedule.scheduleType,
        studentCode: schedule.studentCode
      });
    });
    next = removeReplaceableAssessmentWindow(next, schedule, range);
    if (range && range.fromDate && range.toDate) {
      expandAssessmentSchedule(schedule, range.fromDate, range.toDate).forEach(function (occurrence) {
        var currentOccurrence = next.assessmentOccurrences.find(function (item) {
          return item.occurrenceId === occurrence.occurrenceId ||
            (assessmentOccurrenceMatches(item, schedule) && item.scheduledDate === occurrence.scheduledDate);
        });
        if (!currentOccurrence) {
          next.assessmentOccurrences.push(occurrence);
          currentOccurrence = occurrence;
        }
        var candidatePlanner = assessmentOccurrenceToPlannerItem(currentOccurrence, plannerCreation);
        var linkedPlannerIndexes = [];
        next.plannerItems.forEach(function (item, itemIndex) {
          if (item.itemId === candidatePlanner.itemId ||
              item.occurrenceId === currentOccurrence.occurrenceId) {
            linkedPlannerIndexes.push(itemIndex);
          }
        });
        var visiblePlannerExists = linkedPlannerIndexes.some(function (itemIndex) {
          return next.plannerItems[itemIndex].systemHidden !== true;
        });
        if (!linkedPlannerIndexes.length) {
          next.plannerItems.push(candidatePlanner);
        } else if (!visiblePlannerExists) {
          var tombstoneIndex = linkedPlannerIndexes.find(function (itemIndex) {
            var item = next.plannerItems[itemIndex];
            return item.systemHidden === true && item.status === "canceled" &&
              item.systemHiddenReason === "assessment_schedule_removed";
          });
          if (tombstoneIndex !== undefined) {
            next.plannerItems[tombstoneIndex] = reactivateAssessmentPlannerItem(
              next.plannerItems[tombstoneIndex], currentOccurrence, range
            );
          }
        }
      });
    }
    return next;
  }

  function approveAssessmentResult(state, occurrenceId, approval) {
    ensure(isObject(state), "state is required");
    var input = approval || {};
    ensure(input.score !== undefined && input.score !== null && text(input.score) !== "", "assessment score is required");
    ensure(input.maxScore !== undefined && input.maxScore !== null && text(input.maxScore) !== "", "assessment maxScore is required");
    var score = Number(input.score);
    var maxScore = Number(input.maxScore);
    ensure(Number.isFinite(score) && score >= 0, "assessment score must be a non-negative number");
    ensure(Number.isFinite(maxScore) && maxScore > 0, "assessment maxScore must be greater than zero");
    ensure(score <= maxScore, "assessment score must not exceed maxScore");
    var evidenceRef = text(input.evidenceRef);
    var externalRef = text(input.externalRef);
    var verifiedBy = text(input.verifiedBy);
    ensure(evidenceRef, "assessment evidenceRef is required");
    ensure(verifiedBy, "assessment verifiedBy is required");
    var verifiedAt = isoTimestamp(input.verifiedAt, "assessment verifiedAt");
    ensure(Date.parse(verifiedAt) <= Date.now() + 5 * 60 * 1000,
      "assessment verifiedAt cannot be more than 5 minutes in the future");
    var next = clone(state);
    var index = next.assessmentOccurrences.findIndex(function (item) {
      return item.occurrenceId === occurrenceId;
    });
    ensure(index >= 0, "assessment occurrence not found");
    var occurrence = next.assessmentOccurrences[index];
    var occurrenceSchedule = next.assessmentSchedules.find(function (schedule) {
      return schedule.scheduleId === occurrence.scheduleId ||
        (text(schedule.semanticKey) && text(schedule.semanticKey) === text(occurrence.scheduleSemanticKey));
    });
    var occurrenceType = text(occurrence.scheduleType, occurrenceSchedule && occurrenceSchedule.scheduleType);
    ensure(["nelt", "metamath_weekly", "metamath_month_end", "custom"].indexOf(occurrenceType) >= 0,
      "assessment occurrence type is not supported");
    var occurrenceStatus = text(occurrence.status, "scheduled");
    ensure(["scheduled", "planned", "taken", "result_waiting", "result_review", "verification_waiting",
      "check_needed", "verified"].indexOf(occurrenceStatus) >= 0,
      "현재 평가 상태('" + occurrenceStatus + "')에서는 결과를 승인할 수 없습니다.");
    if (occurrence.latestResult) {
      var latestVerifiedAt = isoTimestamp(
        occurrence.latestResult.verifiedAt || occurrence.verifiedAt,
        "latest assessment result verifiedAt"
      );
      ensure(Date.parse(verifiedAt) > Date.parse(latestVerifiedAt),
        "assessment reapproval verifiedAt must be later than latest result");
    }
    var verifiedDate = timestampDateInTimeZone(verifiedAt, next.student && next.student.timeZone);
    ensure(compareDates(verifiedDate, occurrence.scheduledDate) >= 0,
      "평가 결과는 학생 시간대 기준 평가 예정일 당일 이후에만 승인할 수 있습니다.");
    var linkedAssessmentPlanners = asArray(next.plannerItems).filter(function (item) {
      return item.sourceType === "assessment" && item.occurrenceId === occurrenceId && item.status !== "canceled";
    });
    ensure(linkedAssessmentPlanners.length <= 1,
      "평가 연결 플래너가 중복되어 결과 승인을 진행할 수 없습니다.");
    occurrence.scheduleType = occurrenceType;
    var resultHistory = clone(asArray(occurrence.resultHistory));
    var history = clone(asArray(occurrence.history));
    var result = {
      resultId: stableId("assessment_result", occurrence.occurrenceId, verifiedAt, evidenceRef, externalRef, resultHistory.length + 1),
      score: score,
      maxScore: maxScore,
      percentage: Math.round(score / maxScore * 1000) / 10,
      evidenceRef: evidenceRef,
      externalRef: externalRef,
      verifiedBy: verifiedBy,
      verifiedAt: verifiedAt
    };
    resultHistory.push(result);
    history.push({
      event: "result_approved",
      fromStatus: text(occurrence.status, "scheduled"),
      toStatus: "verified",
      actor: verifiedBy,
      at: verifiedAt,
      evidenceRef: evidenceRef,
      externalRef: externalRef,
      resultId: result.resultId
    });
    var boundedResultHistory = boundAuditHistory(
      resultHistory, ASSESSMENT_RESULT_HISTORY_LIMIT, occurrence.resultHistoryRetention
    );
    var boundedAssessmentHistory = boundAuditHistory(
      history, ASSESSMENT_HISTORY_LIMIT, occurrence.historyRetention
    );
    occurrence.resultHistory = boundedResultHistory.history;
    occurrence.resultHistoryRetention = boundedResultHistory.historyRetention;
    occurrence.history = boundedAssessmentHistory.history;
    occurrence.historyRetention = boundedAssessmentHistory.historyRetention;
    occurrence.latestResult = result;
    occurrence.score = score;
    occurrence.maxScore = maxScore;
    occurrence.externalRef = externalRef;
    occurrence.status = "verified";
    occurrence.verificationStatus = "verified";
    occurrence.verifiedBy = verifiedBy;
    occurrence.verifiedAt = verifiedAt;
    occurrence.revision = Number(occurrence.revision || 0) + 1;
    next.assessmentOccurrences[index] = occurrence;

    next.plannerItems = next.plannerItems.map(function (item) {
      if (item.sourceType !== "assessment" || item.occurrenceId !== occurrenceId || item.status === "canceled") return item;
      var updated = createPlannerItem(item);
      var before = updated.status;
      updated.status = "completed";
      updated.completedAt = text(updated.completedAt, verifiedAt);
      updated.verificationDecision = "approved";
      updated.verificationEvidenceRefs = Array.from(new Set(
        asArray(updated.verificationEvidenceRefs).concat([evidenceRef])
      ));
      updated.verifiedBy = verifiedBy;
      updated.verifiedAt = verifiedAt;
      updated.revision = Number(updated.revision || 0) + 1;
      appendPlannerAudit(updated, "assessment_result_approved", {
        actor: verifiedBy,
        at: verifiedAt
      }, before, {
        occurrenceId: occurrenceId,
        resultId: result.resultId,
        evidenceRef: evidenceRef,
        externalRef: externalRef
      });
      return createPlannerItem(updated);
    });
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
    var boundedCampaignHistory = boundAuditHistory(
      source.history, CAMPAIGN_HISTORY_LIMIT, source.historyRetention
    );
    var boundedCampaignResults = boundAuditHistory(
      source.resultHistory, CAMPAIGN_RESULT_HISTORY_LIMIT, source.resultHistoryRetention
    );
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
      latestResult: isObject(source.latestResult) ? clone(source.latestResult) : null,
      resultHistory: boundedCampaignResults.history,
      resultHistoryRetention: boundedCampaignResults.historyRetention,
      history: boundedCampaignHistory.history,
      historyRetention: boundedCampaignHistory.historyRetention,
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
      var previous = next.prepCampaigns[index];
      campaign.status = previous.status;
      campaign.consentStatus = previous.consentStatus;
      campaign.consentEvidenceRef = previous.consentEvidenceRef;
      campaign.consentApprovedBy = previous.consentApprovedBy;
      campaign.consentApprovedAt = previous.consentApprovedAt;
      campaign.reviewerId = previous.reviewerId;
      campaign.activationBlockedReason = previous.activationBlockedReason;
      campaign.migrationReviewRequired = previous.migrationReviewRequired;
      var boundedPreviousHistory = boundAuditHistory(
        previous.history, CAMPAIGN_HISTORY_LIMIT, previous.historyRetention
      );
      var boundedPreviousResults = boundAuditHistory(
        previous.resultHistory, CAMPAIGN_RESULT_HISTORY_LIMIT, previous.resultHistoryRetention
      );
      campaign.history = boundedPreviousHistory.history;
      campaign.historyRetention = boundedPreviousHistory.historyRetention;
      campaign.resultHistory = boundedPreviousResults.history;
      campaign.resultHistoryRetention = boundedPreviousResults.historyRetention;
      if (previous.latestResult) campaign.latestResult = clone(previous.latestResult);
      campaign.revision = Number(previous.revision || 0) + 1;
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
    ensure(["draft", "consent_pending", "review_pending", "planned"].indexOf(campaign.status) >= 0,
      "campaign cannot be activated from " + campaign.status);
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
    var activatedAt = isoTimestamp(input.approvedAt || input.consentApprovedAt, "campaign approvedAt");
    campaign.history = clone(asArray(campaign.history));
    campaign.history.push({
      event: "activated",
      fromStatus: campaign.status,
      toStatus: "active",
      actor: text(input.approvedBy),
      at: activatedAt,
      evidenceRef: text(input.consentEvidenceRef)
    });
    var boundedCampaignHistory = boundAuditHistory(
      campaign.history, CAMPAIGN_HISTORY_LIMIT, campaign.historyRetention
    );
    campaign.history = boundedCampaignHistory.history;
    campaign.historyRetention = boundedCampaignHistory.historyRetention;
    campaign.status = "active";
    campaign.reviewerId = text(input.approvedBy);
    campaign.revision = Number(campaign.revision || 0) + 1;
    next.prepCampaigns[index] = campaign;
    return next;
  }

  function transitionPrepCampaign(state, campaignId, toStatus, transition) {
    var input = transition || {};
    var actor = text(input.actor);
    var evidenceRef = text(input.evidenceRef);
    ensure(actor, "campaign transition actor is required");
    ensure(evidenceRef, "campaign transition evidenceRef is required");
    var at = isoTimestamp(input.at, "campaign transition at");
    var next = clone(state);
    var index = next.prepCampaigns.findIndex(function (item) {
      return item.campaignId === campaignId;
    });
    ensure(index >= 0, "campaign not found");
    var campaign = next.prepCampaigns[index];
    ensure(Date.parse(at) <= Date.now() + 5 * 60 * 1000,
      "campaign transition at cannot be more than 5 minutes in the future");
    ensure(!campaign.activationBlockedReason, "campaign transition is blocked");
    if (campaign.academicStage === "elementary") {
      ensure(campaign.consentStatus === "approved",
        "elementary campaign transition requires approved consent");
    }
    var allowed = CAMPAIGN_TRANSITIONS[campaign.status] || [];
    ensure(allowed.indexOf(toStatus) >= 0,
      "campaign transition is invalid: " + campaign.status + " -> " + toStatus);
    if (["taken", "result_waiting", "result_review", "completed"].indexOf(toStatus) >= 0) {
      var transitionDate = timestampDateInTimeZone(at, next.student && next.student.timeZone);
      ensure(compareDates(transitionDate, campaign.examDate) >= 0,
        "campaign cannot transition to " + toStatus + " before examDate in student timezone");
    }

    var result = null;
    if (toStatus === "result_review") {
      var resultSummary = text(input.resultSummary);
      ensure(resultSummary, "campaign resultSummary is required");
      var hasScore = input.score !== undefined && input.score !== null && text(input.score) !== "";
      var hasMaxScore = input.maxScore !== undefined && input.maxScore !== null && text(input.maxScore) !== "";
      ensure(hasScore === hasMaxScore, "campaign score and maxScore must be provided together");
      var score = null;
      var maxScore = null;
      var percentage = null;
      if (hasScore) {
        score = Number(input.score);
        maxScore = Number(input.maxScore);
        ensure(Number.isFinite(score) && score >= 0, "campaign score must be a non-negative number");
        ensure(Number.isFinite(maxScore) && maxScore > 0, "campaign maxScore must be greater than zero");
        ensure(score <= maxScore, "campaign score must not exceed maxScore");
        percentage = Math.round(score / maxScore * 1000) / 10;
      }
      var resultHistory = clone(asArray(campaign.resultHistory));
      result = {
        resultId: stableId("campaign_result", campaign.campaignId, at, evidenceRef, resultHistory.length + 1),
        summary: resultSummary,
        score: score,
        maxScore: maxScore,
        percentage: percentage,
        evidenceRef: evidenceRef,
        externalRef: text(input.externalRef),
        reviewedBy: actor,
        reviewedAt: at
      };
      resultHistory.push(result);
      var boundedCampaignResults = boundAuditHistory(
        resultHistory, CAMPAIGN_RESULT_HISTORY_LIMIT, campaign.resultHistoryRetention
      );
      campaign.resultHistory = boundedCampaignResults.history;
      campaign.resultHistoryRetention = boundedCampaignResults.historyRetention;
      campaign.latestResult = result;
    }
    if (toStatus === "completed") {
      ensure(campaign.latestResult, "campaign reviewed result is required before completion");
    }
    campaign.history = clone(asArray(campaign.history));
    campaign.history.push({
      event: "status_transition",
      fromStatus: campaign.status,
      toStatus: toStatus,
      actor: actor,
      at: at,
      evidenceRef: evidenceRef,
      externalRef: text(input.externalRef),
      resultId: result ? result.resultId : ""
    });
    var boundedCampaignHistory = boundAuditHistory(
      campaign.history, CAMPAIGN_HISTORY_LIMIT, campaign.historyRetention
    );
    campaign.history = boundedCampaignHistory.history;
    campaign.historyRetention = boundedCampaignHistory.historyRetention;
    campaign.status = toStatus;
    campaign.reviewerId = actor;
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
    var meta = options || {};
    var createdAt = text(meta.createdAt || meta.at, new Date().toISOString());
    var createdBy = text(meta.createdBy || meta.actor, "prep_campaign");
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
        verificationRequired: true,
        createdAt: createdAt,
        createdBy: createdBy
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
    var hasCorrectCount = input.correctCount !== undefined && input.correctCount !== null && text(input.correctCount) !== "";
    var hasTotalCount = input.totalCount !== undefined && input.totalCount !== null && text(input.totalCount) !== "";
    var correctCount = Number(input.correctCount);
    var totalCount = Number(input.totalCount);
    ensure(["submitted", "result_waiting"].indexOf(current.status) >= 0, "result can only be recorded after submission");
    ensure(text(input.externalResultRef), "externalResultRef is required");
    ensure(hasCorrectCount, "correctCount is required");
    ensure(hasTotalCount, "totalCount is required");
    ensure(Number.isInteger(correctCount) && correctCount >= 0, "correctCount must be a non-negative integer");
    ensure(Number.isInteger(totalCount) && totalCount > 0, "totalCount must be a positive integer");
    ensure(correctCount <= totalCount, "correctCount cannot exceed totalCount");
    var next = clone(current);
    next.attemptNo = Number(current.attemptNo || 0) + 1;
    next.attempts.push({
      attemptNo: next.attemptNo,
      externalResultRef: text(input.externalResultRef),
      correctCount: correctCount,
      totalCount: totalCount,
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
      var existingSource = next.remediationCases[index];
      var existing = createWrongAnswerCase(existingSource);
      var evolved = remediation.revision > existing.revision || remediation.history.length > existing.history.length;
      if (evolved) {
        next.remediationCases[index] = Object.assign({}, clone(existingSource), remediation);
        return next;
      }
      var resolved = existing.status === "mastered" || existing.status === "closed";
      var registrationEvent = remediation.history[0] || {};
      var merged = Object.assign({}, clone(existingSource), existing);
      ["edition", "unitId", "skillCode"].forEach(function (field) {
        if (text(remediation[field])) {
          merged[field] = remediation[field];
        }
      });
      merged.status = resolved ? "captured" : existing.status;
      merged.revision = Math.max(existing.revision, remediation.revision) + 1;
      merged.attemptNo = existing.attemptNo;
      merged.attempts = clone(existing.attempts);
      merged.history = clone(existing.history);
      merged.history.push({
        from: existing.status,
        to: merged.status,
        at: text(caseInput && caseInput.createdAt, registrationEvent.at || new Date().toISOString()),
        actor: text(caseInput && caseInput.createdBy, registrationEvent.actor || "system"),
        note: resolved
          ? "동일 교재 문항 오답 재등록 · 새 재학습 주기 시작"
          : "동일 교재 문항 중복 등록 · 기존 재학습 진행상태 유지"
      });
      next.remediationCases[index] = merged;
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
    var configuredCustomProviders = options && Array.isArray(options.customProviders)
      ? options.customProviders
      : asArray(legacy.settings && legacy.settings.customProviders);
    configuredCustomProviders = normalizeCustomProviders(configuredCustomProviders);
    state.settings.customProviders = clone(configuredCustomProviders);
    var registry = createProviderRegistry(configuredCustomProviders);
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
      state.settings.customProviders = clone(configuredCustomProviders);
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
          }), registry, INACTIVE_PROVIDER_RESTORE);
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
        }, registry, INACTIVE_PROVIDER_RESTORE);
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
          evidenceRefs: item.evidenceRefs,
          createdAt: item.createdAt,
          createdBy: item.createdBy,
          updatedAt: item.updatedAt,
          updatedBy: item.updatedBy,
          history: item.history,
          historyRetention: item.historyRetention,
          revision: item.revision
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

  function plannerItemContextHtml(item) {
    var notes = [];
    if (item.originItemId) notes.push("이월된 항목");
    if (item.status === "carryover_candidate" && item.carryoverRequestedDate) {
      notes.push("이월 요청 " + item.carryoverRequestedDate);
    }
    if (item.status === "canceled" && item.cancelReason) notes.push("취소 사유: " + item.cancelReason);
    return notes.length ? '<span class="wb-lp__meta wb-lp__task-note">' + escapeHtml(notes.join(" · ")) + "</span>" : "";
  }

  function plannerActionHtml(item, interactive) {
    return interactive && ["planned", "in_progress", "check_needed"].indexOf(item.status) >= 0
      ? '<button class="wb-lp__button wb-lp__button--small" type="button" data-wb-action="claim" data-item-id="' +
        escapeHtml(item.itemId) + '">수행 완료 요청</button>'
      : "";
  }

  function plannerItemHtml(item, interactive) {
    return '<li class="wb-lp__task" data-planner-status="' + escapeHtml(item.status) + '">' +
      '<div class="wb-lp__task-main"><strong>' + escapeHtml(item.title) + "</strong>" +
      '<span class="wb-lp__meta">' + escapeHtml(item.minutes ? item.minutes + "분" : "시간 미정") +
      " · " + escapeHtml(item.sourceType) + "</span>" + plannerItemContextHtml(item) + "</div>" +
      '<div class="wb-lp__task-side">' +
      badge(LABELS.planner[item.status] || item.status, item.status) + plannerActionHtml(item, interactive) + "</div></li>";
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
        workload.warnings.map(function (warning) { return "<li>" + escapeHtml(warning.message) + "</li>"; }).join("") + "</ul></aside>"
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
      warningHtml + group("오늘 할 일", plan.active) + group("선생님 확인대기", plan.verificationWaiting) +
      group("이월 후보", plan.carryover) + group("완료", plan.completed) + group("취소", plan.canceled) + "</div>";
  }

  function renderWeekPlanner(state, date, interactive) {
    var week = getWeekPlan(state, date);
    return '<section><h2>' + escapeHtml(week.weekStart) + " – " + escapeHtml(week.weekEnd) + "</h2>" +
      '<ol class="wb-lp__week">' + week.days.map(function (day) {
        return '<li class="wb-lp__day"><h3>' + escapeHtml(day.date) + "</h3>" +
          (day.items.length ? '<ul class="wb-lp__compact-list">' + day.items.map(function (item) {
            return '<li data-planner-status="' + escapeHtml(item.status) + '"><span><strong>' + escapeHtml(item.title) +
              "</strong> · " + escapeHtml(item.minutes ? item.minutes + "분" : "시간 미정") + "</span>" +
              plannerItemContextHtml(item) + badge(LABELS.planner[item.status] || item.status, item.status) +
              plannerActionHtml(item, interactive) + "</li>";
          }).join("") + "</ul>" : emptyMessage("계획 없음")) + "</li>";
      }).join("") + "</ol></section>";
  }

  function renderAssessments(state, date) {
    var occurrences = clone(asArray(state.assessmentOccurrences)).sort(function (left, right) {
      return left.scheduledDate.localeCompare(right.scheduledDate);
    });
    var upcoming = occurrences.filter(function (item) {
      return compareDates(item.scheduledDate, date) >= 0 && item.status !== "verified";
    }).slice(0, 8);
    var recent = occurrences.filter(function (item) {
      return Boolean(item.latestResult);
    }).sort(function (left, right) {
      return text(right.latestResult && right.latestResult.verifiedAt).localeCompare(
        text(left.latestResult && left.latestResult.verifiedAt)
      );
    }).slice(0, 8);
    function assessmentCard(item, showResult) {
      var result = item.latestResult;
      var statusLabel = item.status === "verified" ? "결과 확인" : item.status === "scheduled" ? "예정" : item.status;
      var resultHtml = showResult && result
        ? '<p class="wb-lp__d-day">' + escapeHtml(result.score + "/" + result.maxScore + " · " + result.percentage + "%") + "</p>"
        : "";
      return '<li class="wb-lp__card"><div class="wb-lp__card-title"><strong>' + escapeHtml(item.title) + "</strong>" +
        badge(statusLabel, item.status) + "</div>" + resultHtml +
        '<p class="wb-lp__meta">' + escapeHtml(item.scheduledDate + " · " + item.providerId) + "</p></li>";
    }
    return '<section><h2>정기 평가</h2><p>결과는 선생님이 근거를 확인한 뒤에만 표시됩니다.</p>' +
      '<section class="wb-lp__group"><h3>다가오는 평가</h3>' +
      (upcoming.length ? '<ul class="wb-lp__card-grid">' + upcoming.map(function (item) {
        return assessmentCard(item, false);
      }).join("") + "</ul>" : emptyMessage("예정된 평가가 없습니다.")) + "</section>" +
      '<section class="wb-lp__group"><h3>최근 결과</h3>' +
      (recent.length ? '<ul class="wb-lp__card-grid">' + recent.map(function (item) {
        return assessmentCard(item, true);
      }).join("") + "</ul>" : emptyMessage("확인된 평가 결과가 없습니다.")) + "</section></section>";
  }

  function renderPrograms(state, registryInput) {
    var registry = registryInput || createProviderRegistry(state.settings && state.settings.customProviders);
    return '<section><div class="wb-lp__section-head"><div><h2>온라인 프로그램</h2>' +
      "<p>계정 비밀번호는 저장하지 않으며, 외부 결과는 확인 후보로만 반영합니다.</p></div></div>" +
      (state.programStates.length ? '<ul class="wb-lp__card-grid">' + state.programStates.map(function (program) {
        var provider = registry[program.providerId] || registry.manual || { label: program.providerId, active: false };
        var data = program.latestSnapshot && isObject(program.latestSnapshot.data) ? program.latestSnapshot.data : {};
        var assignedKnown = program.assignedCountKnown === true || Number(program.assignedCount) > 0;
        var completedKnown = program.completedCountKnown === true || Number(program.completedCount) > 0;
        var reportedRaw = data.progress_pct === undefined ? data.progressPct : data.progress_pct;
        var reportedNumber = Number(reportedRaw);
        var reportedProgress = reportedRaw !== "" && reportedRaw != null && Number.isFinite(reportedNumber)
          ? Math.max(0, Math.min(100, reportedNumber)) : null;
        var computedProgress = assignedKnown && Number(program.assignedCount) > 0
          ? Math.min(100, Math.round(Number(program.completedCount || 0) / Number(program.assignedCount) * 100)) : null;
        var progress = reportedProgress !== null ? reportedProgress : computedProgress;
        var details = [];
        if (assignedKnown && completedKnown) details.push(program.completedCount + "/" + program.assignedCount + " 수행");
        else if (assignedKnown) details.push("배정 " + program.assignedCount + "개");
        else if (completedKnown) details.push("수행 " + program.completedCount + "개");
        if (reportedProgress !== null) details.push("보고 진행률 " + reportedProgress + "%");
        var currentUnit = text(data.current_unit === undefined ? data.currentUnit : data.current_unit);
        if (currentUnit) details.push("진도 " + currentUnit);
        if (data.score !== undefined && data.score !== null && data.score !== "") {
          var targetScore = data.target_score === undefined ? data.targetScore : data.target_score;
          details.push("점수 " + data.score + (targetScore === undefined || targetScore === null || targetScore === "" ? "" : "/" + targetScore));
        }
        var link = program.deepLink
          ? '<a class="wb-lp__button wb-lp__button--secondary" href="' + escapeHtml(program.deepLink) +
            '" target="_blank" rel="noopener noreferrer">프로그램 열기</a>' : "";
        var progressHtml = progress === null ? "" : '<progress max="100" value="' + progress + '" aria-label="' +
          escapeHtml(provider.label + " 수행률 " + progress + "%") + '"></progress>';
        var disabled = provider.active === false ? '<span class="wb-lp__badge wb-lp__badge--paused">연동 중지</span>' : "";
        return '<li class="wb-lp__card"><div class="wb-lp__card-title"><strong>' + escapeHtml(provider.label) + "</strong>" +
          badge(LABELS.program[program.status] || program.status, program.status) + disabled + "</div>" +
          (details.length ? '<p class="wb-lp__meta">' + escapeHtml(details.join(" · ")) + "</p>" : "") +
          progressHtml + link + "</li>";
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
        var latestResult = campaign.latestResult;
        var resultHtml = latestResult
          ? '<p class="wb-lp__meta">결과 · ' + escapeHtml(latestResult.summary) +
            (latestResult.score === null || latestResult.score === undefined ? "" :
              escapeHtml(" · " + latestResult.score + "/" + latestResult.maxScore)) + "</p>"
          : "";
        return '<li class="wb-lp__card"><div class="wb-lp__card-title"><strong>' +
          escapeHtml(campaign.title) + "</strong>" +
          badge(LABELS.campaign[campaign.status] || campaign.status, campaign.status) + "</div>" +
          '<p class="wb-lp__d-day">' + escapeHtml(dDayLabel(campaign.examDate, date)) + "</p>" +
          '<p class="wb-lp__meta">' + escapeHtml(config.label + " · " + campaign.examDate) + "</p>" +
          resultHtml + blocked + "</li>";
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
    var registry = config.registry || createProviderRegistry(state.settings && state.settings.customProviders);
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
        return renderWeekPlanner(state, currentDate, true);
      }
      if (activeTab === "programs") {
        return renderPrograms(state, registry);
      }
      if (activeTab === "assessments") {
        return renderAssessments(state, currentDate);
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
        tabButton(mountId, "assessments", "정기 평가", activeTab === "assessments") +
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
        if (!config.registry) registry = createProviderRegistry(state.settings && state.settings.customProviders);
        render(false);
      },
      selectTab: function (tab) {
        ensure(["today", "week", "programs", "assessments", "campaigns", "remediation"].indexOf(tab) >= 0, "tab is invalid");
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
    var demoCreatedAt = date + "T00:00:00.000Z";
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
      verificationRequired: true,
      createdAt: demoCreatedAt,
      createdBy: "demo"
    });
    state = addPlannerItem(state, {
      studentCode: state.student.studentCode,
      date: addDays(date, 1),
      title: "클래스카드 단어 복습",
      sourceType: "online_program",
      providerId: "classcard",
      minutes: 15,
      verificationRequired: true,
      createdAt: demoCreatedAt,
      createdBy: "demo"
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
    CAMPAIGN_TRANSITIONS: CAMPAIGN_TRANSITIONS,
    WRONG_ANSWER_STATUSES: WRONG_ANSWER_STATUSES,
    CAMPAIGN_TYPES: CAMPAIGN_TYPES,
    DEFAULT_PROVIDERS: DEFAULT_PROVIDERS,
    LABELS: LABELS,
    createProviderRegistry: createProviderRegistry,
    normalizeCustomProviders: normalizeCustomProviders,
    registerCustomProvider: registerCustomProvider,
    setCustomProviderActive: setCustomProviderActive,
    createProgramImportProviderDefinitions: createProgramImportProviderDefinitions,
    createStudentProfile: createStudentProfile,
    createDefaultState: createDefaultState,
    isOpaqueAccountRef: isOpaqueAccountRef,
    upsertStudentProgramState: upsertStudentProgramState,
    applyApprovedProgramImport: applyApprovedProgramImport,
    createPlannerItem: createPlannerItem,
    addPlannerItem: addPlannerItem,
    editPlannerItem: editPlannerItem,
    cancelPlannerItem: cancelPlannerItem,
    claimPlannerItemCompletion: claimPlannerItemCompletion,
    verifyPlannerItemCompletion: verifyPlannerItemCompletion,
    requestPlannerCarryover: requestPlannerCarryover,
    reviewPlannerCarryover: reviewPlannerCarryover,
    approvePlannerCarryover: approvePlannerCarryover,
    getTodayPlan: getTodayPlan,
    getWeekPlan: getWeekPlan,
    createAssessmentSchedule: createAssessmentSchedule,
    createNeltSchedule: createNeltSchedule,
    createMetaMathSchedule: createMetaMathSchedule,
    expandAssessmentSchedule: expandAssessmentSchedule,
    assessmentOccurrenceToPlannerItem: assessmentOccurrenceToPlannerItem,
    addAssessmentSchedule: addAssessmentSchedule,
    approveAssessmentResult: approveAssessmentResult,
    getElementaryCampaignOptions: getElementaryCampaignOptions,
    createPrepCampaign: createPrepCampaign,
    addPrepCampaign: addPrepCampaign,
    activatePrepCampaign: activatePrepCampaign,
    transitionPrepCampaign: transitionPrepCampaign,
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
    renderAssessments: renderAssessments,
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
