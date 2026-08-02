(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.WBLearningPersistence = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
  var REQUIRED_SPLIT_PARTS = ["core", "plan", "assessment", "campaign", "wrong"];

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function byteLength(value) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).length;
    return unescape(encodeURIComponent(value)).length;
  }

  function commitCandidate(storage, key, candidateState, options) {
    var config = options || {};
    var serialized;
    try {
      serialized = JSON.stringify(candidateState);
    } catch (error) {
      throw new Error(config.serializeErrorMessage || "학습 기록을 직렬화할 수 없어 변경을 저장하지 않았습니다");
    }
    var maxBytes = Number(config.maxBytes) || DEFAULT_MAX_BYTES;
    if (byteLength(serialized) > maxBytes) {
      throw new Error(config.tooLargeMessage || "브라우저 저장 한도에 가까워 변경을 저장하지 않았습니다");
    }
    if (!storage || typeof storage.setItem !== "function") {
      throw new Error(config.writeErrorMessage || "브라우저 저장소를 사용할 수 없어 변경을 저장하지 않았습니다");
    }
    try {
      storage.setItem(String(key), serialized);
    } catch (error) {
      throw new Error(config.writeErrorMessage || "브라우저 저장 공간이 부족해 변경을 저장하지 않았습니다");
    }
    return { state: candidateState, serialized: serialized, bytes: byteLength(serialized) };
  }



  var PLANNER_STORAGE_REQUIRED_FIELDS = Object.freeze({
    itemId: true,
    studentCode: true,
    date: true,
    title: true,
    sourceType: true,
    status: true,
    revision: true,
    createdAt: true,
    createdBy: true
  });

  function cloneStorageValue(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function plannerStorageValueIsEmpty(value) {
    return value === undefined || value === null || value === "" ||
      (Array.isArray(value) && value.length === 0);
  }

  function plannerStorageValuesEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function requirePlannerNormalizer(normalizePlannerItem) {
    if (typeof normalizePlannerItem !== "function") {
      throw new Error("planner item normalizer is required");
    }
    return normalizePlannerItem;
  }

  function compactPlannerItemForStorage(input, normalizePlannerItem) {
    var normalize = requirePlannerNormalizer(normalizePlannerItem);
    var source = input || {};
    var normalized = normalize(source);
    var defaults = normalize({
      studentCode: normalized.studentCode,
      date: normalized.date,
      title: normalized.title,
      sourceType: normalized.sourceType,
      status: normalized.status,
      createdAt: normalized.createdAt,
      createdBy: normalized.createdBy
    });
    var compact = {};
    var keys = Object.keys(normalized);
    Object.keys(source).forEach(function (key) {
      if (keys.indexOf(key) < 0) keys.push(key);
    });
    keys.forEach(function (key) {
      var value = Object.prototype.hasOwnProperty.call(normalized, key)
        ? normalized[key]
        : source[key];
      if (plannerStorageValueIsEmpty(value)) return;
      if (PLANNER_STORAGE_REQUIRED_FIELDS[key]) {
        compact[key] = cloneStorageValue(value);
        return;
      }
      if (key === "history" && plannerStorageValuesEqual(value, defaults.history)) return;
      if (Object.prototype.hasOwnProperty.call(defaults, key) &&
          plannerStorageValuesEqual(value, defaults[key])) return;
      compact[key] = cloneStorageValue(value);
    });
    return compact;
  }

  function compactPlannerItemsForStorage(items, normalizePlannerItem) {
    return (Array.isArray(items) ? items : []).map(function (item) {
      return compactPlannerItemForStorage(item, normalizePlannerItem);
    });
  }

  function restorePlannerItemFromStorage(input, normalizePlannerItem) {
    var normalize = requirePlannerNormalizer(normalizePlannerItem);
    var source = input || {};
    var restored = normalize(source);
    Object.keys(source).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(restored, key) && !plannerStorageValueIsEmpty(source[key])) {
        restored[key] = cloneStorageValue(source[key]);
      }
    });
    return restored;
  }

  function restorePlannerItemsFromStorage(items, normalizePlannerItem) {
    return (Array.isArray(items) ? items : []).map(function (item) {
      return restorePlannerItemFromStorage(item, normalizePlannerItem);
    });
  }

  function plannerItemsSemanticallyEqual(left, right, normalizePlannerItem) {
    return plannerStorageValuesEqual(
      compactPlannerItemsForStorage(left, normalizePlannerItem),
      compactPlannerItemsForStorage(right, normalizePlannerItem)
    );
  }

  function mergePlannerCheckRecords(localRecord, remoteRecord, normalizePlannerItem) {
    if (!localRecord) return { record: cloneStorageValue(remoteRecord), changed: Boolean(remoteRecord), conflicts: [] };
    if (!remoteRecord) return { record: cloneStorageValue(localRecord), changed: false, conflicts: [] };
    if (!Array.isArray(localRecord.value) || !Array.isArray(remoteRecord.value)) {
      throw new Error("planner check value must be an array");
    }
    var normalize = requirePlannerNormalizer(normalizePlannerItem);
    var merged = [];
    var positions = Object.create(null);
    var localIds = Object.create(null);
    var remoteIds = Object.create(null);
    var localWins = false;
    var conflicts = [];

    localRecord.value.forEach(function (source) {
      var item = restorePlannerItemFromStorage(source, normalize);
      if (!item.itemId || Object.prototype.hasOwnProperty.call(positions, item.itemId)) {
        throw new Error("local planner item id is missing or duplicated");
      }
      positions[item.itemId] = merged.length;
      localIds[item.itemId] = true;
      merged.push(item);
    });

    remoteRecord.value.forEach(function (source) {
      var remoteItem = restorePlannerItemFromStorage(source, normalize);
      var itemId = remoteItem.itemId;
      if (!itemId || remoteIds[itemId]) throw new Error("remote planner item id is missing or duplicated");
      remoteIds[itemId] = true;
      if (!Object.prototype.hasOwnProperty.call(positions, itemId)) {
        positions[itemId] = merged.length;
        merged.push(remoteItem);
        return;
      }
      var position = positions[itemId];
      var localItem = merged[position];
      var localRevision = Number(localItem.revision || 0);
      var remoteRevision = Number(remoteItem.revision || 0);
      if (remoteRevision > localRevision) {
        merged[position] = remoteItem;
      } else if (remoteRevision < localRevision) {
        localWins = true;
      } else if (plannerItemsSemanticallyEqual([localItem], [remoteItem], normalize)) {
        merged[position] = remoteItem;
      } else {
        localWins = true;
        conflicts.push(itemId);
      }
    });

    Object.keys(localIds).forEach(function (itemId) {
      if (!remoteIds[itemId]) localWins = true;
    });
    var base = cloneStorageValue(localWins ? localRecord : remoteRecord);
    base.value = compactPlannerItemsForStorage(merged, normalize);
    base.updatedAt = Math.max(Number(localRecord.updatedAt) || 0, Number(remoteRecord.updatedAt) || 0);
    var changed = !plannerStorageValuesEqual(localRecord, base);
    return { record: base, changed: changed, conflicts: conflicts, localPreserved: localWins };
  }

  function corrupt(code, message, missing) {
    return {
      kind: "corrupt",
      code: code,
      message: message,
      missingParts: missing || []
    };
  }

  function inspectLearningRecords(input) {
    var records = input || {};
    var legacy = records.legacy;
    var anySplit = REQUIRED_SPLIT_PARTS.some(function (name) { return Boolean(records[name]); });

    if (!legacy && !anySplit) return { kind: "uninitialized", stored: null };

    if (anySplit) {
      var missing = REQUIRED_SPLIT_PARTS.filter(function (name) { return !records[name]; });
      if (missing.length) {
        return corrupt("LP_PARTIAL_STATE", "학습 기록 조각 일부가 누락됐습니다", missing);
      }
      var core = records.core.value;
      var plan = records.plan.value;
      var assessment = records.assessment.value;
      var campaigns = records.campaign.value;
      var wrong = records.wrong.value;
      if (!isObject(core) || !Array.isArray(plan) || !isObject(assessment) ||
          !Array.isArray(assessment.schedules) || !Array.isArray(assessment.occurrences) ||
          !Array.isArray(campaigns) || !Array.isArray(wrong)) {
        return corrupt("LP_INVALID_PART", "학습 기록 조각 형식이 손상됐습니다");
      }
      return {
        kind: "split",
        stored: Object.assign({}, core, {
          plannerItems: plan,
          assessmentSchedules: assessment.schedules,
          assessmentOccurrences: assessment.occurrences,
          prepCampaigns: campaigns,
          remediationCases: wrong
        })
      };
    }

    if (!isObject(legacy) || !isObject(legacy.platformState)) {
      return corrupt("LP_INVALID_LEGACY", "기존 학습 기록 형식이 손상됐습니다");
    }
    return { kind: "legacy", stored: legacy.platformState };
  }

  return Object.freeze({
    DEFAULT_MAX_BYTES: DEFAULT_MAX_BYTES,
    commitCandidate: commitCandidate,
    compactPlannerItemForStorage: compactPlannerItemForStorage,
    compactPlannerItemsForStorage: compactPlannerItemsForStorage,
    restorePlannerItemFromStorage: restorePlannerItemFromStorage,
    restorePlannerItemsFromStorage: restorePlannerItemsFromStorage,
    plannerItemsSemanticallyEqual: plannerItemsSemanticallyEqual,
    mergePlannerCheckRecords: mergePlannerCheckRecords,
    inspectLearningRecords: inspectLearningRecords
  });
});
