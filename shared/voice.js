'use strict';
/* WB 공통 음성 모듈 — 진로독서·워드브레인이 같은 엔진을 쓴다.
   ① 읽어주기(TTS): 글을 소리로 들려준다. 눈은 글에 두고 귀로 속도를 받는 용도다.
   ② 낭독 녹음: 학생이 소리 내어 읽은 것을 담는다. 기기 밖으로 나가지 않는다.
   브라우저마다 목소리 유무·동작이 달라서, 없으면 조용히 죽지 말고 알려 주도록 만들었다. */
var WBVoice = (function () {

  /* ── 읽어주기 ── */
  var voicesReady = false, readyCbs = [];

  function synth() { return (typeof window !== 'undefined' && window.speechSynthesis) || null; }
  function ttsSupported() { return !!synth() && typeof SpeechSynthesisUtterance !== 'undefined'; }

  function allVoices() {
    var s = synth();
    if (!s) return [];
    try { return s.getVoices() || []; } catch (e) { return []; }
  }

  /* 크롬은 getVoices()가 처음에 빈 배열이고 voiceschanged 뒤에야 찬다 */
  function onReady(cb) {
    if (!ttsSupported()) { cb(false); return; }
    if (voicesReady || allVoices().length) { voicesReady = true; cb(true); return; }
    readyCbs.push(cb);
    var s = synth(), done = false;
    var fire = function () {
      if (done) return;
      done = true; voicesReady = true;
      var list = readyCbs.slice(); readyCbs = [];
      list.forEach(function (f) { f(allVoices().length > 0); });
    };
    try { s.addEventListener('voiceschanged', fire, { once: true }); } catch (e) {}
    setTimeout(fire, 1200); // voiceschanged가 안 오는 브라우저 대비
  }

  /* 한·영 병기 지문에서 덩어리마다 목소리를 고른다.
     글자 수를 그냥 비교하면 안 된다 — 한글은 음절당 정보량이 라틴 문자보다 커서
     "관측 observe 하다"(한글 4 vs 라틴 7)가 영어로 넘어간다.
     오판 비용도 한쪽으로 기운다: 한국어 목소리는 영단어를 그럭저럭 읽지만
     영어 목소리는 한글을 아예 못 읽는다. 그래서 한글이 보이면 한국어로 판정한다. */
  function langOf(text) {
    var t = String(text || '');
    var han = (t.match(/[가-힣]/g) || []).length;
    var lat = (t.match(/[A-Za-z]/g) || []).length;
    if (han && lat < han * 8) return 'ko';   // 한글이 섞였으면 한국어로 읽는다
    return lat ? 'en' : 'ko';                // 라틴만 있을 때만 영어
  }

  function voiceFor(lang) {
    var want = (lang || 'ko').slice(0, 2).toLowerCase();
    var vs = allVoices().filter(function (v) { return (v.lang || '').slice(0, 2).toLowerCase() === want; });
    if (!vs.length) return null;
    var def = vs.filter(function (v) { return v.default; })[0];
    return def || vs[0];
  }

  function hasVoice(lang) { return !!voiceFor(lang); }

  var speaking = false;

  /* 한 덩어리를 읽는다. onend는 끝났을 때 한 번만 부른다(중단 시엔 부르지 않는다). */
  function speak(text, opt) {
    opt = opt || {};
    var s = synth();
    var body = String(text || '').trim();
    if (!s || !body) { if (opt.onend) opt.onend(); return null; }

    var lang = opt.lang || langOf(body);
    var u = new SpeechSynthesisUtterance(body);
    var v = voiceFor(lang);
    if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = lang === 'en' ? 'en-US' : 'ko-KR'; }
    u.rate = Math.min(2, Math.max(0.5, opt.rate == null ? 1 : opt.rate));
    u.pitch = opt.pitch == null ? 1 : opt.pitch;

    var settled = false;
    u.onend = function () { if (settled) return; settled = true; speaking = false; if (opt.onend) opt.onend(); };
    u.onerror = function (e) {
      if (settled) return; settled = true; speaking = false;
      // 사용자가 멈춘 것(interrupted/canceled)은 오류가 아니다
      var why = (e && e.error) || '';
      if (why === 'interrupted' || why === 'canceled') return;
      if (opt.onerror) opt.onerror(why); else if (opt.onend) opt.onend();
    };

    // iOS는 cancel 직후 speak하면 먹통이 되는 일이 있어 한 박자 띄운다
    try { s.cancel(); } catch (e) {}
    speaking = true;
    setTimeout(function () { try { s.speak(u); } catch (e) { u.onerror({ error: 'failed' }); } }, 40);
    return u;
  }

  function stop() {
    var s = synth();
    speaking = false;
    if (s) { try { s.cancel(); } catch (e) {} }
  }

  /* 여러 토막을 차례로 읽는다 — 낱말 → 뜻 → 예문처럼.
     한 번에 긴 문자열로 넘기면 엔진에 따라 중간이 잘리고, 사이 쉼도 안 생긴다. */
  function speakSeq(list, opt) {
    opt = opt || {};
    var items = (list || []).map(function (x) { return String(x == null ? '' : x).trim(); }).filter(Boolean);
    var i = 0, cancelled = false;
    function step() {
      if (cancelled) return;
      if (i >= items.length) { if (opt.onend) opt.onend(); return; }
      speak(items[i++], {
        rate: opt.rate, lang: opt.lang, onend: step,
        onerror: function (why) { cancelled = true; if (opt.onerror) opt.onerror(why); },
      });
    }
    step();
    return { cancel: function () { cancelled = true; stop(); } };
  }

  function isSpeaking() { return speaking; }

  /* ── 낭독 녹음 ── */
  function recSupported() {
    return typeof navigator !== 'undefined' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
      && typeof MediaRecorder !== 'undefined';
  }

  /* 사파리는 webm을 못 만든다 — 지원하는 것 중에서 고른다 */
  function pickMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    var cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < cands.length; i++) if (MediaRecorder.isTypeSupported(cands[i])) return cands[i];
    return '';
  }

  function Recorder() {
    this.rec = null; this.stream = null; this.chunks = []; this.url = null; this.t0 = 0;
  }
  Recorder.prototype.start = function () {
    var self = this;
    if (!recSupported()) return Promise.reject(new Error('unsupported'));
    self.release();
    return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var mime = pickMime();
      var rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      self.rec = rec; self.stream = stream; self.chunks = []; self.t0 = Date.now();
      rec.ondataavailable = function (e) { if (e.data && e.data.size) self.chunks.push(e.data); };
      rec.start();
      return true;
    });
  };
  Recorder.prototype.stop = function () {
    var self = this;
    return new Promise(function (resolve) {
      var rec = self.rec;
      if (!rec || rec.state !== 'recording') { resolve(null); return; }
      rec.onstop = function () {
        self.stopTracks();
        var blob = new Blob(self.chunks, { type: rec.mimeType || 'audio/webm' });
        self.url = URL.createObjectURL(blob);
        resolve({ blob: blob, url: self.url, ms: Date.now() - self.t0 });
      };
      try { rec.stop(); } catch (e) { self.stopTracks(); resolve(null); }
    });
  };
  Recorder.prototype.elapsedMs = function () { return this.t0 ? Date.now() - this.t0 : 0; };
  Recorder.prototype.stopTracks = function () {
    if (this.stream) { try { this.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} }
    this.stream = null; this.rec = null;
  };
  Recorder.prototype.release = function () {
    if (this.rec && this.rec.state === 'recording') { this.rec.onstop = null; try { this.rec.stop(); } catch (e) {} }
    this.stopTracks();
    if (this.url) { try { URL.revokeObjectURL(this.url); } catch (e) {} this.url = null; }
    this.chunks = []; this.t0 = 0;
  };

  /* 0:07 같은 표시 */
  function clock(ms) {
    var s = Math.max(0, Math.floor((ms || 0) / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  return {
    ttsSupported: ttsSupported, onReady: onReady, hasVoice: hasVoice, voiceFor: voiceFor,
    langOf: langOf, speak: speak, speakSeq: speakSeq, stop: stop, isSpeaking: isSpeaking,
    recSupported: recSupported, pickMime: pickMime, Recorder: Recorder, clock: clock,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBVoice;
