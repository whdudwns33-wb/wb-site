/* 크롬 확장 파일(./ext/*)을 zip 하나로 묶어 내려준다. 압축 없이(store) 담는 것이라 라이브러리가 필요 없다.
 * 왜 zip 인가: 크롬의 "압축해제된 확장 프로그램 로드"는 폴더가 필요하고, 직원 PC 에 파일 5개를 하나씩 받게 할 수는 없다. */
(function () {
  'use strict';
  const FILES = ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js'];
  const FOLDER = 'wb-desk-capture/';

  const table = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; t[i] = c >>> 0; } return t; })();
  function crc32(u8) { let crc = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) crc = table[(crc ^ u8[i]) & 0xFF] ^ (crc >>> 8); return (crc ^ 0xFFFFFFFF) >>> 0; }
  const le16 = n => [n & 255, (n >>> 8) & 255];
  const le32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

  function zip(files) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | ((now.getSeconds() >> 1) & 31);
    const dosDate = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);
    const parts = [], central = [];
    let offset = 0;
    files.forEach(f => {
      const name = enc.encode(f.name), crc = crc32(f.data), n = f.data.length;
      const local = new Uint8Array([...le32(0x04034b50), ...le16(20), ...le16(0x0800), ...le16(0), ...le16(dosTime), ...le16(dosDate), ...le32(crc), ...le32(n), ...le32(n), ...le16(name.length), ...le16(0), ...name]);
      parts.push(local, f.data);
      central.push(new Uint8Array([...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(0x0800), ...le16(0), ...le16(dosTime), ...le16(dosDate), ...le32(crc), ...le32(n), ...le32(n),
        ...le16(name.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(offset), ...name]));
      offset += local.length + n;
    });
    const cdStart = offset;
    let cdLen = 0;
    central.forEach(c => { parts.push(c); cdLen += c.length; });
    parts.push(new Uint8Array([...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(files.length), ...le16(files.length), ...le32(cdLen), ...le32(cdStart), ...le16(0)]));
    return new Blob(parts, { type: 'application/zip' });
  }

  async function download() {
    const btn = document.getElementById('dl'), msg = document.getElementById('msg');
    btn.disabled = true; msg.textContent = '파일을 모으는 중…';
    try {
      const files = [];
      for (const name of FILES) {
        const res = await fetch('./ext/' + name, { cache: 'no-store' });
        if (!res.ok) throw new Error(name + ' 을(를) 받지 못했습니다 (' + res.status + ')');
        files.push({ name: FOLDER + name, data: new Uint8Array(await res.arrayBuffer()) });
      }
      const blob = zip(files);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'wb-desk-capture.zip';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      msg.textContent = '내려받았습니다 — 압축을 풀고 아래 순서대로 설치하세요. (' + files.length + '개 파일, ' + Math.round(blob.size / 1024) + 'KB)';
    } catch (error) {
      msg.textContent = '실패 — ' + (error && error.message || error);
    } finally { btn.disabled = false; }
  }
  document.getElementById('dl').addEventListener('click', download);
  window.WBExtZip = { zip: zip, crc32: crc32 };
})();
