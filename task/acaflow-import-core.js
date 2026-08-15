(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WB_AcaFlowImport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const text = value => String(value == null ? '' : value).normalize('NFKC').trim();
  const compact = value => text(value).replace(/\s+/g, '');
  const digits = value => String(value == null ? '' : value).replace(/\D/g, '');
  const mobile = value => /^01[016789]\d{7,8}$/.test(digits(value));

  function xmlText(value) {
    return String(value || '').replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();
  }

  function xmlRows(source) {
    return [...String(source || '').matchAll(/<Row\b[^>]*>([\s\S]*?)<\/Row>/gi)].map(row => {
      const out = [];
      let cursor = 0;
      for (const match of row[1].matchAll(/<Cell\b([^>]*)>([\s\S]*?)<\/Cell>/gi)) {
        const index = match[1].match(/(?:ss:)?Index=["'](\d+)["']/i);
        if (index) cursor = Math.max(0, Number(index[1]) - 1);
        const data = match[2].match(/<Data\b[^>]*>([\s\S]*?)<\/Data>/i);
        out[cursor++] = xmlText(data ? data[1] : '');
      }
      return out;
    });
  }

  function delimitedRows(source, delimiter) {
    const rows = []; let row = [], cell = '', quoted = false;
    const value = String(source || '').replace(/^\uFEFF/, '');
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      if (quoted) {
        if (ch === '"' && value[i + 1] === '"') { cell += '"'; i += 1; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delimiter) { row.push(cell.trim()); cell = ''; }
      else if (ch === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
      else if (ch !== '\r') cell += ch;
    }
    row.push(cell.trim());
    if (row.some(Boolean)) rows.push(row);
    return rows;
  }

  const header = value => compact(value).toLowerCase();
  function column(headers, predicate) {
    return headers.findIndex(value => predicate(header(value)));
  }

  function parseSpreadsheetText(source, fileName) {
    const raw = String(source || '');
    const rows = /^\s*<\?xml|<Workbook\b|<Row\b/i.test(raw)
      ? xmlRows(raw)
      : delimitedRows(raw, raw.split(/\r?\n/, 1)[0].includes('\t') ? '\t' : ',');
    if (rows.length < 2) throw new Error('학생 자료가 들어 있는 행을 찾지 못했습니다');
    const headers = rows[0].map(text);
    const nameIndex = column(headers, value => ['성명', '학생명', '원생명', '이름'].includes(value));
    const phoneIndex = column(headers, value =>
      /(학부모|보호자)/.test(value) && /(전화|연락처|휴대폰|핸드폰)/.test(value));
    const fallbackPhone = phoneIndex < 0 ? column(headers, value => /^(학부모|보호자)/.test(value)) : phoneIndex;
    const gradeIndex = column(headers, value => value === '학년');
    const schoolIndex = column(headers, value => value === '학교' || value === '학교명');
    const numberIndex = column(headers, value => ['학생번호', '원생번호', '수강생번호'].includes(value));
    if (nameIndex < 0 || fallbackPhone < 0) {
      throw new Error('성명과 학부모 연락처 열을 찾지 못했습니다');
    }
    const parsed = rows.slice(1).map((values, offset) => ({
      sourceRow: offset + 2,
      externalStudentNo: numberIndex < 0 ? '' : text(values[numberIndex]),
      name: text(values[nameIndex]),
      grade: gradeIndex < 0 ? '' : text(values[gradeIndex]),
      school: schoolIndex < 0 ? '' : text(values[schoolIndex]),
      phone: digits(values[fallbackPhone])
    })).filter(row => row.name || row.phone);
    if (!parsed.length) throw new Error('학생 자료가 들어 있는 행을 찾지 못했습니다');
    if (parsed.length > 500) throw new Error('한 번에 500명까지만 확인할 수 있습니다');
    return { fileName: text(fileName).slice(0, 180), rows: parsed };
  }

  function gradeKey(value, school) {
    const raw = compact(value);
    const number = (raw.match(/\d+/) || [])[0] || '';
    let level = /유치/.test(raw) ? '유' : /초/.test(raw) ? '초' : /중/.test(raw) ? '중' : /고/.test(raw) ? '고' : '';
    if (!level) {
      const schoolText = compact(school);
      level = /초/.test(schoolText) ? '초' : /중/.test(schoolText) ? '중' : /고/.test(schoolText) ? '고' : '';
    }
    return level + number;
  }

  function gradeMatches(source, rosterGrade) {
    const left = gradeKey(source.grade, source.school), right = gradeKey(rosterGrade, '');
    if (!left || !right) return true;
    if (left === right) return true;
    const leftNumber = (left.match(/\d+/) || [])[0], rightNumber = (right.match(/\d+/) || [])[0];
    return !/[유초중고]/.test(left) && leftNumber && leftNumber === rightNumber;
  }

  function maskPhone(value) {
    const phone = digits(value);
    if (!mobile(phone)) return '';
    return phone.length === 11
      ? phone.slice(0, 3) + '-****-' + phone.slice(-4)
      : phone.slice(0, 3) + '-***-' + phone.slice(-4);
  }

  function buildPreview(rows, roster, contacts, acaflowLinks) {
    const students = Array.isArray(roster) ? roster : [];
    const contactMap = contacts instanceof Map ? contacts : new Map();
    const linkMap = acaflowLinks instanceof Map ? acaflowLinks : new Map();
    const byId = new Map(students.filter(student => student && student.id).map(student => [student.id, student]));
    const byName = new Map();
    students.forEach(student => {
      const key = compact(student && student.name).toLocaleLowerCase('ko');
      if (!key) return;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(student);
    });
    const seenStudentIds = new Set();
    const entries = (rows || []).map(source => {
      const key = compact(source.name).toLocaleLowerCase('ko');
      const linkedStudentId = linkMap.get(text(source.externalStudentNo)) || '';
      const linkedStudent = linkedStudentId ? byId.get(linkedStudentId) : null;
      const candidates = linkedStudent ? [linkedStudent]
        : (byName.get(key) || []).filter(student => gradeMatches(source, student.grade));
      let status = 'unmatched', student = null, currentContact = null;
      if (!mobile(source.phone)) status = 'invalid_phone';
      else if (linkedStudentId && !linkedStudent) status = 'link_orphan';
      else if (candidates.length > 1) status = 'ambiguous';
      else if (candidates.length === 1) {
        student = candidates[0];
        if (seenStudentIds.has(student.id)) status = 'duplicate';
        else {
          seenStudentIds.add(student.id);
          currentContact = contactMap.get(student.id) || null;
          const currentPhone = digits(currentContact && currentContact.phone);
          status = !currentPhone ? 'new' : currentPhone === source.phone ? 'unchanged' : 'changed';
          if (status === 'unchanged' && source.externalStudentNo && !linkedStudent) status = 'link_needed';
        }
      }
      return {
        sourceRow: source.sourceRow, externalStudentNo: source.externalStudentNo,
        name: source.name, grade: source.grade, studentId: student ? student.id : '',
        studentName: student ? student.name : '', phone: source.phone,
        maskedPhone: maskPhone(source.phone), status,
        currentConsent: !!(currentContact && currentContact.consent),
        linkedByStudentNo: !!linkedStudent,
        rosterNameDiffers: !!(linkedStudent && compact(source.name).toLocaleLowerCase('ko') !==
          compact(linkedStudent.name).toLocaleLowerCase('ko'))
      };
    });
    const counts = {};
    entries.forEach(entry => { counts[entry.status] = (counts[entry.status] || 0) + 1; });
    return { entries, counts };
  }

  return { parseSpreadsheetText, buildPreview, maskPhone, mobile, digits };
});
