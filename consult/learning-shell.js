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
      }), { fromDate: fromDate, toDate: toDate });
    }
    if (optionsSafe.metaMath !== false) {
      state = lp.addAssessmentSchedule(state, lp.createMetaMathSchedule({
        studentCode: studentCode,
        anchorDate: fromDate,
        kind: "weekly",
        weekday: Number(optionsSafe.weekday) || 5
      }), { fromDate: fromDate, toDate: toDate });
      state = lp.addAssessmentSchedule(state, lp.createMetaMathSchedule({
        studentCode: studentCode,
        anchorDate: fromDate,
        kind: "month_end"
      }), { fromDate: fromDate, toDate: toDate });
    }
    return state;
  }

  function activateCampaign(stateInput, campaignId, approval, today) {
    var input = approval || {};
    var state = lp.activatePrepCampaign(stateInput, campaignId, {
      approvedBy: text(input.approvedBy),
      consentEvidenceRef: text(input.consentEvidenceRef),
      consentApprovedBy: text(input.consentApprovedBy),
      consentApprovedAt: text(input.consentApprovedAt)
    });
    var campaign = state.prepCampaigns.find(function (item) { return item.campaignId === campaignId; });
    lp.campaignMilestonesToPlannerItems(campaign, { today: today }).forEach(function (item) {
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
        correctCount: Number(meta.correctCount) || 0,
        totalCount: Number(meta.totalCount) || 0,
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
      state.student = lp.createStudentProfile({
        studentCode: state.student.studentCode,
        displayName: state.student.displayName,
        academicStage: cmd.academicStage,
        grade: Number(cmd.grade),
        timeZone: "Asia/Seoul"
      });
      state.settings.schoolRegularExamEnabled = state.student.academicStage !== "elementary";
      return state;
    }
    if (cmd.type === "program_upsert") {
      return lp.upsertStudentProgramState(state, {
        studentCode: state.student.studentCode,
        providerId: cmd.providerId,
        status: cmd.status,
        accountIdRef: cmd.accountIdRef,
        assignedCount: Number(cmd.assignedCount) || 0,
        completedCount: Number(cmd.completedCount) || 0,
        lastCheckedAt: cmd.lastCheckedAt || new Date().toISOString()
      });
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
        verificationRequired: true
      });
    }
    if (cmd.type === "schedules_generate") {
      return addStandardSchedules(state, cmd);
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
    var providers = Object.keys(lp.DEFAULT_PROVIDERS);
    var campaigns = state.student.academicStage === "elementary"
      ? lp.getElementaryCampaignOptions()
      : Object.keys(lp.CAMPAIGN_TYPES).map(function (key) { return { value: key, label: lp.CAMPAIGN_TYPES[key].label }; });
    var pendingItems = state.plannerItems.filter(function (item) { return item.status === "verification_waiting"; });
    var pending = pendingItems.length;
    var workload = lp.analyzeWorkload({ student: state.student, anchorDate: today, campaigns: state.prepCampaigns, items: state.plannerItems });

    var html = '<div class="card"><div class="card-title">통합 학습 설정</div>' +
      '<div class="card-sub mb14">기존 앱 안에서 온라인 프로그램·플래너·평가·시험대비·오답 재학습을 학생별로 관리합니다.</div>' +
      '<div class="row"><select class="in" id="lpStage">' +
        option('elementary', '초등', state.student.academicStage === 'elementary') +
        option('middle', '중등', state.student.academicStage === 'middle') +
        option('high', '고등', state.student.academicStage === 'high') +
      '</select><input class="in" id="lpGrade" type="number" min="1" max="12" value="' + escapeHtml(state.student.grade) + '" placeholder="학년">' +
      '<button class="btn btn-ghost" data-act="lpprofile">학년 단계 저장</button></div>' +
      (state.student.academicStage === 'elementary'
        ? '<div class="hint">초등은 학교 정기시험이 기본 비활성화됩니다. 경시·KMT·NELT·영재원·입학·레벨테스트만 선택 연결합니다.</div>'
        : '<div class="hint">중·고등은 학교 정기시험 캠페인도 선택할 수 있습니다.</div>') + '</div>';

    html += '<div class="card"><div class="between mb8"><div class="card-title">정기 평가 일정</div>' +
      '<span class="pill">NELT 3개월 · 메타수학 주간/월말</span></div>' +
      '<div class="row"><input class="in" id="lpScheduleFrom" type="date" value="' + escapeHtml(today) + '">' +
      '<select class="in" id="lpWeekday">' + [1,2,3,4,5,6].map(function (day) {
        return option(day, ['','월','화','수','목','금','토'][day] + '요일', day === 5);
      }).join('') + '</select><button class="btn btn-primary" data-act="lpschedule">1년 일정 생성</button></div>' +
      '<div class="hint">같은 회차는 결정적 ID로 중복 생성되지 않습니다. 결과는 사람 확인 전 완료 처리되지 않습니다.</div></div>';

    html += '<div class="card"><div class="card-title">온라인 프로그램 등록·점검</div>' +
      '<div class="row"><select class="in" id="lpProvider">' + providers.map(function (providerId) {
        return option(providerId, lp.DEFAULT_PROVIDERS[providerId].label, false);
      }).join('') + '</select><select class="in" id="lpProgramStatus">' +
        option('active', '사용중', true) + option('partial', '부분완료', false) +
        option('incomplete', '미완료', false) + option('check_needed', '확인필요', false) +
      '</select></div><div class="row"><input class="in" id="lpAccountRef" placeholder="계정 참조 ID (비밀번호 금지)">' +
      '<input class="in" id="lpAssigned" type="number" min="0" placeholder="배정 수">' +
      '<input class="in" id="lpCompleted" type="number" min="0" placeholder="수행 수">' +
      '<button class="btn btn-primary" data-act="lpprogram">저장</button></div></div>';

    html += '<div class="card"><div class="card-title">프로그램 결과 가져오기</div>' +
      '<div class="card-sub mb8">CSV 또는 JSON을 먼저 미리보기하고, 차단 사유를 확인한 뒤 사람이 승인한 행만 반영합니다.</div>' +
      '<div class="row"><select class="in" id="lpImportProvider">' + ['studyforce','classcard','metamath','nelt'].map(function (providerId) {
        return option(providerId, lp.DEFAULT_PROVIDERS[providerId].label, false);
      }).join('') + '</select><button class="btn btn-ghost" data-act="lpimportpreview">미리보기</button></div>' +
      '<textarea class="in mt8" id="lpImportText" rows="5" placeholder="student_code,check_date,status,current_unit&#10;' + escapeHtml(state.student.studentCode) + ',2026-08-03,부분완료,12회"></textarea>' +
      '<div class="hint">비밀번호·토큰·쿠키 열이 있으면 해당 행은 차단되고 해시에도 포함되지 않습니다.</div></div>';

    html += '<div class="card"><div class="between mb8"><div class="card-title">플래너 확인</div><span class="pill ' + (pending ? 'warn' : '') + '">확인대기 ' + pending + '건</span></div>' +
      '<div class="row"><input class="in" id="lpPlanDate" type="date" value="' + escapeHtml(today) + '">' +
      '<input class="in" id="lpPlanTitle" placeholder="학습 과제"><input class="in" id="lpPlanMinutes" type="number" min="0" placeholder="분">' +
      '<select class="in" id="lpPlanProvider"><option value="">학원 과제</option>' + providers.map(function (providerId) {
        return option(providerId, lp.DEFAULT_PROVIDERS[providerId].label, false);
      }).join('') + '</select><button class="btn btn-primary" data-act="lpplan">추가</button></div>' +
      pendingItems.map(function (item) { return '<div class="small mt14"><div class="between"><span><strong>' + escapeHtml(item.title) + '</strong> · ' + escapeHtml(item.date) + '</span><span class="pill warn">검토 필요</span></div><div class="row mt8"><label class="small">완료 근거 참조<input class="in" data-lp-verify-evidence="' + escapeHtml(item.itemId) + '" placeholder="리포트·제출물·상담 기록 참조" aria-label="' + escapeHtml(item.title + ' 완료 검증 근거 참조') + '"></label><button class="btn btn-sm btn-primary" data-act="lpverifyitem" data-decision="approve" data-id="' + escapeHtml(item.itemId) + '">완료 승인</button><button class="btn btn-sm btn-warn" data-act="lpverifyitem" data-decision="reject" data-id="' + escapeHtml(item.itemId) + '">반려</button></div></div>'; }).join('') +
      (workload.warnings.length ? '<div class="hint">' + workload.warnings.map(function (warning) { return escapeHtml(warning.message); }).join('<br>') + '</div>' : '') + '</div>';

    html += '<div class="card"><div class="card-title">시험대비 캠페인</div><div class="row"><select class="in" id="lpCampaignType">' +
      campaigns.map(function (campaign) { return option(campaign.value, campaign.label, false); }).join('') +
      '</select><input class="in" id="lpCampaignDate" type="date" value="' + escapeHtml(lp.date.addDays(today, 28)) + '">' +
      '<input class="in" id="lpCampaignTitle" placeholder="대회·시험명"><button class="btn btn-primary" data-act="lpcampaign">초안 추가</button></div>' +
      state.prepCampaigns.filter(function (campaign) { return ['draft','consent_pending','review_pending','planned'].indexOf(campaign.status) >= 0; }).map(function (campaign) {
        var consentControl = campaign.academicStage === 'elementary' ? '<label class="small">동의 증빙 참조<input class="in" data-lp-consent-ref="' + escapeHtml(campaign.campaignId) + '" value="' + escapeHtml(campaign.consentEvidenceRef || '') + '" placeholder="보호자 동의서·상담 기록 참조" aria-label="' + escapeHtml(campaign.title + ' 동의 증빙 참조') + '"></label>' : '';
        var activationLabel = campaign.academicStage === 'elementary' ? '동의 확인·활성화' : '활성화';
        return '<div class="between small mt8"><span>' + escapeHtml(campaign.title + ' · ' + campaign.examDate) + '</span>' +
          (campaign.activationBlockedReason
            ? '<span class="pill warn">초등 학교시험 비활성</span>'
            : '<span class="row">' + consentControl + '<button class="btn btn-sm btn-ghost" data-act="lpactivate" data-id="' + escapeHtml(campaign.campaignId) + '">' + activationLabel + '</button></span>') + '</div>';
      }).join('') + '</div>';

    html += '<div class="card"><div class="card-title">교재 오답 → 메타수학 쌍둥이</div>' +
      '<div class="row"><input class="in" id="lpWrongBook" placeholder="교재 ID"><input class="in" id="lpWrongPage" placeholder="쪽">' +
      '<input class="in" id="lpWrongNo" placeholder="문항"><input class="in" id="lpWrongSkill" placeholder="단원/기술 코드">' +
      '<button class="btn btn-primary" data-act="lpwrong">오답 등록</button></div>' +
      '<div class="hint">문제 원문은 저장하지 않습니다. 교재·쪽·문항 참조만 보관하고 실제 쌍둥이 문제는 메타수학에서 생성합니다.</div>' +
      state.remediationCases.filter(function (item) { return item.status !== 'mastered' && item.status !== 'closed'; }).map(function (item) {
        return '<div class="between small mt8"><span>' + escapeHtml(item.textbookId + ' ' + item.page + '쪽 ' + item.problemNo + '번 · ' + (lp.LABELS.remediation[item.status] || item.status)) + '</span>' +
          '<span class="row"><input class="in" data-lp-wrong-ref="' + escapeHtml(item.caseId) + '" placeholder="문제세트/배정/결과 참조" style="max-width:190px">' +
          (item.status === 'verification_waiting' ? '<select class="in" data-lp-wrong-result="' + escapeHtml(item.caseId) + '"><option value="retry">재학습</option><option value="mastered">숙달</option></select>' : '') +
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
    nextWrongLabel: nextWrongLabel
  });
});
