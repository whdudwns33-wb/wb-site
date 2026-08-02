(function (root, factory) {
  "use strict";
  var platform = root && root.WBLearningPlatform;
  if (typeof module === "object" && module.exports) {
    platform = require("./learning-platform.js");
    module.exports = factory(platform);
    return;
  }
  root.WBLearningShell = factory(platform);
})(typeof globalThis !== "undefined" ? globalThis : this, function (lp) {
  "use strict";

  if (!lp) throw new Error("WBLearningPlatform is required");

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function text(value) {
    return value === undefined || value === null ? "" : String(value).trim();
  }

  function escapeHtml(value) {
    return text(value).replace(/[&<>"']/g, function (character) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character];
    });
  }

  function ensureNoCredentials(value, path) {
    if (!value || typeof value !== "object") return;
    Object.keys(value).forEach(function (key) {
      if (/(password|passwd|secret|token|cookie|credential|api.?key)/i.test(key)) {
        throw new Error((path || "input") + "." + key + " must not be stored");
      }
      ensureNoCredentials(value[key], (path || "input") + "." + key);
    });
  }

  function createInitialState(input) {
    var source = input || {};
    return lp.createDefaultState({
      student: {
        studentCode: text(source.studentCode),
        displayName: text(source.displayName),
        academicStage: text(source.academicStage) || "elementary",
        grade: Number(source.grade) || 1,
        timeZone: "Asia/Seoul"
      }
    });
  }

  function normalizeState(input, fallbackStudent) {
    ensureNoCredentials(input || {}, "state");
    if (!input) return createInitialState(fallbackStudent);
    var migrated = lp.migrateLearningPlatformState(input, {});
    var state = migrated.state;
    if (fallbackStudent) {
      state.student.studentCode = text(fallbackStudent.studentCode) || state.student.studentCode;
      state.student.displayName = text(fallbackStudent.displayName) || state.student.displayName;
    }
    if (state.student.academicStage === "elementary") {
      state.settings.schoolRegularExamEnabled = false;
    }
    return state;
  }


  function applyCompletionClaims(stateInput, claimsInput) {
    var state = clone(stateInput);
    var claims = Array.isArray(claimsInput) ? claimsInput : [];
    claims.slice(-200).forEach(function (claim) {
      var itemId = text(claim && claim.itemId);
      var item = state.plannerItems.find(function (candidate) { return candidate.itemId === itemId; });
      if (!item || ["planned", "in_progress", "check_needed"].indexOf(item.status) < 0) return;
      var expectedRevision = Number(claim && claim.expectedRevision);
      if (!Number.isInteger(expectedRevision) || expectedRevision !== Number(item.revision || 1)) return;
      if (text(claim && claim.date) !== item.date) return;
      try {
        state = lp.claimPlannerItemCompletion(state, itemId, "", text(claim.claimedAt) || new Date().toISOString());
      } catch (_error) {}
    });
    return state;
  }

  function addStandardSchedules(stateInput, options) {
    var optionsSafe = options || {};
    var state = clone(stateInput);
    var fromDate = text(optionsSafe.fromDate);
    var toDate = text(optionsSafe.toDate) || lp.date.addDays(fromDate, 365);
    var studentCode = state.student.studentCode;
    if (optionsSafe.nelt !== false) {
      state = lp.addAssessmentSchedule(state, lp.createNeltSchedule({
        studentCode: studentCode,
        anchorDate: text(optionsSafe.neltAnchor) || fromDate
      }), { fromDate: fromDate, toDate: toDate, resetAnchor: optionsSafe.resetAnchor === true });
    }
    if (optionsSafe.metaMath !== false) {
      state = lp.addAssessmentSchedule(state, lp.createMetaMathSchedule({
        studentCode: studentCode,
        anchorDate: fromDate,
        kind: "weekly",
        weekday: Number(optionsSafe.weekday) || 5
      }), { fromDate: fromDate, toDate: toDate, resetAnchor: optionsSafe.resetAnchor === true });
      state = lp.addAssessmentSchedule(state, lp.createMetaMathSchedule({
        studentCode: studentCode,
        anchorDate: fromDate,
        kind: "month_end"
      }), { fromDate: fromDate, toDate: toDate, resetAnchor: optionsSafe.resetAnchor === true });
    }
    return state;
  }

  function activateCampaign(stateInput, campaignId, approval, today) {
    var input = approval || {};
    var activationAt = text(input.consentApprovedAt || input.approvedAt) || new Date().toISOString();
    var activationActor = text(input.approvedBy) || "academy-admin";
    var state = lp.activatePrepCampaign(stateInput, campaignId, {
      approvedBy: text(input.approvedBy),
      consentEvidenceRef: text(input.consentEvidenceRef),
      consentApprovedBy: text(input.consentApprovedBy),
      consentApprovedAt: text(input.consentApprovedAt)
    });
    var campaign = state.prepCampaigns.find(function (item) { return item.campaignId === campaignId; });
    lp.campaignMilestonesToPlannerItems(campaign, {
      today: today,
      createdAt: activationAt,
      createdBy: activationActor
    }).forEach(function (item) {
      var tombstoneIndex = state.plannerItems.findIndex(function (existing) {
        return existing.itemId === item.itemId && existing.campaignId === campaignId &&
          existing.status === "canceled" && existing.systemHidden === true &&
          existing.systemHiddenReason === "campaign_profile_transition";
      });
      if (tombstoneIndex >= 0) {
        var tombstone = lp.createPlannerItem(state.plannerItems[tombstoneIndex]);
        var history = clone(tombstone.history || []);
        history.push({
          action: "campaign_profile_reactivated",
          fromStatus: tombstone.status,
          toStatus: item.status,
          at: activationAt,
          actor: activationActor,
          campaignId: campaignId,
          priorSystemHiddenReason: tombstone.systemHiddenReason
        });
        state.plannerItems[tombstoneIndex] = lp.createPlannerItem(Object.assign({}, tombstone, {
          date: item.date,
          planId: item.planId,
          title: item.title,
          detail: item.detail,
          minutes: item.minutes,
          priority: item.priority,
          status: item.status,
          systemHidden: false,
          systemReactivatedAt: activationAt,
          systemReactivatedBy: activationActor,
          updatedAt: activationAt,
          updatedBy: activationActor,
          history: history,
          revision: Number(tombstone.revision || 0) + 1
        }));
      }
      state = lp.addPlannerItem(state, item);
    });
    return state;
  }

  function advanceWrongCase(stateInput, caseId, input) {
    var state = clone(stateInput);
    var item = state.remediationCases.find(function (candidate) { return candidate.caseId === caseId; });
    if (!item) throw new Error("오답 사례를 찾을 수 없습니다");
    var meta = input || {};
    var actor = text(meta.actor) || "academy-admin";
    var at = text(meta.at) || new Date().toISOString();
    if (item.status === "captured" || item.status === "generation_failed" || item.status === "retry_required" || item.status === "recheck_scheduled") {
      item = lp.requestTwinGeneration(item, { actor: actor, at: at });
    } else if (item.status === "generation_requested") {
      if (!text(meta.externalRef)) throw new Error("메타수학 문제세트 참조가 필요합니다");
      item = lp.transitionWrongAnswerCase(item, "generated", {
        metaMathProblemSetId: text(meta.externalRef), actor: actor, at: at
      });
    } else if (item.status === "generated") {
      item = lp.transitionWrongAnswerCase(item, "review_waiting", { actor: actor, at: at });
    } else if (item.status === "review_waiting") {
      if (!text(meta.externalRef)) throw new Error("배정 참조가 필요합니다");
      item = lp.transitionWrongAnswerCase(item, "assigned", {
        assignmentId: text(meta.externalRef), actor: actor, at: at
      });
    } else if (item.status === "assigned" || item.status === "in_progress") {
      item = lp.transitionWrongAnswerCase(item, "submitted", { actor: actor, at: at });
    } else if (item.status === "submitted" || item.status === "result_waiting") {
      if (!text(meta.externalRef)) throw new Error("결과 참조가 필요합니다");
      item = lp.recordTwinResult(item, {
        externalResultRef: text(meta.externalRef),
        correctCount: meta.correctCount,
        totalCount: meta.totalCount,
        receivedAt: at,
        actor: actor
      });
    } else if (item.status === "verification_waiting") {
      var review = {
        mastered: meta.mastered === true,
        verifiedBy: actor,
        at: at
      };
      if (meta.mastered !== true && text(meta.nextRecheckDate)) {
        review.nextRecheckDate = text(meta.nextRecheckDate);
      }
      item = lp.reviewTwinResult(item, review);
    } else {
      throw new Error("현재 단계에서는 다음 처리로 이동할 수 없습니다");
    }
    return lp.addRemediationCase(state, item);
  }

  function applyCommand(stateInput, command, context) {
    var state = clone(stateInput);
    var cmd = command || {};
    var ctx = context || {};
    ensureNoCredentials(cmd, "command");

    if (cmd.type === "profile_update") {
      var previousStage = state.student.academicStage;
      var previousGrade = state.student.grade;
      var transitionAt = text(ctx.at) || new Date().toISOString();
      var transitionActor = text(ctx.actorId) || "system";
      state.student = lp.createStudentProfile({
        studentCode: state.student.studentCode,
        displayName: state.student.displayName,
        academicStage: cmd.academicStage,
        grade: Number(cmd.grade),
        timeZone: "Asia/Seoul"
      });
      state.settings.schoolRegularExamEnabled = state.student.academicStage !== "elementary";
      var enteredElementary = previousStage !== "elementary" && state.student.academicStage === "elementary";
      var leftElementary = previousStage === "elementary" && state.student.academicStage !== "elementary";
      var blockedSchoolCampaignIds = [];
      state.prepCampaigns = state.prepCampaigns.map(function (campaign) {
        if (["completed", "canceled", "archived"].indexOf(campaign.status) >= 0) return campaign;
        var nextCampaign = Object.assign({}, campaign, {
          academicStage: state.student.academicStage,
          grade: state.student.grade,
          revision: Number(campaign.revision || 0) + 1,
          history: clone(Array.isArray(campaign.history) ? campaign.history : [])
        });
        nextCampaign.history.push({
          event: "profile_transition",
          fromAcademicStage: previousStage,
          toAcademicStage: state.student.academicStage,
          fromGrade: previousGrade,
          toGrade: state.student.grade,
          actor: transitionActor,
          at: transitionAt
        });
        if (leftElementary && campaign.campaignType === "school_regular" &&
            campaign.activationBlockedReason === "ELEMENTARY_REGULAR_EXAM_DISABLED") {
          nextCampaign.activationBlockedReason = "";
          nextCampaign.migrationReviewRequired = true;
          nextCampaign.consentStatus = "not_required";
          nextCampaign.status = "review_pending";
          nextCampaign.history.push({
            event: "profile_transition_review_required",
            reason: "SCHOOL_REGULAR_REVIEW_AFTER_ELEMENTARY",
            actor: transitionActor,
            at: transitionAt
          });
          return nextCampaign;
        }
        if (!enteredElementary) return nextCampaign;
        var hasRecordedParticipation = ["taken", "result_waiting", "result_review", "check_needed"].indexOf(campaign.status) >= 0 ||
          Boolean(campaign.latestResult) || (Array.isArray(campaign.resultHistory) && campaign.resultHistory.length > 0);
        if (campaign.campaignType === "school_regular") {
          nextCampaign.activationBlockedReason = "ELEMENTARY_REGULAR_EXAM_DISABLED";
          nextCampaign.migrationReviewRequired = true;
          nextCampaign.status = hasRecordedParticipation ? "check_needed" : "draft";
          blockedSchoolCampaignIds.push(campaign.campaignId);
        } else if (lp.CAMPAIGN_TYPES[campaign.campaignType] && lp.CAMPAIGN_TYPES[campaign.campaignType].elementarySelectable) {
          nextCampaign.consentStatus = "pending";
          nextCampaign.consentEvidenceRef = "";
          nextCampaign.consentApprovedBy = "";
          nextCampaign.consentApprovedAt = "";
          nextCampaign.migrationReviewRequired = true;
          nextCampaign.status = hasRecordedParticipation ? "check_needed" : "consent_pending";
        }
        return nextCampaign;
      });
      if (enteredElementary && blockedSchoolCampaignIds.length) {
        var cancelableStatuses = ["planned", "in_progress", "check_needed", "carryover_candidate"];
        var targetIds = state.plannerItems.filter(function (item) {
          return item.sourceType === "prep_campaign" &&
            blockedSchoolCampaignIds.indexOf(item.campaignId) >= 0 &&
            cancelableStatuses.indexOf(item.status) >= 0;
        }).map(function (item) { return item.itemId; });
        targetIds.forEach(function (itemId) {
          var target = state.plannerItems.find(function (item) { return item.itemId === itemId; });
          if (target && target.status === "carryover_candidate") {
            state = lp.reviewPlannerCarryover(state, itemId, {
              approved: false,
              reason: "campaign_profile_transition",
              reviewedBy: transitionActor,
              reviewedAt: transitionAt
            });
          }
          state = lp.cancelPlannerItem(state, itemId, {
            reason: "campaign_profile_transition",
            canceledBy: transitionActor,
            canceledAt: transitionAt
          });
          state.plannerItems = state.plannerItems.map(function (item) {
            if (item.itemId !== itemId) return item;
            return Object.assign({}, item, {
              systemHidden: true,
              systemHiddenReason: "campaign_profile_transition",
              systemHiddenAt: transitionAt,
              systemHiddenBy: transitionActor,
              systemReactivatedAt: "",
              systemReactivatedBy: ""
            });
          });
        });
      }
      return state;
    }
    if (cmd.type === "provider_register") {
      return lp.registerCustomProvider(state, {
        id: cmd.providerId,
        label: cmd.label,
        capabilities: cmd.capabilities,
        active: cmd.active !== false
      }, { actor: ctx.actorId, at: ctx.at });
    }
    if (cmd.type === "provider_toggle") {
      return lp.setCustomProviderActive(state, cmd.providerId, cmd.active, {
        actor: ctx.actorId, at: ctx.at
      });
    }
    if (cmd.type === "program_upsert") {
      var registry = lp.createProviderRegistry(state.settings && state.settings.customProviders);
      var programInput = {
        studentCode: state.student.studentCode,
        providerId: cmd.providerId,
        status: cmd.status,
        accountIdRef: cmd.accountIdRef,
        lastCheckedAt: cmd.lastCheckedAt || new Date().toISOString()
      };
      if (text(cmd.assignedCount) !== "") programInput.assignedCount = cmd.assignedCount;
      if (text(cmd.completedCount) !== "") programInput.completedCount = cmd.completedCount;
      return lp.upsertStudentProgramState(state, programInput, registry);
    }
    if (cmd.type === "planner_add") {
      return lp.addPlannerItem(state, {
        studentCode: state.student.studentCode,
        date: cmd.date,
        title: cmd.title,
        detail: cmd.detail,
        sourceType: cmd.providerId ? "online_program" : "academy",
        providerId: cmd.providerId,
        minutes: Number(cmd.minutes) || 0,
        verificationRequired: true,
        createdBy: text(ctx.actorId) || "academy-admin",
        createdAt: text(ctx.at) || new Date().toISOString()
      });
    }
    if (cmd.type === "planner_edit") {
      return lp.editPlannerItem(state, cmd.itemId, {
        date: cmd.date, title: cmd.title, minutes: cmd.minutes
      }, { actor: ctx.actorId, at: ctx.at, reason: cmd.reason });
    }
    if (cmd.type === "planner_cancel") {
      return lp.cancelPlannerItem(state, cmd.itemId, {
        reason: cmd.reason, canceledBy: ctx.actorId, canceledAt: ctx.at
      });
    }
    if (cmd.type === "planner_carryover_request") {
      return lp.requestPlannerCarryover(state, cmd.itemId, cmd.date, {
        reason: cmd.reason, requestedBy: ctx.actorId, requestedAt: ctx.at
      });
    }
    if (cmd.type === "planner_carryover_review") {
      return lp.reviewPlannerCarryover(state, cmd.itemId, {
        approved: cmd.approved, date: cmd.date, reason: cmd.reason,
        reviewedBy: ctx.actorId, reviewedAt: ctx.at
      });
    }
    if (cmd.type === "schedules_generate") {
      return addStandardSchedules(state, cmd);
    }
    if (cmd.type === "assessment_result_approve") {
      return lp.approveAssessmentResult(state, cmd.occurrenceId, {
        score: cmd.score,
        maxScore: cmd.maxScore,
        evidenceRef: cmd.evidenceRef,
        externalRef: cmd.externalRef,
        verifiedBy: ctx.actorId,
        verifiedAt: ctx.at
      });
    }
    if (cmd.type === "campaign_add") {
      return lp.addPrepCampaign(state, {
        campaignType: cmd.campaignType,
        title: cmd.title,
        provider: cmd.provider,
        examDate: cmd.examDate,
        subjectCodes: cmd.subjectCodes || [],
        consentStatus: state.student.academicStage === "elementary" ? "pending" : "not_required"
      });
    }
    if (cmd.type === "campaign_activate") {
      return activateCampaign(state, cmd.campaignId, {
        approvedBy: ctx.actorId,
        consentEvidenceRef: cmd.consentEvidenceRef,
        consentApprovedBy: ctx.actorId,
        consentApprovedAt: ctx.at
      }, ctx.today);
    }
    if (cmd.type === "campaign_transition") {
      return lp.transitionPrepCampaign(state, cmd.campaignId, cmd.toStatus, {
        actor: ctx.actorId,
        at: ctx.at,
        evidenceRef: cmd.evidenceRef,
        externalRef: cmd.externalRef,
        resultSummary: cmd.resultSummary,
        score: cmd.score,
        maxScore: cmd.maxScore
      });
    }
    if (cmd.type === "planner_verify") {
      return lp.verifyPlannerItemCompletion(state, cmd.itemId, {
        approved: cmd.approved,
        evidenceRef: cmd.evidenceRef,
        verifiedBy: ctx.actorId,
        verifiedAt: ctx.at
      });
    }
    if (cmd.type === "wrong_add") {
      return lp.addRemediationCase(state, lp.createWrongAnswerCase({
        studentCode: state.student.studentCode,
        textbookId: cmd.textbookId,
        edition: cmd.edition,
        unitId: cmd.unitId,
        page: cmd.page,
        problemNo: cmd.problemNo,
        skillCode: cmd.skillCode,
        createdBy: ctx.actorId,
        createdAt: ctx.at
      }));
    }
    if (cmd.type === "wrong_advance") {
      return advanceWrongCase(state, cmd.caseId, Object.assign({}, cmd, {
        actor: ctx.actorId,
        at: ctx.at
      }));
    }
    throw new Error("지원하지 않는 학습관리 명령입니다");
  }

  function option(value, label, selected) {
    return '<option value="' + escapeHtml(value) + '"' + (selected ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
  }

  function nextCampaignStatus(status) {
    var options = lp.CAMPAIGN_TRANSITIONS[status] || [];
    return options.length ? options[0] : "";
  }

  function nextCampaignLabel(status) {
    return ({
      active: "응시 준비 확인",
      exam_ready: "응시 완료 확인",
      taken: "결과 대기 전환",
      result_waiting: "결과 검토 승인",
      result_review: "캠페인 완료 승인"
    })[status] || "다음 단계";
  }

  function nextWrongLabel(status) {
    return ({
      captured: "쌍둥이 출제 요청", generation_failed: "다시 출제 요청", retry_required: "다시 출제 요청",
      recheck_scheduled: "재확인 출제 요청", generation_requested: "문제세트 연결", generated: "선생님 검토로",
      review_waiting: "학생에게 배정", assigned: "제출 처리", in_progress: "제출 처리",
      submitted: "결과 연결", result_waiting: "결과 연결", verification_waiting: "숙달 판정"
    })[status] || "확인필요";
  }

  function renderManagementControls(state, options) {
    var config = options || {};
    if (!config.canManage) return '';
    var today = text(config.today);
    var registry = lp.createProviderRegistry(state.settings && state.settings.customProviders);
    var providers = Object.keys(registry).filter(function (providerId) { return registry[providerId].active !== false; });
    var customProviders = (state.settings && Array.isArray(state.settings.customProviders))
      ? state.settings.customProviders : [];
    var visiblePlannerItems = state.plannerItems.filter(function (item) { return item.systemHidden !== true; });
    var plannerManageItems = visiblePlannerItems.slice().sort(function (left, right) {
      return (left.date + "|" + left.title).localeCompare(right.date + "|" + right.title, "ko");
    }).slice(-30);
    var campaigns = state.student.academicStage === "elementary"
      ? lp.getElementaryCampaignOptions()
      : Object.keys(lp.CAMPAIGN_TYPES).map(function (key) { return { value: key, label: lp.CAMPAIGN_TYPES[key].label }; });
    var pendingItems = visiblePlannerItems.filter(function (item) {
      return item.status === "verification_waiting" && item.sourceType !== "assessment";
    });
    var pending = pendingItems.length;
    var assessmentOccurrences = state.assessmentOccurrences.slice().sort(function (left, right) {
      return left.scheduledDate.localeCompare(right.scheduledDate);
    });
    var recentAssessmentResults = assessmentOccurrences.filter(function (item) {
      return Boolean(item.latestResult);
    }).sort(function (left, right) {
      return text(right.latestResult.verifiedAt).localeCompare(text(left.latestResult.verifiedAt));
    }).slice(0, 5);
    var workload = lp.analyzeWorkload({ student: state.student, anchorDate: today, campaigns: state.prepCampaigns, items: visiblePlannerItems });

    var html = '<div class="card"><div class="card-title">통합 학습 설정</div>' +
      '<div class="card-sub mb14">기존 앱 안에서 온라인 프로그램·플래너·평가·시험대비·오답 재학습을 학생별로 관리합니다.</div>' +
      '<div class="row"><select class="in" id="lpStage" aria-label="학생 학교 단계">' +
        option('elementary', '초등', state.student.academicStage === 'elementary') +
        option('middle', '중등', state.student.academicStage === 'middle') +
        option('high', '고등', state.student.academicStage === 'high') +
      '</select><input class="in" id="lpGrade" type="number" min="1" max="12" value="' + escapeHtml(state.student.grade) + '" placeholder="학년" aria-label="학생 학년">' +
      '<button class="btn btn-ghost" data-act="lpprofile">학년 단계 저장</button></div>' +
      (state.student.academicStage === 'elementary'
        ? '<div class="hint">초등은 학교 정기시험이 기본 비활성화됩니다. 경시·KMT·NELT·영재원·입학·레벨테스트만 선택 연결합니다.</div>'
        : '<div class="hint">중·고등은 학교 정기시험 캠페인도 선택할 수 있습니다.</div>') + '</div>';

    html += '<div class="card"><div class="between mb8"><div class="card-title">정기 평가 일정</div>' +
      '<span class="pill">NELT 3개월 · 메타수학 주간/월말</span></div>' +
      '<div class="row"><input class="in" id="lpScheduleFrom" type="date" value="' + escapeHtml(today) + '" aria-label="정기평가 생성 기준일">' +
      '<select class="in" id="lpWeekday" aria-label="메타수학 주간평가 요일">' + [1,2,3,4,5,6].map(function (day) {
        return option(day, ['','월','화','수','목','금','토'][day] + '요일', day === 5);
      }).join('') + '</select><button class="btn btn-primary" data-act="lpschedule">1년 일정 생성</button></div>' +
      '<div class="hint">같은 회차는 결정적 ID로 중복 생성되지 않습니다. 결과는 사람 확인 전 완료 처리되지 않습니다.</div></div>';

    html += '<div class="card"><div class="between mb8"><div class="card-title">정기 평가 결과 승인</div><span class="pill">사람 확인 전용</span></div>' +
      '<div class="card-sub mb8">NELT·메타수학 결과는 근거를 확인한 회차만 승인하며, 승인 전에는 연결 플래너를 완료하지 않습니다.</div>' +
      '<div class="row"><select class="in" id="lpAssessmentOccurrence" aria-label="평가 회차 선택">' +
      (assessmentOccurrences.length ? assessmentOccurrences.map(function (item) {
        var resultMark = item.latestResult ? ' · 결과 ' + item.latestResult.score + '/' + item.latestResult.maxScore : '';
        return option(item.occurrenceId, item.scheduledDate + ' · ' + item.title + resultMark, false);
      }).join('') : '<option value="">평가 회차 없음</option>') +
      '</select><input class="in" id="lpAssessmentScore" type="number" min="0" step="0.01" placeholder="점수" aria-label="평가 점수">' +
      '<input class="in" id="lpAssessmentMaxScore" type="number" min="0.01" step="0.01" placeholder="만점" aria-label="평가 만점"></div>' +
      '<div class="row mt8"><input class="in" id="lpAssessmentEvidence" placeholder="검증 근거 참조" aria-label="평가 검증 근거 참조">' +
      '<input class="in" id="lpAssessmentExternal" placeholder="외부 결과 참조 (선택)" aria-label="평가 외부 결과 참조">' +
      '<button class="btn btn-primary" data-act="lpassessmentapprove">결과 승인</button></div>' +
      (recentAssessmentResults.length ? '<div class="mt14">' + recentAssessmentResults.map(function (item) {
        return '<div class="between small mt8"><span>' + escapeHtml(item.scheduledDate + ' · ' + item.title) + '</span><span class="pill">' +
          escapeHtml(item.latestResult.score + '/' + item.latestResult.maxScore + ' · ' + item.latestResult.percentage + '%') + '</span></div>';
      }).join('') + '</div>' : '<div class="hint">아직 사람이 승인한 평가 결과가 없습니다.</div>') + '</div>';

    html += '<div class="card"><div class="card-title">온라인 프로그램 등록·점검</div>' +
      '<div class="row wraprow"><select class="in" id="lpProvider" aria-label="온라인 프로그램">' + providers.map(function (providerId) {
        return option(providerId, registry[providerId].label, false);
      }).join('') + '</select><select class="in" id="lpProgramStatus" aria-label="프로그램 상태">' +
        option('active', '사용중', true) + option('partial', '부분완료', false) +
        option('incomplete', '미완료', false) + option('check_needed', '확인필요', false) +
      '</select></div><div class="row wraprow"><input class="in" id="lpAccountRef" placeholder="계정 참조 ID (비밀번호 금지)" aria-label="계정 참조 ID">' +
      '<input class="in" id="lpAssigned" type="number" min="0" placeholder="배정 수 (선택)" aria-label="배정 수">' +
      '<input class="in" id="lpCompleted" type="number" min="0" placeholder="수행 수 (선택)" aria-label="수행 수">' +
      '<button class="btn btn-primary" data-act="lpprogram">저장</button></div>' +
      '<div class="hint">배정·수행 수를 비워 두면 기존 수량을 유지합니다.</div></div>';

    html += '<div class="card"><div class="card-title">추가 온라인 프로그램</div>' +
      '<div class="card-sub mb8">ID는 영문 소문자·숫자·하이픈만 사용하며 비밀번호·토큰은 저장하지 않습니다.</div>' +
      '<div class="row wraprow"><input class="in" id="lpCustomProviderId" placeholder="provider-id" aria-label="추가 프로그램 ID">' +
      '<input class="in" id="lpCustomProviderLabel" placeholder="프로그램 이름" aria-label="추가 프로그램 이름">' +
      '<input class="in" id="lpCustomProviderCapabilities" placeholder="progress,result,assignment" aria-label="기능 목록">' +
      '<button class="btn btn-primary" data-act="lpprovideradd">등록</button></div>' +
      customProviders.map(function (provider) {
        return '<div class="between small mt8"><span><strong>' + escapeHtml(provider.label) + '</strong> · ' +
          escapeHtml(provider.id) + ' · ' + escapeHtml((provider.capabilities || []).join(', ') || '기능 미지정') + '</span>' +
          '<button class="btn btn-sm btn-ghost" data-act="lpprovidertoggle" data-id="' + escapeHtml(provider.id) +
          '" data-active="' + (provider.active === false ? 'true' : 'false') + '">' +
          (provider.active === false ? '다시 사용' : '사용 중지') + '</button></div>';
      }).join('') + '</div>';

    html += '<div class="card"><div class="card-title">프로그램 결과 가져오기</div>' +
      '<div class="card-sub mb8">CSV 또는 JSON을 먼저 미리보기하고, 차단 사유를 확인한 뒤 사람이 승인한 행만 반영합니다.</div>' +
      '<div class="row wraprow"><select class="in" id="lpImportProvider" aria-label="가져올 프로그램">' + providers.map(function (providerId) {
        return option(providerId, registry[providerId].label, false);
      }).join('') + '</select><button class="btn btn-ghost" data-act="lpimportpreview">미리보기</button></div>' +
      '<textarea class="in mt8" id="lpImportText" rows="5" aria-label="프로그램 결과 CSV 또는 JSON" placeholder="student_code,check_date,status,current_unit&#10;' + escapeHtml(state.student.studentCode) + ',2026-08-03,부분완료,12회"></textarea>' +
      '<div class="hint">비밀번호·토큰·쿠키 열이 있으면 해당 행은 차단되고 해시에도 포함되지 않습니다.</div></div>';

    html += '<div class="card"><div class="between mb8"><div class="card-title">플래너 확인·관리</div><span class="pill ' + (pending ? 'warn' : '') + '">확인대기 ' + pending + '건</span></div>' +
      '<div class="row wraprow"><input class="in" id="lpPlanDate" type="date" value="' + escapeHtml(today) + '" aria-label="새 플래너 날짜">' +
      '<input class="in" id="lpPlanTitle" placeholder="학습 과제" aria-label="새 플래너 제목"><input class="in" id="lpPlanMinutes" type="number" min="0" placeholder="분" aria-label="새 플래너 시간">' +
      '<select class="in" id="lpPlanProvider" aria-label="새 플래너 프로그램"><option value="">학원 과제</option>' + providers.map(function (providerId) {
        return option(providerId, registry[providerId].label, false);
      }).join('') + '</select><button class="btn btn-primary" data-act="lpplan">추가</button></div>' +
      pendingItems.map(function (item) { return '<div class="small mt14"><div class="between"><span><strong>' + escapeHtml(item.title) + '</strong> · ' + escapeHtml(item.date) + '</span><span class="pill warn">검토 필요</span></div><div class="row wraprow mt8"><label class="small">완료 근거 참조<input class="in" data-lp-verify-evidence="' + escapeHtml(item.itemId) + '" placeholder="리포트·제출물·상담 기록 참조" aria-label="' + escapeHtml(item.title + ' 완료 검증 근거 참조') + '"></label><button class="btn btn-sm btn-primary" data-act="lpverifyitem" data-decision="approve" data-id="' + escapeHtml(item.itemId) + '">완료 승인</button><button class="btn btn-sm btn-warn" data-act="lpverifyitem" data-decision="reject" data-id="' + escapeHtml(item.itemId) + '">반려</button></div></div>'; }).join('') +
      '<div class="card-sub mt14">최근 플래너 편집·취소·이월</div>' +
      plannerManageItems.map(function (item) {
        var editable = ['planned','in_progress','check_needed'].indexOf(item.status) >= 0;
        var candidate = item.status === 'carryover_candidate';
        var assessmentLinked = Boolean(item.occurrenceId);
        var controls;
        if (assessmentLinked) {
          controls = '<div class="hint mt8" role="note" aria-label="평가 연계 플래너 관리 안내">평가 일정에서 관리합니다. 일정 변경과 결과 승인은 위 정기 평가 영역에서 처리하세요.</div>';
        } else if (candidate) {
          controls = '<div class="row wraprow mt8"><input class="in" data-lp-plan-reason="' + escapeHtml(item.itemId) + '" placeholder="이월 반려 사유" aria-label="' + escapeHtml(item.title + ' 이월 반려 사유') + '">' +
            '<input class="in" type="date" data-lp-plan-carry-date="' + escapeHtml(item.itemId) + '" value="' + escapeHtml(item.carryoverRequestedDate || lp.date.addDays(item.date, 1)) + '" aria-label="' + escapeHtml(item.title + ' 이월 승인 날짜') + '">' +
            '<button class="btn btn-sm btn-primary" data-act="lpplancarryreview" data-decision="approve" data-id="' + escapeHtml(item.itemId) + '">이월 승인</button>' +
            '<button class="btn btn-sm btn-warn" data-act="lpplancarryreview" data-decision="reject" data-id="' + escapeHtml(item.itemId) + '">이월 반려</button></div>';
        } else if (editable) {
          controls = '<div class="row wraprow mt8"><input class="in" type="date" data-lp-plan-date="' + escapeHtml(item.itemId) + '" value="' + escapeHtml(item.date) + '" aria-label="' + escapeHtml(item.title + ' 날짜') + '">' +
            '<input class="in" data-lp-plan-title="' + escapeHtml(item.itemId) + '" value="' + escapeHtml(item.title) + '" aria-label="' + escapeHtml(item.title + ' 제목') + '">' +
            '<input class="in" type="number" min="0" data-lp-plan-minutes="' + escapeHtml(item.itemId) + '" value="' + escapeHtml(item.minutes) + '" aria-label="' + escapeHtml(item.title + ' 분') + '">' +
            '<button class="btn btn-sm btn-ghost" data-act="lpplanedit" data-id="' + escapeHtml(item.itemId) + '">편집 저장</button></div>' +
            '<div class="row wraprow mt8"><input class="in" data-lp-plan-reason="' + escapeHtml(item.itemId) + '" placeholder="취소·이월 사유" aria-label="' + escapeHtml(item.title + ' 취소 또는 이월 사유') + '">' +
            '<input class="in" type="date" data-lp-plan-carry-date="' + escapeHtml(item.itemId) + '" value="' + escapeHtml(lp.date.addDays(item.date, 1)) + '" aria-label="' + escapeHtml(item.title + ' 이월 날짜') + '">' +
            '<button class="btn btn-sm btn-warn" data-act="lpplancancel" data-id="' + escapeHtml(item.itemId) + '">사유 확인·취소</button>' +
            '<button class="btn btn-sm btn-ghost" data-act="lpplancarryrequest" data-id="' + escapeHtml(item.itemId) + '">이월 요청</button></div>';
        } else {
          controls = '<div class="hint mt8" role="note" aria-label="플래너 현재 상태 관리 안내">현재 상태에서는 편집·취소·이월을 할 수 없습니다.</div>';
        }
        return '<div class="card-sub mt14" style="padding:10px;border:1px solid var(--line);border-radius:10px">' +
          '<div class="between"><strong>' + escapeHtml(item.title) + '</strong><span class="pill">' + escapeHtml(lp.LABELS.planner[item.status] || item.status) + '</span></div>' +
          controls +
          (item.status === 'canceled' && item.cancelReason ? '<div class="hint">취소 사유: ' + escapeHtml(item.cancelReason) + '</div>' : '') + '</div>';
      }).join('') +
      (workload.warnings.length ? '<div class="hint">' + workload.warnings.map(function (warning) { return escapeHtml(warning.message); }).join('<br>') + '</div>' : '') + '</div>';

    html += '<div class="card"><div class="card-title">시험대비 캠페인</div><div class="row"><select class="in" id="lpCampaignType" aria-label="시험대비 유형">' +
      campaigns.map(function (campaign) { return option(campaign.value, campaign.label, false); }).join('') +
      '</select><input class="in" id="lpCampaignDate" type="date" value="' + escapeHtml(lp.date.addDays(today, 28)) + '" aria-label="시험일">' +
      '<input class="in" id="lpCampaignTitle" placeholder="대회·시험명" aria-label="대회 또는 시험명"><button class="btn btn-primary" data-act="lpcampaign">초안 추가</button></div>' +
      state.prepCampaigns.map(function (campaign) {
        var initial = ['draft','consent_pending','review_pending','planned'].indexOf(campaign.status) >= 0;
        var consentControl = campaign.academicStage === 'elementary' ? '<label class="small">동의 증빙 참조<input class="in" data-lp-consent-ref="' + escapeHtml(campaign.campaignId) + '" value="' + escapeHtml(campaign.consentEvidenceRef || '') + '" placeholder="보호자 동의서·상담 기록 참조" aria-label="' + escapeHtml(campaign.title + ' 동의 증빙 참조') + '"></label>' : '';
        var activationLabel = campaign.academicStage === 'elementary' ? '동의 확인·활성화' : '활성화';
        var nextStatus = nextCampaignStatus(campaign.status);
        var latestResult = campaign.latestResult;
        var resultSummary = latestResult
          ? '<div class="hint">최근 결과: ' + escapeHtml(latestResult.summary) +
            (latestResult.score === null || latestResult.score === undefined ? '' : escapeHtml(' · ' + latestResult.score + '/' + latestResult.maxScore)) + '</div>'
          : '';
        var action = '';
        if (campaign.activationBlockedReason) {
          action = '<span class="pill warn">초등 학교시험 비활성</span>';
        } else if (initial) {
          action = '<span class="row">' + consentControl + '<button class="btn btn-sm btn-ghost" data-act="lpactivate" data-id="' + escapeHtml(campaign.campaignId) + '">' + activationLabel + '</button></span>';
        } else if (nextStatus) {
          var resultInputs = nextStatus === 'result_review'
            ? '<input class="in" data-lp-campaign-result="' + escapeHtml(campaign.campaignId) + '" placeholder="결과 요약" aria-label="' + escapeHtml(campaign.title + ' 결과 요약') + '">' +
              '<input class="in" type="number" min="0" step="0.01" data-lp-campaign-score="' + escapeHtml(campaign.campaignId) + '" placeholder="점수(선택)" aria-label="' + escapeHtml(campaign.title + ' 점수') + '" style="max-width:105px">' +
              '<input class="in" type="number" min="0.01" step="0.01" data-lp-campaign-max="' + escapeHtml(campaign.campaignId) + '" placeholder="만점(선택)" aria-label="' + escapeHtml(campaign.title + ' 만점') + '" style="max-width:105px">'
            : '';
          action = '<span class="row"><input class="in" data-lp-campaign-evidence="' + escapeHtml(campaign.campaignId) + '" placeholder="단계 확인 근거" aria-label="' + escapeHtml(campaign.title + ' 단계 확인 근거') + '">' +
            resultInputs + '<button class="btn btn-sm btn-ghost" data-act="lpcampaignnext" data-id="' + escapeHtml(campaign.campaignId) + '" data-next="' + escapeHtml(nextStatus) + '">' +
            escapeHtml(nextCampaignLabel(campaign.status)) + '</button></span>';
        }
        return '<div class="small mt14"><div class="between"><span><strong>' + escapeHtml(campaign.title) + '</strong> · ' + escapeHtml(campaign.examDate) +
          ' · ' + escapeHtml(lp.LABELS.campaign[campaign.status] || campaign.status) + '</span>' + action + '</div>' + resultSummary + '</div>';
      }).join('') + '</div>';

    html += '<div class="card"><div class="card-title">교재 오답 → 메타수학 쌍둥이</div>' +
      '<div class="row"><input class="in" id="lpWrongBook" placeholder="교재 ID" aria-label="오답 교재 ID"><input class="in" id="lpWrongPage" placeholder="쪽" aria-label="오답 교재 쪽">' +
      '<input class="in" id="lpWrongNo" placeholder="문항" aria-label="오답 문항 번호"><input class="in" id="lpWrongSkill" placeholder="단원/기술 코드" aria-label="오답 단원 또는 기술 코드">' +
      '<button class="btn btn-primary" data-act="lpwrong">오답 등록</button></div>' +
      '<div class="hint">문제 원문은 저장하지 않습니다. 교재·쪽·문항 참조만 보관하고 실제 쌍둥이 문제는 메타수학에서 생성합니다.</div>' +
      state.remediationCases.filter(function (item) { return item.status !== 'mastered' && item.status !== 'closed'; }).map(function (item) {
        var needsResultCounts = item.status === 'submitted' || item.status === 'result_waiting';
        var attempts = Array.isArray(item.attempts) ? item.attempts : [];
        var lastAttempt = attempts.length ? attempts[attempts.length - 1] : null;
        var resultSummary = item.status === 'verification_waiting' && lastAttempt
          ? '<span class="pill">최근 결과 ' + escapeHtml(lastAttempt.correctCount + '/' + lastAttempt.totalCount) + '</span>'
          : '';
        var resultInputs = needsResultCounts
          ? '<input class="in" type="number" min="0" step="1" data-lp-wrong-correct="' + escapeHtml(item.caseId) + '" placeholder="정답 수" aria-label="' + escapeHtml(item.textbookId + ' ' + item.problemNo + '번 쌍둥이 문제 정답 수') + '" style="max-width:92px">' +
            '<input class="in" type="number" min="1" step="1" data-lp-wrong-total="' + escapeHtml(item.caseId) + '" placeholder="전체 수" aria-label="' + escapeHtml(item.textbookId + ' ' + item.problemNo + '번 쌍둥이 문제 전체 수') + '" style="max-width:92px">'
          : '';
        return '<div class="between small mt8"><span>' + escapeHtml(item.textbookId + ' ' + item.page + '쪽 ' + item.problemNo + '번 · ' + (lp.LABELS.remediation[item.status] || item.status)) + '</span>' +
          '<span class="row">' + resultSummary + '<input class="in" data-lp-wrong-ref="' + escapeHtml(item.caseId) + '" placeholder="문제세트/배정/결과 참조" aria-label="' + escapeHtml(item.textbookId + ' ' + item.problemNo + '번 외부 참조') + '" style="max-width:190px">' + resultInputs +
          (item.status === 'verification_waiting' ? '<select class="in" data-lp-wrong-result="' + escapeHtml(item.caseId) + '" aria-label="' + escapeHtml(item.textbookId + ' ' + item.problemNo + '번 숙달 판정') + '"><option value="retry">재학습</option><option value="mastered">숙달</option></select>' : '') +
          '<button class="btn btn-sm btn-ghost" data-act="lpwrongnext" data-id="' + escapeHtml(item.caseId) + '">' + escapeHtml(nextWrongLabel(item.status)) + '</button></span></div>';
      }).join('') + '</div>';
    return html;
  }

  return Object.freeze({
    createInitialState: createInitialState,
    normalizeState: normalizeState,
    applyCompletionClaims: applyCompletionClaims,
    addStandardSchedules: addStandardSchedules,
    applyCommand: applyCommand,
    renderManagementControls: renderManagementControls,
    nextCampaignStatus: nextCampaignStatus,
    nextCampaignLabel: nextCampaignLabel,
    nextWrongLabel: nextWrongLabel
  });
});
