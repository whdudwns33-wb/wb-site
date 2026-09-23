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

  var current = null, startWatch = null;

  /* 기존 호출부와 호환한다. 빈 무음 발화를 넣고 곧 취소하지 않는다.
     실제 발화는 speak()가 클릭 안에서 바로 요청하며, 일시 정지도 거기서 푼다. */
  function unlock() {
    var s = synth();
    if (!ttsSupported()) return false;
    try {
      if (s.resume) s.resume();
      return true;
    } catch (e) { return false; }
  }

  function ttsError(opt, why) {
    if (opt.onerror) opt.onerror(why); else if (opt.onend) opt.onend();
  }

  /* 한 덩어리를 읽는다. onend는 끝났을 때 한 번만 부른다(중단 시엔 부르지 않는다). */
  function speak(text, opt) {
    opt = opt || {};
    var s = synth();
    var body = String(text || '').trim();
    if (!body) { if (opt.onend) opt.onend(); return null; }
    if (!ttsSupported()) { ttsError(opt, 'unsupported'); return null; }
    if (current || s.speaking || s.pending) stop();

    var lang = opt.lang || langOf(body);
    var u;
    try {
      u = new SpeechSynthesisUtterance(body);
      var v = voiceFor(lang);
      if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = lang === 'en' ? 'en-US' : lang === 'ko' ? 'ko-KR' : lang; }
      u.rate = Math.min(2, Math.max(0.5, opt.rate == null ? 1 : opt.rate));
      u.pitch = opt.pitch == null ? 1 : opt.pitch;
    } catch (e) { ttsError(opt, 'failed'); return null; }

    var started = false;
    function finish(why) {
      if (current !== u) return;
      current = null; clearTimeout(startWatch); startWatch = null;
      if (why) ttsError(opt, why); else if (opt.onend) opt.onend();
    }
    /* 소리가 실제로 시작됐는지는 이것으로만 알 수 있다.
       getVoices()가 비어 있어도 엔진이 읽어 주는 기기가 있고, 목록이 차 있어도
       한 마디도 못 내는 기기가 있다. 목록을 믿지 말고 시작 신호를 믿는다. */
    u.onstart = function () {
      if (current !== u || started) return;
      started = true; clearTimeout(startWatch); startWatch = null;
      if (opt.onstart) { try { opt.onstart(); } catch (e) {} }
    };
    u.onend = function () { finish(); };
    u.onerror = function (e) { finish((e && e.error) || 'failed'); };

    current = u;
    /* 필요한 화면에서만 시작을 감시한다. stop/교체 뒤 늦은 이벤트는 새 발화를 건드리지 않는다. */
    if (opt.startTimeout > 0) startWatch = setTimeout(function () {
      if (current !== u || started) return;
      stop(); ttsError(opt, 'start-timeout');
    }, opt.startTimeout);
    /* 클릭 안에서 요청해 재생 권한을 보존하고, stop 뒤의 예약 재생을 없앤다. */
    try { if (s.resume) s.resume(); s.speak(u); } catch (e) { u.onerror({ error: 'failed' }); }
    return u;
  }

  function stop() {
    var s = synth();
    current = null; clearTimeout(startWatch); startWatch = null;
    if (s) { try { s.cancel(); } catch (e) {} }
  }

  /* 여러 토막을 차례로 읽는다 — 낱말 → 뜻 → 예문처럼.
     한 번에 긴 문자열로 넘기면 엔진에 따라 중간이 잘리고, 사이 쉼도 안 생긴다. */
  function speakSeq(list, opt) {
    opt = opt || {};
    var items = (list || []).map(function (x) { return String(x == null ? '' : x).trim(); }).filter(Boolean);
    var i = 0, cancelled = false, utterance = null;
    function step() {
      if (cancelled) return;
      if (i >= items.length) { if (opt.onend) opt.onend(); return; }
      utterance = speak(items[i++], {
        rate: opt.rate, lang: opt.lang, startTimeout: opt.startTimeout, onstart: opt.onstart, onend: step,
        onerror: function (why) { cancelled = true; ttsError(opt, why); },
      });
    }
    step();
    return { cancel: function () { cancelled = true; if (current === utterance) stop(); } };
  }

  function isSpeaking() { return !!current; }

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
    ttsSupported: ttsSupported, onReady: onReady, hasVoice: hasVoice, voiceFor: voiceFor, unlock: unlock,
    langOf: langOf, speak: speak, speakSeq: speakSeq, stop: stop, isSpeaking: isSpeaking,
    recSupported: recSupported, pickMime: pickMime, Recorder: Recorder, clock: clock,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBVoice;
