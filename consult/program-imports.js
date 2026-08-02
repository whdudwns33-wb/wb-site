(function (root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WBProgramImports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MODULE_VERSION = '1.1.0';
  var WORKFLOW = Object.freeze({
    PREVIEW: 'preview',
    VALIDATED: 'validated',
    CONFIRM_CANDIDATE: 'confirm_candidate',
    APPROVED: 'approved'
  });

  var OPAQUE_ACCOUNT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9:._\/#-]{0,127}$/;

  var COMMON_FIELDS = Object.freeze({
    student_code: ['student_code', 'student code', '학생코드', '학생 코드'],
    external_student_id: [
      'external_student_id', 'external student id', 'external_id', 'external id',
      '외부학생id', '외부 학생 id', '회원번호', '학습자번호'
    ],
    account_id_ref: [
      'account_id_ref', 'account id ref', 'account_id', 'account id', 'login_id',
      '로그인id', '계정id', '계정 아이디', '아이디'
    ],
    check_date: [
      'check_date', 'check date', 'source_date', 'source date', '기준일',
      '확인일', '학습일', '응시일', '날짜'
    ],
    reported_status: [
      'reported_status', 'reported status', 'completion_status', 'completion status',
      'status', '상태', '수행상태', '완료상태'
    ],
    external_record_id: [
      'external_record_id', 'external record id', 'record_id', 'record id',
      'result_id', 'result id', '결과id', '기록id'
    ],
    assignment_ref: [
      'assignment_ref', 'assignment ref', 'assignment_id', 'assignment id',
      '과제id', '과제번호', '배정id'
    ],
    current_unit: [
      'current_unit', 'current unit', 'unit', '단원', '현재단원', '현재 단원',
      'day', '회차'
    ],
    progress_pct: [
      'progress_pct', 'progress percent', 'progress', '진도율', '수행률', '완료율'
    ],
    score: ['score', '점수', '획득점수'],
    target_score: ['target_score', 'target score', '목표점수', '기준점수'],
    range: ['range', '범위', '학습범위'],
    memo: ['memo', 'note', '메모', '비고'],
    evidence_ref: [
      'evidence_ref', 'evidence ref', 'source_ref', 'source ref', '근거참조', '증빙참조'
    ]
  });

  var FIELD_TYPES = Object.freeze({
    progress_pct: 'percent',
    score: 'number',
    target_score: 'number',
    missed_count: 'nonnegative_integer',
    weekly_sessions: 'nonnegative_integer',
    wrong_answer_count: 'nonnegative_integer',
    oral_test_required: 'boolean',
    carryover_flag: 'boolean'
  });

  var FORBIDDEN_CREDENTIAL_KEYS = Object.freeze([
    'password', 'passwd', 'pwd', 'passcode', 'pin', '비밀번호', '비번',
    'secret', 'clientsecret', 'apisecret', 'apikey', 'apitoken',
    'accesstoken', 'refreshtoken', 'sessiontoken', 'sessioncookie',
    'authcookie', 'authtoken', 'authorization', 'bearer', 'bearertoken',
    'cookie', 'credential', 'credentials', 'privatekey', '암호', '인증토큰'
  ]);

  var STATUS_MAP = Object.freeze({
    '대기': '대기', pending: '대기', waiting: '대기',
    '처리중': '처리중', processing: '처리중',
    '사용중': '사용중', active: '사용중', inuse: '사용중',
    '준비중': '준비중', preparing: '준비중', ready: '준비중',
    '미사용': '미사용', inactive: '미사용', unused: '미사용',
    '완료': '완료', complete: '완료', completed: '완료', done: '완료',
    '부분완료': '부분완료', partial: '부분완료', partiallycompleted: '부분완료',
    '미완료': '미완료', incomplete: '미완료', notcompleted: '미완료',
    '미확인': '미확인', unverified: '미확인', unknown: '미확인',
    '확인필요': '확인필요', needsreview: '확인필요', checkneeded: '확인필요',
    '보류': '보류', hold: '보류', onhold: '보류',
    '오류': '오류', error: '오류', failed: '오류',
    '점수미달': '점수미달', belowscore: '점수미달', belowtarget: '점수미달',
    '오답복습필요': '오답복습필요', reviewrequired: '오답복습필요',
    '구두테스트필요': '구두테스트필요', oraltestrequired: '구두테스트필요'
  });

  var CARRYOVER_STATUSES = Object.freeze([
    '부분완료', '미완료', '점수미달', '오답복습필요', '구두테스트필요'
  ]);

  function ProgramImportError(code, message, details) {
    this.name = 'ProgramImportError';
    this.code = code;
    this.message = message || code;
    this.details = details || null;
    if (Error.captureStackTrace) Error.captureStackTrace(this, ProgramImportError);
  }
  ProgramImportError.prototype = Object.create(Error.prototype);
  ProgramImportError.prototype.constructor = ProgramImportError;

  function isPlainObject(value) {
    if (!value || Object.prototype.toString.call(value) !== '[object Object]') return false;
    var proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function cloneJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function text(value) {
    return value == null ? '' : String(value).trim();
  }

  function normalizeKey(value) {
    var out = text(value);
    if (out.normalize) out = out.normalize('NFKC');
    return out.toLowerCase().replace(/[\s_\-./()[\]{}:]+/g, '');
  }

  function isForbiddenCredentialKey(value) {
    var normalized = normalizeKey(value);
    if (FORBIDDEN_CREDENTIAL_KEYS.indexOf(normalized) >= 0) return true;
    return /(?:password|passwd|passcode|clientsecret|apisecret|privatekey|(?:api|access|refresh|session|auth|bearer)(?:key|token|cookie|secret)|authorization|credential|비밀번호|비번|암호|인증토큰)/i.test(normalized);
  }

  function isOpaqueAccountRef(value) {
    var candidate = text(value);
    return !candidate || OPAQUE_ACCOUNT_REF_RE.test(candidate);
  }

  function normalizeProviderId(value) {
    var id = text(value).toLowerCase().replace(/[\s_]+/g, '-');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new ProgramImportError('INVALID_PROVIDER_ID', '공급자 ID는 영문 소문자, 숫자, 하이픈만 사용할 수 있습니다.');
    }
    return id;
  }

  function issue(code, severity, rowNumber, field, message) {
    return {
      code: code,
      severity: severity || 'error',
      blocking: (severity || 'error') === 'error',
      row_number: rowNumber == null ? null : rowNumber,
      field: field || null,
      message: message || code
    };
  }

  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ':' + stableStringify(value[key]);
    }).join(',') + '}';
  }

  function bytesToHex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), function (b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
  }

  function utf8Bytes(value) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value);
    var encoded = unescape(encodeURIComponent(value));
    var bytes = new Uint8Array(encoded.length);
    for (var i = 0; i < encoded.length; i += 1) bytes[i] = encoded.charCodeAt(i);
    return bytes;
  }

  async function sha256Hex(value) {
    var input = typeof value === 'string' ? value : stableStringify(value);
    var cryptoObject = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (cryptoObject && cryptoObject.subtle && cryptoObject.subtle.digest) {
      return bytesToHex(await cryptoObject.subtle.digest('SHA-256', utf8Bytes(input)));
    }
    if (typeof require === 'function') {
      return require('node:crypto').createHash('sha256').update(input, 'utf8').digest('hex');
    }
    throw new ProgramImportError('CRYPTO_UNAVAILABLE', 'SHA-256을 계산할 수 없는 실행 환경입니다.');
  }

  function mergeFieldAliases(providerFields) {
    var merged = {};
    Object.keys(COMMON_FIELDS).forEach(function (key) {
      merged[key] = COMMON_FIELDS[key].slice();
    });
    Object.keys(providerFields || {}).forEach(function (key) {
      var values = Array.isArray(providerFields[key]) ? providerFields[key] : [providerFields[key]];
      merged[key] = (merged[key] || []).concat(values);
    });
    Object.keys(merged).forEach(function (key) {
      var seen = Object.create(null);
      merged[key] = merged[key].map(text).filter(Boolean).filter(function (alias) {
        var normalized = normalizeKey(alias);
        if (seen[normalized]) return false;
        seen[normalized] = true;
        return true;
      });
    });
    return merged;
  }

  function normalizeDefinition(definition) {
    if (!isPlainObject(definition)) {
      throw new ProgramImportError('INVALID_PROVIDER', '공급자 정의가 객체가 아닙니다.');
    }
    var id = normalizeProviderId(definition.id);
    var fields = mergeFieldAliases(definition.fields || {});
    var types = Object.assign({}, FIELD_TYPES, definition.types || {});
    var aliases = [id, definition.label].concat(definition.aliases || []).map(text).filter(Boolean);
    var required = (definition.required || ['check_date']).map(text).filter(Boolean);
    var requiredAny = (definition.requiredAny || [['reported_status', 'current_unit']]).map(function (group) {
      return (Array.isArray(group) ? group : [group]).map(text).filter(Boolean);
    }).filter(function (group) { return group.length; });
    return {
      id: id,
      label: text(definition.label) || id,
      aliases: aliases,
      capabilities: Object.assign({}, definition.capabilities || {}),
      fields: fields,
      types: types,
      required: required,
      requiredAny: requiredAny,
      identityFields: (definition.identityFields || [
        'external_record_id', 'assignment_ref', 'set_name', 'assessment_type', 'current_unit'
      ]).map(text).filter(Boolean),
      metadata: cloneJson(definition.metadata || {})
    };
  }

  function publicDefinition(definition) {
    return cloneJson({
      id: definition.id,
      label: definition.label,
      aliases: definition.aliases,
      capabilities: definition.capabilities,
      fields: definition.fields,
      types: definition.types,
      required: definition.required,
      requiredAny: definition.requiredAny,
      identityFields: definition.identityFields,
      metadata: definition.metadata
    });
  }

  function ProviderRegistry(definitions) {
    this._providers = new Map();
    this._aliases = new Map();
    (definitions || []).forEach(this.register.bind(this));
  }

  ProviderRegistry.prototype.register = function (definition) {
    var normalized = normalizeDefinition(definition);
    if (this._providers.has(normalized.id)) {
      throw new ProgramImportError('PROVIDER_EXISTS', '이미 등록된 공급자 ID입니다.');
    }
    var self = this;
    normalized.aliases.forEach(function (alias) {
      var key = normalizeKey(alias);
      var existing = self._aliases.get(key);
      if (existing && existing !== normalized.id) {
        throw new ProgramImportError('PROVIDER_ALIAS_CONFLICT', '다른 공급자가 사용하는 별칭입니다.');
      }
    });
    this._providers.set(normalized.id, normalized);
    normalized.aliases.forEach(function (alias) {
      self._aliases.set(normalizeKey(alias), normalized.id);
    });
    return this;
  };

  ProviderRegistry.prototype.resolve = function (idOrAlias) {
    var id = this._aliases.get(normalizeKey(idOrAlias));
    if (!id || !this._providers.has(id)) return null;
    return this._providers.get(id);
  };

  ProviderRegistry.prototype.get = function (idOrAlias) {
    var found = this.resolve(idOrAlias);
    return found ? publicDefinition(found) : null;
  };

  ProviderRegistry.prototype.list = function () {
    return Array.from(this._providers.values()).map(publicDefinition);
  };

  function defaultProviderDefinitions() {
    return [
      {
        id: 'studyforce',
        label: '스터디포스',
        aliases: ['StudyForce', 'study force', '스터디 포스'],
        capabilities: {
          account_reference: true,
          progress: true,
          weekly_activity: true,
          carryover_candidate: true
        },
        fields: {
          current_unit: ['훈련회차', '훈련 회차'],
          service_type: ['service_type', '서비스구분', '서비스 구분'],
          weekly_sessions: ['weekly_sessions', '주간학습횟수', '주간 학습 횟수'],
          missed_count: ['missed_count', '미수행회차', '미수행 회차'],
          carryover_flag: ['carryover_flag', '이월여부', '이월 여부'],
          subscription_type: ['subscription_type', '구독수업구분', '구독 수업 구분']
        },
        requiredAny: [['reported_status', 'current_unit', 'progress_pct', 'weekly_sessions']]
      },
      {
        id: 'classcard',
        label: '클래스카드',
        aliases: ['ClassCard', 'class card', '클래스 카드'],
        capabilities: {
          account_reference: true,
          class_assignment: true,
          sets: true,
          score: true,
          wrong_answers: true,
          review: true,
          oral_test: true,
          carryover_candidate: true
        },
        fields: {
          class_id: ['class_id', 'class id', '클래스id', '반id'],
          set_name: ['set_name', 'set name', 'classcard_set', '세트명', '오늘세트', '오늘 세트'],
          test_status: ['test_status', 'test status', '테스트상태', '테스트 상태'],
          wrong_answer_count: ['wrong_answer_count', 'wrong answer count', '오답수', '오답 수'],
          review_status: ['review_status', 'review status', '오답복습상태', '복습상태'],
          oral_test_required: ['oral_test_required', 'oral test required', '구두테스트필요', '구두테스트'],
          carryover_flag: ['carryover_flag', '이월여부', '이월 여부']
        },
        requiredAny: [['reported_status', 'set_name', 'test_status', 'score']],
        identityFields: ['external_record_id', 'assignment_ref', 'class_id', 'set_name', 'current_unit']
      },
      {
        id: 'metamath',
        label: '메타수학',
        aliases: ['MetaMath', 'meta math', '메타 수학'],
        capabilities: {
          account_reference: true,
          assessment: true,
          level: true,
          weak_units: true,
          wrong_answers: true,
          supplementary_sheet: true,
          carryover_candidate: true
        },
        fields: {
          assessment_type: ['assessment_type', 'assessment type', '진단종류', '진단 종류', 'kmt'],
          level: ['level', '단계', '레벨'],
          weak_unit: ['weak_unit', 'weak unit', '약점단원', '약점 단원'],
          wrong_answer_status: ['wrong_answer_status', 'wrong answer status', '오답상태', '오답 상태'],
          supplementary_sheet_ref: [
            'supplementary_sheet_ref', 'supplementary sheet ref', '보충문제지', '보충 문제지'
          ]
        },
        requiredAny: [['reported_status', 'assessment_type', 'weak_unit', 'wrong_answer_status', 'level']],
        identityFields: ['external_record_id', 'assessment_type', 'current_unit', 'level']
      },
      {
        id: 'nelt',
        label: '넬트',
        aliases: ['NELT', 'nelt assessment'],
        capabilities: {
          assessment: true,
          level: true,
          trend_candidate: true
        },
        fields: {
          assessment_type: ['assessment_type', 'assessment type', '평가종류', '평가 종류'],
          level: ['level', '단계', '레벨'],
          level_label: ['level_label', 'level label', '단계표시', '표시명']
        },
        requiredAny: [['level', 'level_label', 'reported_status']],
        identityFields: ['external_record_id', 'assessment_type', 'level']
      }
    ];
  }

  function createDefaultRegistry(extraDefinitions) {
    return new ProviderRegistry(defaultProviderDefinitions().concat(extraDefinitions || []));
  }

  function countDelimiter(line, delimiter) {
    var quoted = false;
    var count = 0;
    for (var i = 0; i < line.length; i += 1) {
      if (line[i] === '"') {
        if (quoted && line[i + 1] === '"') i += 1;
        else quoted = !quoted;
      } else if (!quoted && line[i] === delimiter) count += 1;
    }
    return count;
  }

  function detectDelimiter(input) {
    var line = String(input || '').replace(/^\uFEFF/, '').split(/\r?\n/).find(function (part) {
      return part.trim();
    }) || '';
    var choices = [',', '\t', ';'];
    choices.sort(function (a, b) { return countDelimiter(line, b) - countDelimiter(line, a); });
    return choices[0];
  }

  function parseCsv(input, options) {
    var source = String(input == null ? '' : input).replace(/^\uFEFF/, '');
    if (!source.trim()) throw new ProgramImportError('EMPTY_SOURCE', 'CSV 내용이 비어 있습니다.');
    var delimiter = (options && options.delimiter) || detectDelimiter(source);
    var matrix = [];
    var row = [];
    var cell = '';
    var quoted = false;

    for (var i = 0; i < source.length; i += 1) {
      var ch = source[i];
      if (quoted) {
        if (ch === '"' && source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"' && cell === '') quoted = true;
      else if (ch === delimiter) {
        row.push(cell);
        cell = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && source[i + 1] === '\n') i += 1;
        row.push(cell);
        if (row.some(function (value) { return String(value).trim(); })) matrix.push(row);
        row = [];
        cell = '';
      } else cell += ch;
    }
    if (quoted) throw new ProgramImportError('INVALID_CSV', '닫히지 않은 따옴표가 있습니다.');
    row.push(cell);
    if (row.some(function (value) { return String(value).trim(); })) matrix.push(row);
    if (matrix.length < 2) throw new ProgramImportError('NO_DATA_ROWS', 'CSV에 헤더와 데이터 행이 필요합니다.');

    var headers = matrix.shift().map(text);
    var normalizedHeaders = Object.create(null);
    headers.forEach(function (header) {
      if (!header) throw new ProgramImportError('EMPTY_HEADER', '빈 CSV 헤더가 있습니다.');
      var key = normalizeKey(header);
      if (normalizedHeaders[key]) throw new ProgramImportError('DUPLICATE_HEADER', '중복 CSV 헤더가 있습니다.');
      normalizedHeaders[key] = true;
    });

    return matrix.map(function (values) {
      var out = {};
      headers.forEach(function (header, index) { out[header] = values[index] == null ? '' : values[index]; });
      return out;
    });
  }

  function parseJson(input) {
    var parsed;
    try {
      parsed = typeof input === 'string' ? JSON.parse(input.replace(/^\uFEFF/, '')) : input;
    } catch (error) {
      throw new ProgramImportError('INVALID_JSON', 'JSON 형식을 읽을 수 없습니다.');
    }
    var rows = Array.isArray(parsed) ? parsed
      : (isPlainObject(parsed) && (parsed.rows || parsed.records || parsed.data));
    if (!Array.isArray(rows) || !rows.length) {
      throw new ProgramImportError('NO_DATA_ROWS', 'JSON에는 비어 있지 않은 rows, records, data 배열이 필요합니다.');
    }
    rows.forEach(function (row) {
      if (!isPlainObject(row)) throw new ProgramImportError('INVALID_JSON_ROW', 'JSON의 각 행은 객체여야 합니다.');
    });
    return rows;
  }

  function inferFormat(input, requested) {
    var format = text(requested || 'auto').toLowerCase();
    if (format === 'csv' || format === 'json') return format;
    if (typeof input !== 'string') return 'json';
    var first = input.replace(/^\uFEFF/, '').trim()[0];
    return first === '[' || first === '{' ? 'json' : 'csv';
  }

  function sanitizeCredentials(value, path, detected) {
    if (Array.isArray(value)) {
      return value.map(function (item, index) {
        return sanitizeCredentials(item, path.concat(String(index)), detected);
      });
    }
    if (!isPlainObject(value)) return value;
    var clean = {};
    Object.keys(value).forEach(function (key) {
      var normalized = normalizeKey(key);
      if (isForbiddenCredentialKey(normalized)) {
        detected.push(path.concat(key).join('.'));
        return;
      }
      clean[key] = sanitizeCredentials(value[key], path.concat(key), detected);
    });
    return clean;
  }

  function indexedValues(record) {
    var index = Object.create(null);
    Object.keys(record).forEach(function (key) {
      var normalized = normalizeKey(key);
      if (!index[normalized]) index[normalized] = [];
      index[normalized].push({ key: key, value: record[key] });
    });
    return index;
  }

  function extractCanonical(record, provider, rowNumber) {
    var index = indexedValues(record);
    var output = {};
    var issues = [];
    Object.keys(provider.fields).forEach(function (canonical) {
      var found = [];
      provider.fields[canonical].forEach(function (alias) {
        var matches = index[normalizeKey(alias)] || [];
        matches.forEach(function (match) {
          if (text(match.value)) found.push(match);
        });
      });
      if (!found.length) return;
      var distinct = [];
      found.forEach(function (match) {
        var normalizedValue = text(match.value);
        if (distinct.indexOf(normalizedValue) < 0) distinct.push(normalizedValue);
      });
      if (distinct.length > 1) {
        issues.push(issue(
          'FIELD_ALIAS_CONFLICT', 'error', rowNumber, canonical,
          '같은 의미의 열에 서로 다른 값이 있습니다.'
        ));
        return;
      }
      output[canonical] = found[0].value;
    });
    return { values: output, issues: issues };
  }

  function normalizeDate(value) {
    var raw = text(value);
    if (!raw) return '';
    var iso = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (!iso) return '';
    var y = Number(iso[1]);
    var m = Number(iso[2]);
    var d = Number(iso[3]);
    var date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return '';
    return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function normalizeNumber(value) {
    if (value === '' || value == null) return null;
    var raw = text(value).replace(/,/g, '').replace(/%$/, '');
    if (!raw) return null;
    var number = Number(raw);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeBoolean(value) {
    if (typeof value === 'boolean') return value;
    var normalized = normalizeKey(value);
    if (['1', 'true', 'yes', 'y', '예', '필요', '있음', 'o'].indexOf(normalized) >= 0) return true;
    if (['0', 'false', 'no', 'n', '아니오', '불필요', '없음', 'x'].indexOf(normalized) >= 0) return false;
    return null;
  }

  function normalizeStatus(value) {
    var raw = text(value);
    if (!raw) return { value: '미확인', known: true, supplied: false };
    var normalized = normalizeKey(raw);
    return {
      value: STATUS_MAP[normalized] || '미확인',
      known: !!STATUS_MAP[normalized],
      supplied: true
    };
  }

  function normalizeValues(extracted, provider, rowNumber) {
    var output = {};
    var issues = [];
    Object.keys(extracted).forEach(function (key) {
      var value = extracted[key];
      var type = provider.types[key] || 'text';
      if (key === 'check_date') {
        var date = normalizeDate(value);
        if (!date && text(value)) {
          issues.push(issue('INVALID_DATE', 'error', rowNumber, key, '날짜는 YYYY-MM-DD 형식이어야 합니다.'));
        }
        output[key] = date;
      } else if (key === 'reported_status') {
        var status = normalizeStatus(value);
        output[key] = status.value;
        if (!status.known) {
          issues.push(issue('UNKNOWN_STATUS', 'warning', rowNumber, key, '알 수 없는 상태를 미확인 후보로 바꿨습니다.'));
        }
      } else if (type === 'number' || type === 'percent' || type === 'nonnegative_integer') {
        var number = normalizeNumber(value);
        if (number === null || (type === 'percent' && (number < 0 || number > 100)) ||
            (type === 'nonnegative_integer' && (number < 0 || Math.floor(number) !== number))) {
          issues.push(issue('INVALID_NUMBER', 'error', rowNumber, key, '숫자 범위 또는 형식이 올바르지 않습니다.'));
        } else output[key] = number;
      } else if (type === 'boolean') {
        var bool = normalizeBoolean(value);
        if (bool === null) {
          issues.push(issue('INVALID_BOOLEAN', 'error', rowNumber, key, '예/아니오 값을 해석할 수 없습니다.'));
        } else output[key] = bool;
      } else output[key] = text(value);
    });
    if (!Object.prototype.hasOwnProperty.call(output, 'reported_status')) output.reported_status = '미확인';
    return { values: output, issues: issues };
  }

  function externalKey(providerId, externalId) {
    return providerId + '|' + normalizeKey(externalId);
  }

  function addExternalMapping(map, providerId, externalId, studentCode) {
    if (!text(externalId) || !text(studentCode)) return;
    var key = externalKey(providerId, externalId);
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(text(studentCode));
  }

  function createStudentResolver(options) {
    var directory = (options && options.studentDirectory) || [];
    var mappings = (options && options.studentMappings) || [];
    var knownCodes = new Set();
    var duplicateCodes = new Set();
    var external = new Map();
    var hasDirectory = directory.length > 0;

    directory.forEach(function (student) {
      if (!student || !text(student.student_code)) return;
      var code = text(student.student_code);
      if (knownCodes.has(code)) duplicateCodes.add(code);
      knownCodes.add(code);
      var ids = student.external_ids || {};
      Object.keys(ids).forEach(function (providerId) {
        var values = Array.isArray(ids[providerId]) ? ids[providerId] : [ids[providerId]];
        values.forEach(function (value) { addExternalMapping(external, providerId, value, code); });
      });
    });

    mappings.forEach(function (mapping) {
      if (!mapping) return;
      addExternalMapping(external, mapping.provider_id || mapping.provider, mapping.external_student_id || mapping.external_id, mapping.student_code);
      if (text(mapping.student_code)) knownCodes.add(text(mapping.student_code));
    });

    return {
      resolve: function (providerId, directCode, externalId, rowNumber) {
        var issues = [];
        var code = text(directCode);
        var mapped = [];
        if (text(externalId)) {
          var set = external.get(externalKey(providerId, externalId));
          if (set) mapped = Array.from(set);
        }
        if (duplicateCodes.has(code)) {
          issues.push(issue('STUDENT_CODE_COLLISION', 'error', rowNumber, 'student_code', '학생 코드가 학생 기준표에서 중복됩니다.'));
        }
        if (mapped.length > 1) {
          issues.push(issue('EXTERNAL_ID_COLLISION', 'error', rowNumber, 'external_student_id', '외부 ID가 여러 학생 코드에 연결됩니다.'));
        }
        if (code && hasDirectory && !knownCodes.has(code)) {
          issues.push(issue('UNKNOWN_STUDENT_CODE', 'error', rowNumber, 'student_code', '학생 기준표에 없는 학생 코드입니다.'));
        }
        if (code && mapped.length === 1 && mapped[0] !== code) {
          issues.push(issue('STUDENT_MAPPING_CONFLICT', 'error', rowNumber, 'student_code', '학생 코드와 외부 ID 매핑이 서로 다릅니다.'));
        }
        if (!code && mapped.length === 1) code = mapped[0];
        if (!code) {
          issues.push(issue('STUDENT_UNMAPPED', 'error', rowNumber, 'student_code', '학생 코드 또는 확정된 외부 ID 매핑이 필요합니다.'));
        }
        return { student_code: code, issues: issues };
      }
    };
  }

  function requiredIssues(values, provider, rowNumber) {
    var issues = [];
    provider.required.forEach(function (field) {
      if (values[field] === '' || values[field] == null) {
        issues.push(issue('REQUIRED_FIELD_MISSING', 'error', rowNumber, field, '필수 필드가 없습니다.'));
      }
    });
    provider.requiredAny.forEach(function (group) {
      var present = group.some(function (field) {
        return values[field] !== '' && values[field] != null;
      });
      if (!present) {
        issues.push(issue('REQUIRED_ANY_MISSING', 'error', rowNumber, group.join('|'), '프로그램 결과를 설명할 필드가 부족합니다.'));
      }
    });
    return issues;
  }

  function identityPayload(provider, values) {
    var identity = {
      provider_id: provider.id,
      student_code: values.student_code || '',
      external_student_id: values.external_student_id || '',
      check_date: values.check_date || ''
    };
    var foundSpecific = false;
    provider.identityFields.forEach(function (field) {
      if (values[field] !== '' && values[field] != null) {
        identity[field] = values[field];
        foundSpecific = true;
      }
    });
    if (!foundSpecific) identity.record_scope = 'daily-program-state';
    return identity;
  }

  function candidatePayload(provider, values) {
    var data = {};
    Object.keys(provider.fields).forEach(function (field) {
      if (['student_code', 'external_student_id', 'account_id_ref', 'check_date', 'reported_status'].indexOf(field) >= 0) return;
      if (values[field] !== '' && values[field] != null) data[field] = values[field];
    });
    return data;
  }

  async function previewImport(options) {
    options = options || {};
    var registry = options.registry || createDefaultRegistry();
    if (!(registry instanceof ProviderRegistry)) {
      throw new ProgramImportError('INVALID_REGISTRY', 'ProviderRegistry 인스턴스가 필요합니다.');
    }
    var provider = registry.resolve(options.providerId || options.provider);
    if (!provider) throw new ProgramImportError('UNKNOWN_PROVIDER', '등록되지 않은 온라인 프로그램입니다.');
    var format = inferFormat(options.input, options.format);
    var rows = format === 'csv' ? parseCsv(options.input, { delimiter: options.delimiter }) : parseJson(options.input);
    var canonicalHashRows = rows.map(function (row) {
      var ignoredCredentials = [];
      var sanitized = sanitizeCredentials(row, [], ignoredCredentials);
      var extracted = extractCanonical(sanitized, provider, 0);
      var values = normalizeValues(extracted.values, provider, 0).values;
      if (!isOpaqueAccountRef(values.account_id_ref)) values.account_id_ref = '';
      return values;
    });
    var sourceHash = await sha256Hex({
      provider_id: provider.id,
      canonical_rows: canonicalHashRows
    });
    var resolver = createStudentResolver(options);
    var candidates = [];

    for (var index = 0; index < rows.length; index += 1) {
      var rowNumber = index + 2;
      var credentialPaths = [];
      var sanitized = sanitizeCredentials(rows[index], [], credentialPaths);
      var extracted = extractCanonical(sanitized, provider, rowNumber);
      var normalized = normalizeValues(extracted.values, provider, rowNumber);
      var values = normalized.values;
      var rowIssues = extracted.issues.concat(normalized.issues);
      if (credentialPaths.length) {
        rowIssues.push(issue(
          'FORBIDDEN_CREDENTIAL_FIELD', 'error', rowNumber, null,
          '비밀번호·토큰·쿠키 필드는 저장하지 않으며 해당 행을 차단했습니다.'
        ));
      }
      if (!isOpaqueAccountRef(values.account_id_ref)) {
        rowIssues.push(issue(
          'INVALID_ACCOUNT_ID_REF', 'error', rowNumber, 'account_id_ref',
          '계정 참조는 비밀번호가 아닌 128자 이하 영문·숫자 opaque ID만 허용합니다.'
        ));
        values.account_id_ref = '';
      }
      var resolved = resolver.resolve(provider.id, values.student_code, values.external_student_id, rowNumber);
      values.student_code = resolved.student_code;
      rowIssues = rowIssues.concat(resolved.issues, requiredIssues(values, provider, rowNumber));

      var identity = identityPayload(provider, values);
      var idempotencyKey = 'program-import:v1:' + await sha256Hex(identity);
      var payload = candidatePayload(provider, values);
      var payloadHash = await sha256Hex({
        identity: identity,
        reported_status: values.reported_status,
        account_id_ref: values.account_id_ref || '',
        data: payload
      });

      candidates.push({
        row_id: 'row-' + (index + 1),
        row_number: rowNumber,
        provider_id: provider.id,
        provider_label: provider.label,
        student_code: values.student_code || '',
        external_student_id: values.external_student_id || '',
        account_id_ref: values.account_id_ref || '',
        check_date: values.check_date || '',
        candidate_status: values.reported_status || '미확인',
        reported_status: values.reported_status || '미확인',
        confirmed_status: null,
        final_status: null,
        confirmation_state: 'unconfirmed',
        data: payload,
        source: {
          kind: 'manual_' + format,
          format: format,
          source_hash: sourceHash,
          hash_scope: 'canonical_allowed_fields_v1',
          source_ref: text(options.sourceRef),
          source_date: text(options.sourceDate) || values.check_date || ''
        },
        idempotency_key: idempotencyKey,
        payload_hash: payloadHash,
        issues: rowIssues
      });
    }

    var byExternal = new Map();
    candidates.forEach(function (candidate) {
      if (!candidate.external_student_id || !candidate.student_code) return;
      var key = externalKey(candidate.provider_id, candidate.external_student_id);
      if (!byExternal.has(key)) byExternal.set(key, new Set());
      byExternal.get(key).add(candidate.student_code);
    });
    candidates.forEach(function (candidate) {
      if (!candidate.external_student_id) return;
      var set = byExternal.get(externalKey(candidate.provider_id, candidate.external_student_id));
      if (set && set.size > 1) {
        candidate.issues.push(issue(
          'BATCH_EXTERNAL_ID_CONFLICT', 'error', candidate.row_number, 'external_student_id',
          '이번 가져오기 안에서 같은 외부 ID가 여러 학생 코드에 연결됩니다.'
        ));
      }
    });

    return {
      module_version: MODULE_VERSION,
      stage: WORKFLOW.PREVIEW,
      provider: publicDefinition(provider),
      source: {
        kind: 'manual_' + format,
        format: format,
        source_hash: sourceHash,
        hash_scope: 'canonical_allowed_fields_v1',
        source_ref: text(options.sourceRef),
        row_count: candidates.length
      },
      candidates: candidates,
      summary: {
        total: candidates.length,
        with_blocking_issues: candidates.filter(function (candidate) {
          return candidate.issues.some(function (item) { return item.blocking; });
        }).length
      }
    };
  }

  function normalizeExistingKeys(existing) {
    if (!existing) return new Set();
    if (existing instanceof Set) return new Set(existing);
    if (Array.isArray(existing)) return new Set(existing);
    if (isPlainObject(existing)) return new Set(Object.keys(existing));
    throw new ProgramImportError('INVALID_EXISTING_KEYS', '기존 중복키 목록 형식이 올바르지 않습니다.');
  }

  function validatePreview(preview, options) {
    if (!preview || preview.stage !== WORKFLOW.PREVIEW || !Array.isArray(preview.candidates)) {
      throw new ProgramImportError('INVALID_PREVIEW', 'previewImport 결과가 필요합니다.');
    }
    var existing = normalizeExistingKeys(options && options.existingIdempotencyKeys);
    var seen = new Map();
    var candidates = cloneJson(preview.candidates);

    candidates.forEach(function (candidate) {
      if (existing.has(candidate.idempotency_key)) {
        candidate.issues.push(issue(
          'ALREADY_IMPORTED', 'error', candidate.row_number, 'idempotency_key',
          '이미 처리된 중복키입니다.'
        ));
      }
      if (seen.has(candidate.idempotency_key)) {
        var previous = seen.get(candidate.idempotency_key);
        var conflict = previous.payload_hash !== candidate.payload_hash;
        candidate.issues.push(issue(
          conflict ? 'IDEMPOTENCY_CONFLICT' : 'DUPLICATE_SOURCE_ROW',
          'error', candidate.row_number, 'idempotency_key',
          conflict ? '같은 식별키에 서로 다른 결과가 있습니다.' : '같은 행이 원본에 중복되어 있습니다.'
        ));
        if (conflict) {
          previous.issues.push(issue(
            'IDEMPOTENCY_CONFLICT', 'error', previous.row_number, 'idempotency_key',
            '같은 식별키에 서로 다른 결과가 있습니다.'
          ));
        }
      } else seen.set(candidate.idempotency_key, candidate);
    });

    candidates.forEach(function (candidate) {
      candidate.valid_for_confirm_candidate = !candidate.issues.some(function (item) { return item.blocking; });
    });
    var valid = candidates.filter(function (candidate) { return candidate.valid_for_confirm_candidate; });
    var invalid = candidates.filter(function (candidate) { return !candidate.valid_for_confirm_candidate; });
    var checks = invalid.map(function (candidate) {
      return {
        output_type: candidate.provider_id === 'classcard' ? 'classcard_check_needed' : 'program_check_needed',
        row_id: candidate.row_id,
        row_number: candidate.row_number,
        provider_id: candidate.provider_id,
        student_code: candidate.student_code || '',
        status: '확인필요',
        approval_required: true,
        reasons: candidate.issues.filter(function (item) { return item.blocking; }).map(function (item) { return item.code; }),
        idempotency_key: candidate.idempotency_key,
        source_hash: candidate.source.source_hash
      };
    });

    return {
      module_version: MODULE_VERSION,
      stage: WORKFLOW.VALIDATED,
      provider: cloneJson(preview.provider),
      source: cloneJson(preview.source),
      candidates: candidates,
      valid_candidates: valid,
      invalid_candidates: invalid,
      program_check_needed: checks,
      summary: {
        total: candidates.length,
        valid: valid.length,
        invalid: invalid.length,
        can_create_confirm_candidates: valid.length > 0
      }
    };
  }

  function createConfirmCandidates(validation, options) {
    if (!validation || validation.stage !== WORKFLOW.VALIDATED || !Array.isArray(validation.valid_candidates)) {
      throw new ProgramImportError('INVALID_VALIDATION', 'validatePreview 결과가 필요합니다.');
    }
    options = options || {};
    var selected = options.selectedRowIds ? new Set(options.selectedRowIds) : null;
    var requestedBy = text(options.requestedBy) || 'human_review';
    var outputs = validation.valid_candidates.filter(function (candidate) {
      return !selected || selected.has(candidate.row_id);
    }).map(function (candidate) {
      var needsCarryover = CARRYOVER_STATUSES.indexOf(candidate.candidate_status) >= 0;
      return {
        row_id: candidate.row_id,
        row_number: candidate.row_number,
        output_type: candidate.provider_id === 'classcard'
          ? 'classcard_state_candidate'
          : 'online_program_state_candidate',
        workflow_stage: WORKFLOW.CONFIRM_CANDIDATE,
        provider_id: candidate.provider_id,
        student_code: candidate.student_code,
        account_id_ref: candidate.account_id_ref,
        check_date: candidate.check_date,
        candidate_status: candidate.candidate_status,
        reported_status: candidate.reported_status,
        confirmed_status: null,
        final_status: null,
        confirmed: false,
        approval_type: 'program_result_confirmation',
        approval_required: true,
        approval_status: 'pending',
        requested_by: requestedBy,
        requested_action: 'review_program_result_candidate',
        carryover_candidate_required: needsCarryover,
        external_send_allowed: false,
        external_change_allowed: false,
        ledger_write_allowed: false,
        duplicate_key: candidate.idempotency_key,
        payload_hash: candidate.payload_hash,
        source_hash: candidate.source.source_hash,
        source_ref: candidate.source.source_ref,
        source_date: candidate.source.source_date,
        data: cloneJson(candidate.data)
      };
    });
    return {
      module_version: MODULE_VERSION,
      stage: WORKFLOW.CONFIRM_CANDIDATE,
      provider: cloneJson(validation.provider),
      candidates: outputs,
      program_check_needed: cloneJson(validation.program_check_needed),
      summary: {
        selected: outputs.length,
        pending_human_approval: outputs.length,
        auto_confirmed: 0,
        external_changes: 0,
        ledger_writes: 0
      }
    };
  }

  function createReviewRows(validation, options) {
    if (!validation || validation.stage !== WORKFLOW.VALIDATED || !Array.isArray(validation.valid_candidates)) {
      throw new ProgramImportError('INVALID_VALIDATION', 'validatePreview 결과가 필요합니다.');
    }
    options = options || {};
    var selected = options.selectedRowIds ? new Set(options.selectedRowIds) : null;
    return validation.valid_candidates.map(function (candidate) {
      var data = candidate.data || {};
      return {
        row_id: candidate.row_id,
        row_number: candidate.row_number,
        selected: selected ? selected.has(candidate.row_id) : true,
        provider_id: candidate.provider_id,
        provider_label: candidate.provider_label,
        student_code: candidate.student_code,
        check_date: candidate.check_date,
        status: candidate.candidate_status,
        account_id_ref: candidate.account_id_ref,
        current_unit: data.current_unit === undefined ? null : data.current_unit,
        progress_pct: data.progress_pct === undefined ? null : data.progress_pct,
        score: data.score === undefined ? null : data.score,
        target_score: data.target_score === undefined ? null : data.target_score,
        set_name: data.set_name === undefined ? null : data.set_name,
        detail: cloneJson(data),
        duplicate_key: candidate.idempotency_key,
        payload_hash: candidate.payload_hash
      };
    });
  }

  function normalizedApprovedAt(value) {
    var input = text(value);
    if (!input || !Number.isFinite(Date.parse(input))) {
      throw new ProgramImportError('INVALID_APPROVED_AT', '승인 시각은 ISO 날짜·시각이어야 합니다.');
    }
    return new Date(input).toISOString();
  }

  function approveConfirmCandidates(confirmBatch, options) {
    if (!confirmBatch || confirmBatch.stage !== WORKFLOW.CONFIRM_CANDIDATE || !Array.isArray(confirmBatch.candidates)) {
      throw new ProgramImportError('INVALID_CONFIRM_BATCH', 'createConfirmCandidates 결과가 필요합니다.');
    }
    options = options || {};
    var actor = text(options.approvedBy);
    if (!actor) throw new ProgramImportError('APPROVER_REQUIRED', '승인자 식별자가 필요합니다.');
    if (!Array.isArray(options.selectedRowIds) || !options.selectedRowIds.length) {
      throw new ProgramImportError('SELECTION_REQUIRED', '승인할 행을 한 개 이상 명시적으로 선택해야 합니다.');
    }
    var selected = new Set(options.selectedRowIds);
    if (selected.size !== options.selectedRowIds.length) {
      throw new ProgramImportError('DUPLICATE_SELECTION', '같은 행을 중복 선택할 수 없습니다.');
    }
    var available = new Set(confirmBatch.candidates.map(function (candidate) { return candidate.row_id; }));
    selected.forEach(function (rowId) {
      if (!available.has(rowId)) throw new ProgramImportError('UNKNOWN_SELECTION', '승인 후보에 없는 행이 선택되었습니다.');
    });
    var at = normalizedApprovedAt(options.approvedAt);
    var approved = [];
    var pending = [];
    var candidates = confirmBatch.candidates.map(function (candidate) {
      var output = cloneJson(candidate);
      if (!selected.has(output.row_id)) {
        pending.push(output);
        return output;
      }
      if (output.approval_status !== 'pending' || output.confirmed || output.ledger_write_allowed) {
        throw new ProgramImportError('CANDIDATE_NOT_PENDING', '대기 상태 후보만 승인할 수 있습니다.');
      }
      output.workflow_stage = WORKFLOW.APPROVED;
      output.approval_status = 'approved';
      output.confirmed = true;
      output.confirmed_status = output.candidate_status;
      output.final_status = output.candidate_status;
      output.approved_by = actor;
      output.approved_at = at;
      output.ledger_write_allowed = true;
      output.approval_record = {
        decision: 'approved', approved_by: actor, approved_at: at,
        row_id: output.row_id, duplicate_key: output.duplicate_key,
        payload_hash: output.payload_hash
      };
      approved.push(output);
      return output;
    });
    return {
      module_version: MODULE_VERSION,
      stage: WORKFLOW.APPROVED,
      provider: cloneJson(confirmBatch.provider),
      candidates: candidates,
      approved_candidates: approved,
      pending_candidates: pending,
      program_check_needed: cloneJson(confirmBatch.program_check_needed || []),
      summary: {
        approved: approved.length, pending: pending.length,
        external_changes: 0, ledger_writes_allowed: approved.length
      }
    };
  }

  return Object.freeze({
    MODULE_VERSION: MODULE_VERSION,
    WORKFLOW: WORKFLOW,
    ProgramImportError: ProgramImportError,
    ProviderRegistry: ProviderRegistry,
    createDefaultRegistry: createDefaultRegistry,
    parseCsv: parseCsv,
    parseJson: parseJson,
    sha256Hex: sha256Hex,
    isOpaqueAccountRef: isOpaqueAccountRef,
    previewImport: previewImport,
    validatePreview: validatePreview,
    createReviewRows: createReviewRows,
    createConfirmCandidates: createConfirmCandidates,
    approveConfirmCandidates: approveConfirmCandidates
  });
});
