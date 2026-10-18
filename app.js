/* 2026 单词王 · 大班级 —— 练习页逻辑 */
(function () {
"use strict";

var D = window.WORD_DATA || { words: [], categories: [] };
var WORDS = D.words;
var BY_EN = {};
WORDS.forEach(function (w) { BY_EN[w.en] = w; });
var WORD_BY_ID = {};
WORDS.forEach(function (w) { WORD_BY_ID[w.id] = w; });

/* ---------------- 设置与进度（localStorage） ---------------- */
var KEY = "wordking.v1";
var S = { zh:false, auto:true, timer:true, slow:false, voice:"", n:10, prog:{} };
try { Object.assign(S, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (e) {}
/* 旧版本/异常数据可能把 prog 存坏（null 等），会导致 mark() 抛错、答题后永远无法进下一题 */
if (!S.prog || typeof S.prog !== "object") S.prog = {};
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
}

/* ================= 发音：mp3 优先，浏览器 TTS 兜底 =================
   Pre-recorded clips are the primary path: identical pronunciation on every
   device, works offline, and cannot be mangled by a missing or Chinese voice.
   The browser SpeechSynthesis path stays as a fallback and is kept correct -
   measured on real Chrome 155 (see tools/_e2e_tts.py):
   - getVoices() returns an EMPTY list on the first call and only fills in
     ~400ms later, so a speak() that runs too early silently gets no voice and
     Chrome falls back to the system default - on a Chinese Windows that is a
     Chinese voice, which is what makes English sound garbled.
   - Chrome blocks speech that is not tied to a user gesture ("not-allowed"),
     so the engine is woken up by the first tap.
   - a Chinese voice must NEVER be used to read English; if there is no English
     voice at all we skip reading and say so instead.
*/
var voices = [];
var voicesReady = false;      // a voice list has arrived at least once
var voiceWaiters = [];

function loadVoices() {
  if (!("speechSynthesis" in window)) return;
  try { voices = speechSynthesis.getVoices() || []; } catch (e) { voices = []; }
  if (voices.length && !voicesReady) {
    voicesReady = true;
    var w = voiceWaiters; voiceWaiters = [];
    for (var i = 0; i < w.length; i++) { try { w[i](); } catch (e) {} }
  }
}
if (window.speechSynthesis) {
  loadVoices();
  // ONE handler: it must refresh the voice list AND repaint the picker.
  // Assigning onvoiceschanged twice would drop the first one, and the voice
  // array would stay empty -> no voice -> Chrome reads English in a Chinese
  // voice -> "含混".
  speechSynthesis.onvoiceschanged = function () { loadVoices(); renderVoices(); };
  // The speech service can take a while to come up (a cold profile measured 3s
  // with no voices at all, 22 a moment later), so keep polling for a while.
  [300, 800, 1500, 2500, 4000, 6000, 9000].forEach(function (ms) {
    setTimeout(function () { loadVoices(); renderVoices(); }, ms);
  });
}
function whenVoices(cb) {
  if (voicesReady) { cb(); return; }
  voiceWaiters.push(cb);
  setTimeout(function () {
    if (!voicesReady) { loadVoices(); if (!voicesReady) cb(); }
  }, 9000);
}
function enVoices() {
  return voices.filter(function (v) { return /^en([-_]|$)/i.test(v.lang || ""); });
}
function voiceScore(v) {
  var s = 0;
  if (v.localService) s += 100;          // local voice keeps working offline
  if (/en[-_]US/i.test(v.lang)) s += 20;
  if (/Google US English/i.test(v.name)) s += 12;
  if (/Zira|Aria|Jenny|Google UK English Female/i.test(v.name)) s += 8;
  return s;
}
function pickVoice() {
  var list = enVoices();
  if (!list.length) return null;
  if (S.voice) {
    for (var s = 0; s < voices.length; s++) {
      if (voices[s].name === S.voice) return voices[s];
    }
  }
  var pref = ["Microsoft Aria", "Microsoft Zira", "Microsoft Jenny",
              "Google US English", "Google UK English Female", "Samantha", "Karen", "Daniel"];
  for (var p = 0; p < pref.length; p++) {
    for (var a = 0; a < list.length; a++) {
      if ((list[a].name || "").indexOf(pref[p]) === 0) return list[a];
    }
  }
  list.sort(function (x, y) { return voiceScore(y) - voiceScore(x); });
  return list[0];
}

var hasTTS = "speechSynthesis" in window;
var autoTimer = null;      // queued "read the question aloud"
var goTimer = null;        // deferred speak, see ttsSpeak()
var ttsWarned = 0;

function ttsProblem(msg) {
  if (Date.now() - ttsWarned < 4000) return;
  ttsWarned = Date.now();
  toast(msg);
}

/* Chrome only allows speech tied to a user gesture; wake the engine on the
   very first tap so the first real word is not rejected with "not-allowed". */
var warmed = false;
function warmUp() {
  if (warmed || !hasTTS) return;
  warmed = true;
  try {
    var u = new SpeechSynthesisUtterance("a");
    u.volume = 0; u.lang = "en-US";
    speechSynthesis.speak(u);
  } catch (e) {}
}
["pointerdown", "touchstart", "keydown"].forEach(function (ev) {
  document.addEventListener(ev, warmUp, { once: true });
});
/* ---- 词典读音（每词一个 mp3）----
   audio/wNNN.mp3 现在是真实词典发音（牛津学习者词典美音真人录音，
   牛津没有的短语词条用有道词典读音兜底，来源清单见 audio-sources.json）。
   播放直接走 HTMLAudioElement（慢速 playbackRate=0.6，preservesPitch 不变调），
   播不出时回退浏览器 TTS（speakWord 内处理）。 */
var clip = null;            // shared Audio element for per-word playback
var clipBroken = {};        // per-word flag so we only fall back once
var HAVE_CLIPS = true;      // 每词词典音频已全量收录

function playAudioElement(w, slow) {
  if (!w || !w.audio || clipBroken[w.en]) return false;
  if (!clip) {
    clip = new Audio();
    clip.preload = "auto";
  }
  try {
    clip.pause();
    clip.currentTime = 0;
    if ("preservesPitch" in clip) clip.preservesPitch = true;
    if ("mozPreservesPitch" in clip) clip.mozPreservesPitch = true;
    clip.playbackRate = slow ? 0.6 : 1;
    clip.src = w.audio;
    clip.play();
    return true;
  } catch (e) {
    clipBroken[w.en] = true;
    return false;
  }
}

function playClip(w, slow) {
  if (!w) return false;
  var useSlow = !!(slow || S.slow);
  // 词典读音：每词一个 mp3，直接播放
  return playAudioElement(w, useSlow);
}

/* Two traps that both end with a word cut in half:
   1) a new word starting while the previous one is still playing, and
   2) cancel() immediately followed by speak() - Chrome then truncates the
      START of the new utterance. Both are handled below: the auto-read timer is
      always cleared first, and the actual speak is deferred after a cancel. */
function ttsSpeak(text, slow) {
  if (!hasTTS || !text) return;
  var emit = function () {
    var v = pickVoice();
    if (!v) {
      // No English voice. If the voice list has not arrived yet we are simply
      // early - stay quiet for now rather than reading English in a Chinese
      // voice, which is what sounds garbled.
      if (!voicesReady) { ttsProblem("英文语音还在加载，稍等一下再读"); return; }
      ttsProblem("本机没有英文语音，已跳过朗读（绝不用中文音色念英文）");
      return;
    }
    try {
      var u = new SpeechSynthesisUtterance(String(text));
      u.lang = "en-US";
      u.rate = (slow || S.slow) ? 0.6 : 0.82;
      u.pitch = 1.0;
      u.volume = 1;
      u.voice = v;
      u.onerror = function (e) {
        if (e.error === "not-allowed") ttsProblem("浏览器拦了朗读，再点一下就好");
        else if (e.error !== "interrupted" && e.error !== "canceled") {
          ttsProblem("朗读出错：" + e.error);
        }
      };
      if (speechSynthesis.speaking || speechSynthesis.pending) {
        speechSynthesis.cancel();
        goTimer = setTimeout(function () {
          goTimer = null;
          try { speechSynthesis.speak(u); } catch (e) {}
        }, 70);
      } else {
        speechSynthesis.speak(u);
      }
    } catch (e) {}
  };
  if (voicesReady) emit(); else whenVoices(emit);
}

/* Speak a word: recorded clip first, browser TTS as fallback. */
function speakWord(w, slow) {
  if (!w) return;
  clearTimeout(autoTimer);
  clearTimeout(goTimer);
  if (playClip(w, slow)) return;
  ttsSpeak(say(w), slow);
}
/* Auto-read for a question that is not yet on screen. */
function speakPending(w, slow) {
  clearTimeout(autoTimer);
  clearTimeout(goTimer);
  autoTimer = setTimeout(function () { autoTimer = null; speakWord(w, slow); }, 150);
}

function autoSpeak(text) {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(function () { autoTimer = null; ttsSpeak(text); }, 150);
}
function cancelAutoSpeak() {
  clearTimeout(autoTimer);
  autoTimer = null;
}
function stopSpeak() {
  cancelAutoSpeak();
  clearTimeout(goTimer);
  goTimer = null;
  if (clip) { try { clip.pause(); } catch (e) {} }
  if (hasTTS) { try { speechSynthesis.cancel(); } catch (e) {} }
}

/* ---------------- 小工具 ---------------- */
function $(s, r) { return (r || document).querySelector(s); }
function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
function shuffle(a) {
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function pick(arr, n) { return shuffle(arr.slice()).slice(0, n); }
function toast(msg) {
  var t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._tm);
  t._tm = setTimeout(function () { t.classList.remove("show"); }, 1500);
}
function say(w) { return w.say || w.en; }

/* ---------------- 页面切换 ---------------- */
var CUR = "home";
function show(id) {
  CUR = id;
  $$(".screen").forEach(function (s) { s.classList.toggle("is-active", s.id === "scr-" + id); });
  window.scrollTo(0, 0);
  stopSpeak();
}
$$("[data-back]").forEach(function (b) {
  b.addEventListener("click", function () {
    var target = b.getAttribute("data-back");
    if (target && target !== "home") {
      if (target === "exam-result") { show("exam-result"); return; }
      // generic: just jump
      show(target);
      return;
    }
    // back to home: if mid-exam, clear exam state
    clearExamTimer();
    EXAM.answers = []; EXAM.list = []; EXAM.i = 0;
    show("home"); renderHome();
  });
});

/* ---------------- 首页 ---------------- */
var MODES = [
  { id: "pic2word", ic: "🖼️", nm: "看图选词", ds: "看图片，选出对的英文单词", hl: true, tag: "推荐" },
  { id: "audio2pic", ic: "🔊", nm: "听音选图", ds: "听发音，从 4 张图里选" },
  { id: "word2pic", ic: "🔡", nm: "看词选图", ds: "看单词，选出对的图片" },
  { id: "flash", ic: "🃏", nm: "单词闪卡", ds: "一词一卡，听音看词" }
];

/* ---------------- 词池（全部 vs 按章节） ---------------- */
var WORD_POOL = WORDS.slice();
var POOL_CAT = "";  // 当前章节筛选，"" = 全部

function catWordCount(cat) {
  return WORDS.filter(function (w) { return w.cat === cat; }).length;
}

function setWordPool(cat) {
  POOL_CAT = cat || "";
  WORD_POOL = POOL_CAT ? WORDS.filter(function (w) { return w.cat === POOL_CAT; }) : WORDS.slice();
}

function renderPracticeList() {
  var box = $("#practiceList");
  if (!box) return;
  box.innerHTML = "";
  MODES.forEach(function (m) {
    var b = document.createElement("button");
    b.className = "mode" + (m.hl ? " hl" : "");
    b.innerHTML = (m.tag ? '<span class="tag">' + m.tag + '</span>' : "") +
      '<span class="ic">' + m.ic + '</span><span class="nm">' + m.nm + '</span>' +
      '<span class="ds">' + m.ds + '</span>';
    b.addEventListener("click", function () { start(m.id); });
    box.appendChild(b);
  });
}

function renderChapterList() {
  var box = $("#chapterList");
  if (!box) return;
  box.innerHTML = "";
  D.categories.forEach(function (cat) {
    var n = catWordCount(cat);
    var b = document.createElement("button");
    b.className = "cat-card" + (POOL_CAT === cat ? " sel" : "");
    b.innerHTML =
      '<span class="ic">🗂</span>' +
      '<span class="nm">' + esc(cat) + '</span>' +
      '<span class="ds">' + n + ' 个词</span>';
    b.addEventListener("click", function () {
      // 选章节后回"全部 134"视图，但池已筛选，给用户看到 4 子玩法
      setWordPool(cat);
      $$("#poolSeg button").forEach(function (x) {
        x.classList.toggle("on", x.dataset.pool === "all");
      });
      $("#poolInfo").textContent = (POOL_CAT ? POOL_CAT + " · " : "全部 · ") + WORD_POOL.length + " 词";
      $("#chapterList").hidden = true;
      $("#practiceList").hidden = false;
      renderPracticeList();
      toast("已选「" + cat + "」" + WORD_POOL.length + " 词");
    });
    box.appendChild(b);
  });
}

function renderPractice() {
  if (POOL_CAT) {
    $("#poolInfo").textContent = POOL_CAT + " · " + WORD_POOL.length + " 词";
  } else {
    $("#poolInfo").textContent = "全部 · " + WORD_POOL.length + " 词";
  }
  // 默认显示 4 子玩法；切回"全部"也走这里
  $("#chapterList").hidden = true;
  $("#practiceList").hidden = false;
  renderPracticeList();
}

$("#poolSeg").addEventListener("click", function (e) {
  var t = e.target.closest("button[data-pool]");
  if (!t) return;
  var v = t.dataset.pool;
  $$("#poolSeg button").forEach(function (b) { b.classList.toggle("on", b.dataset.pool === v); });
  if (v === "all") {
    setWordPool("");
    renderPractice();
  } else {
    // 按章节：显示分类网格
    $("#practiceList").hidden = true;
    $("#chapterList").hidden = false;
    renderChapterList();
    $("#poolInfo").textContent = "选一个章节";
  }
});

function renderHome() {
  $("#optZh").checked = !!S.zh;
  $("#optAuto").checked = S.auto;
  $("#optTimer").checked = S.timer;
  $("#optSlow").checked = !!S.slow;
  $$("#roundSeg button").forEach(function (b) {
    b.classList.toggle("on", parseInt(b.dataset.n, 10) === ROUND);
  });
  $("#homeSub").textContent = WORDS.length + " 个单词 · " + D.categories.length + " 个主题 · 每轮 " + ROUND + " 题";

  var seen = 0, ok = 0;
  Object.keys(S.prog).forEach(function (k) {
    seen++;
    if (S.prog[k].ok > S.prog[k].no) ok++;
  });
  var pct = seen ? Math.round(ok / WORDS.length * 100) : 0;
  $("#progBar").style.width = pct + "%";
  $("#progText").textContent = seen
    ? "已练过 " + seen + " 个词，其中 " + ok + " 个已掌握（约 " + pct + "%）"
    : "还没有练习记录，先挑一种玩法开始吧";
  $("#weakN").textContent = weakList().length;
}

$("#goPractice").addEventListener("click", function () {
  // 每次进入都用最新的池与段控件状态
  if (!POOL_CAT) setWordPool("");
  renderPractice();
  show("practice");
});
$("#goExam").addEventListener("click", function () { renderExamConfig(); show("exam-config"); });

["optZh", "optAuto", "optTimer", "optSlow"].forEach(function (id) {
  $("#" + id).addEventListener("change", function (e) {
    var k = { optZh: "zh", optAuto: "auto", optTimer: "timer", optSlow: "slow" }[id];
    S[k] = e.target.checked; save();
    if (id === "optZh") {
      $("#fcZh").classList.toggle("hide", !S.zh);
      renderBrowse();
    }
  });
});

function mark(en, good) {
  if (!S.prog || typeof S.prog !== "object") S.prog = {};
  var p = S.prog[en] || (S.prog[en] = { ok: 0, no: 0 });
  if (!p || typeof p !== "object") p = S.prog[en] = { ok: 0, no: 0 };
  if (good) p.ok++; else p.no++;
  save();
}
$("#roundSeg").addEventListener("click", function (e) {
  var b = e.target.closest ? e.target.closest("button[data-n]") : null;
  if (!b) return;
  ROUND = parseInt(b.dataset.n, 10);
  S.n = ROUND;
  save();
  renderHome();
  toast("每轮 " + ROUND + " 题");
});

function weakList() {
  return WORDS.filter(function (w) {
    var p = S.prog[w.en];
    return p && p.no > p.ok;
  }).map(function (w) { return w.en; });
}

/* ---------------- 闪卡 ---------------- */
var fcOrder = [], fcCat = "全部", fcIdx = 0;

function startFlash() {
  fcCat = "全部";
  rebuildFlash();
  show("flash");
  speakCard();
}
function catList() { return ["全部"].concat(D.categories); }
function rebuildFlash() {
  var src = WORDS.filter(function (w) { return fcCat === "全部" || w.cat === fcCat; });
  fcOrder = shuffle(src.map(function (w) { return w.en; }));
  fcIdx = 0;
  drawCats();
  paintCard();
}
function drawCats() {
  var box = $("#fcCats");
  box.innerHTML = "";
  catList().forEach(function (c) {
    var b = document.createElement("button");
    b.className = "cat" + (c === fcCat ? " on" : "");
    b.textContent = c;
    b.addEventListener("click", function () {
      fcCat = c;
      if (CUR === "flash") { rebuildFlash(); speakCard(); }
    });
    box.appendChild(b);
  });
}
function paintCard() {
  var w = BY_EN[fcOrder[fcIdx]];
  if (!w) return;
  var card = $("#flashCard");
  card.classList.remove("flip");
  $("#fcImg").src = w.img;
  $("#fcImg2").src = w.img;
  $("#fcEn").textContent = w.en;
  $("#fcZh").textContent = w.zh;
  $("#fcZh").classList.toggle("hide", !S.zh);
  $("#flashCount").textContent = (fcIdx + 1) + "/" + fcOrder.length;
  $("#flashBar").style.width = ((fcIdx + 1) / fcOrder.length * 100) + "%";
}
function speakCard() {
  var w = BY_EN[fcOrder[fcIdx]];
  if (w) speakWord(w);
}
$("#flashCard").addEventListener("click", function () { this.classList.toggle("flip"); });
$("#fcSpeak").addEventListener("click", function (e) { e.stopPropagation(); speakCard(); });
$("#fcSpeak2").addEventListener("click", function (e) { e.stopPropagation(); speakCard(); });
$("#fcNext").addEventListener("click", function () {
  fcIdx = (fcIdx + 1) % fcOrder.length; paintCard(); speakCard();
});
$("#fcPrev").addEventListener("click", function () {
  fcIdx = (fcIdx - 1 + fcOrder.length) % fcOrder.length; paintCard(); speakCard();
});
$("#fcShuffle").addEventListener("click", function () {
  var cur = fcOrder[fcIdx];
  fcOrder = shuffle(fcOrder);
  fcIdx = fcOrder.indexOf(cur);
  paintCard();
  toast("已打乱顺序");
});

/* ---------------- 闯关 ---------------- */
var Q = null;

var ROUND = 10;      // questions per round; see the 每轮题数 selector on the home page
var LIMIT = 60;      // countdown seconds
(function () {
  var saved = parseInt(S.n, 10);
  if (saved === 10 || saved === 20 || saved === 30) ROUND = saved;
  var qn = parseInt((location.search.match(/[?&]n=(\d+)/) || [])[1], 10);
  if (qn > 0) ROUND = Math.min(qn, 200);
})();

function start(mode) {
  if (mode === "flash") return startFlash();
  var pool = shuffle(WORD_POOL.slice());   // 每轮随机出题
  // 章节池太小(eg 数字 3 词 / 餐具 4 词) → 从全词表 WORDS 借词凑齐 ≥4 个不同干扰项,避免选项重复
  while (pool.length < 4 && WORDS.length > 0) {
    var extras = WORDS.filter(function (x) { return !pool.some(function (p) { return p.en === x.en; }); });
    if (!extras.length) break;
    pool = pool.concat(extras);
  }
  Q = {
    mode: mode,
    pool: pool,
    i: 0, right: 0, wrong: [], score: 0, streak: 0,
    left: LIMIT, timer: null, locked: false, wrongs: []
  };
  show("quiz");
  nextQ();
}

function nextQ() {
  if (Q.i >= ROUND) return finish();
  cancelAutoSpeak();
  clearTimeout(Q.autoT);
  /* 读音严格对应当前题目：进新题前停掉上一题残留的发音 */
  if (clip) { try { clip.pause(); } catch (e) {} }
  var pool = Q.pool;
  var w = pool[Q.i % pool.length];
  // 干扰项优先同主题，更有区分度
  var same = pool.filter(function (x) { return x.cat === w.cat && x.en !== w.en; });
  var opts = pick(same.length >= 3 ? same : pool.filter(function (x) { return x.en !== w.en; }), 3);
  opts.push(w);
  opts = shuffle(opts);

  Q.cur = w; Q.opts = opts; Q.locked = false;
  Q.i++;

  $("#quizCount").textContent = Q.i + "/" + ROUND;
  $("#quizBar").style.width = (Q.i / ROUND * 100) + "%";
  $("#hudScore").textContent = "⭐ " + Q.score;
  $("#hudStreak").textContent = "🔥 " + Q.streak;
  $("#verdict").classList.remove("show");

  var p = $("#quizPrompt");
  p.innerHTML = "";
  var sub = document.createElement("div");
  sub.className = "q-sub";
  sub.textContent = "听一听，选出对应的图片";
  if (Q.mode === "audio2pic") {
    var b = document.createElement("button");
    b.className = "big-speak"; b.textContent = "🔊"; b.id = "bigSpeak";
    b.addEventListener("click", function () { speakWord(Q.cur); });
    p.appendChild(b); p.appendChild(sub);
    /* 自动出题：音频就是题面，进题必播（点喇叭可重听） */
    speakPending(Q.cur);
  } else if (Q.mode === "pic2word") {
    var im = document.createElement("img"); im.src = w.img; im.alt = "";
    p.appendChild(im); sub.textContent = "这张图是哪个单词？";
    p.appendChild(sub);
  } else {
    var en = document.createElement("div"); en.className = "q-en"; en.textContent = w.en;
    p.appendChild(en); sub.textContent = "选出对应的图片";
    p.appendChild(sub);
    if (S.auto) speakPending(w);
  }

  var grid = $("#quizOpts");
  grid.innerHTML = "";
  opts.forEach(function (o) {
    var c = document.createElement("button");
    c.className = "opt-card";
    // 看图选词 must offer WORDS only - showing the picture next to the word
    // would let the child match pictures without reading anything.
    if (Q.mode === "pic2word") {
      var lab = document.createElement("div"); lab.className = "w"; lab.textContent = o.en;
      c.appendChild(lab);
      var z = document.createElement("div"); z.className = "z"; z.textContent = o.zh;
      if (!S.zh) z.style.visibility = "hidden";
      c.appendChild(z);
    } else {
      var img = document.createElement("img");
      img.src = o.img; img.alt = ""; img.loading = "eager";
      c.appendChild(img);
    }
    c.addEventListener("click", function () { answer(o, c); });
    grid.appendChild(c);
  });

  if (S.timer) { Q.left = LIMIT; tickTime(); }
  else { $("#hudTimer").textContent = "⏱ 计时关"; $("#hudTimer").classList.remove("low"); }
}

function tickTime() {
  clearInterval(Q.timer);
  var el = $("#hudTimer");
  el.textContent = "⏱ " + Q.left;
  el.classList.toggle("low", Q.left <= 10);
  Q.timer = setInterval(function () {
    Q.left--;
    el.textContent = "⏱ " + Math.max(0, Q.left);
    el.classList.toggle("low", Q.left <= 10);
    if (Q.left <= 0) { clearInterval(Q.timer); if (!Q.locked) showVerdict(null, true); }
  }, 1000);
}

function answer(o, node) {
  if (Q.locked) return;
  Q.locked = true;
  clearInterval(Q.timer);
  cancelAutoSpeak();          // a queued auto-read must not cut this answer off
  var right = o.en === Q.cur.en;
  var nodes = $$(".opt-card");
  nodes.forEach(function (n, i) {
    if (Q.opts[i].en === Q.cur.en) n.classList.add("right");
    else if (n === node) n.classList.add("wrong");
    else n.classList.add("dim");
  });
  mark(Q.cur.en, right);
  if (right) {
    Q.right++; Q.streak++;
    Q.score += 10 + Math.max(0, Q.streak - 1) * 2 + (S.timer ? Math.round(Q.left / 6) : 0);
    speakWord(Q.cur);
  } else {
    Q.streak = 0;
    Q.wrongs.push(Q.cur.en);
    /* 听音选图答错：把正确读音再放一遍，听完自动进下一题 */
    if (Q.mode === "audio2pic") speakPending(Q.cur);
  }
  $("#hudScore").textContent = "⭐ " + Q.score;
  $("#hudStreak").textContent = "🔥 " + Q.streak;
  showVerdict(right, false);
}

function showVerdict(right, timeout) {
  var v = $("#verdict");
  $(".v-emoji", v).textContent = timeout ? "⏰" : (right ? "🎉" : "🤔");
  $(".v-text", v).innerHTML = timeout
    ? "时间到啦！<small>看一下正确答案</small>"
    : (right ? "答对啦！<small>" + esc(Q.cur.en) + (S.zh ? " · " + esc(Q.cur.zh) : "") + "</small>"
             : "正确答案是 " + esc(Q.cur.en) + (S.zh ? "<small>" + esc(Q.cur.zh) + "</small>" : ""));
  $("#vNext").textContent = (Q.i >= ROUND) ? "看成绩单" : "继续";
  v.classList.add("show");
  /* 听音选图：自动出题——答完自动进下一题（答错/超时多停留，留时间看正确答案） */
  clearTimeout(Q.autoT);
  if (Q.mode === "audio2pic") {
    Q.autoT = setTimeout(function () {
      $("#verdict").classList.remove("show");
      nextQ();
    }, right === true ? 1400 : 2500);
  }
}
$("#vNext").addEventListener("click", function () {
  clearTimeout(Q.autoT);
  $("#verdict").classList.remove("show");
  nextQ();
});
$("#vQuit").addEventListener("click", function () {
  clearTimeout(Q.autoT);
  clearInterval(Q.timer);
  $("#verdict").classList.remove("show");
  show("home");
  renderHome();
});

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}

function finish() {
  clearInterval(Q.timer);
  cancelAutoSpeak();
  clearTimeout(Q.autoT);
  var used = LIMIT - Q.left;
  var rate = Q.i ? Math.round(Q.right / Q.i * 100) : 0;
  $("#rScore").textContent = Q.score;
  $("#rMedal").textContent = rate >= 90 ? "🏆" : rate >= 70 ? "🥈" : rate >= 50 ? "🥉" : "💪";
  $("#rRate").textContent = "正确率 " + rate + "%";
  $("#rTime").textContent = used;
  $("#rRight").textContent = Q.right;
  $("#rWrong").textContent = Q.i - Q.right;

  var box = $("#rWrongBox"), list = $("#rWrongList");
  list.innerHTML = "";
  var uniq = [];
  Q.wrongs.forEach(function (e) { if (uniq.indexOf(e) < 0) uniq.push(e); });
  if (!uniq.length) { box.hidden = true; }
  else {
    box.hidden = false;
    uniq.forEach(function (en) {
      var w = BY_EN[en];
      var d = document.createElement("div"); d.className = "wrong-item";
      d.innerHTML = '<img src="' + w.img + '" alt=""><div>' + esc(w.en) + "</div>";
      d.addEventListener("click", function () { speakWord(w); });
      list.appendChild(d);
    });
  }
  show("result");
  renderHome();
}
$("#btnAgain").addEventListener("click", function () { start(Q.mode); });

/* ---------------- 全部单词 / 错题本 ---------------- */
var browseCat = "全部";
function renderBrowse() {
  var list = WORDS.filter(function (w) { return browseCat === "全部" || w.cat === browseCat; });
  var grid = $("#wordGrid");
  grid.innerHTML = "";
  list.forEach(function (w) {
    var p = S.prog[w.en];
    var lv = !p ? 0 : (p.no === 0 ? 2 : (p.ok > p.no ? 1 : 0));
    var d = document.createElement("div");
    d.className = "wcell lv" + lv;
    d.innerHTML = '<img src="' + w.img + '" alt="" loading="lazy">' +
      '<div class="e">' + esc(w.en) + '</div>' +
      '<div class="z' + (S.zh ? "" : " hide") + '">' + esc(w.zh) + "</div>";
    d.addEventListener("click", function () { speakWord(w); });
    grid.appendChild(d);
  });
  $("#browseCount").textContent = list.length + " 词";

  var cats = $("#browseCats");
  cats.innerHTML = "";
  catList().forEach(function (c) {
    var b = document.createElement("button");
    b.className = "cat" + (c === browseCat ? " on" : "");
    b.textContent = c;
    b.addEventListener("click", function () { browseCat = c; renderBrowse(); });
    cats.appendChild(b);
  });
}
function renderWeak() {
  var en = weakList();
  var grid = $("#weakGrid");
  grid.innerHTML = "";
  en.forEach(function (k) {
    var w = BY_EN[k];
    var d = document.createElement("div");
    d.className = "wcell";
    d.innerHTML = '<img src="' + w.img + '" alt=""><div class="e">' + esc(w.en) + "</div>" +
      '<div class="z' + (S.zh ? "" : " hide") + '">' + esc(w.zh) + "</div>";
    d.addEventListener("click", function () { speakWord(w); });
    grid.appendChild(d);
  });
  $("#weakCount").textContent = en.length + " 词";
  if (!en.length) {
    grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:#8A7360;padding:40px 10px">' +
      "还没有错题，继续保持！</p>";
  }
}
$("#btnBrowse").addEventListener("click", function () { browseCat = "全部"; renderBrowse(); show("browse"); });
$("#btnWeak").addEventListener("click", function () { renderWeak(); show("weak"); });
$("#btnReset").addEventListener("click", function () {
  if (!confirm("确定清空所有练习记录吗？")) return;
  S.prog = {}; save(); renderHome(); toast("已清空");
});

/* ---------------- 音色选择 ---------------- */
function renderVoices() {
  var sel = $("#voiceSel"), tip = $("#voiceTip"), note = $("#clipNote");
  if (!note) return;
  var withClip = WORDS.filter(function (w) { return !!w.audio; }).length;
  if (withClip === WORDS.length) {
    note.innerHTML = "<b>" + WORDS.length + " 个词全部收录词典发音</b>：牛津学习者词典美音真人录音为主，" +
      "牛津没有的短语词条用有道词典发音兜底（逐词清单见 audio-sources.json）。" +
      "点哪个播哪个，发音与词典一致，断网也能用。";
  } else if (withClip) {
    note.innerHTML = "<b>" + withClip + "/" + WORDS.length + " 个词内置录音</b>；" +
      "其余 " + (WORDS.length - withClip) + " 个词会临时调用浏览器发音。";
  } else {
    note.textContent = "这个文件夹里没有音频，改用浏览器发音。";
  }

  if (!hasTTS) { $("#voicePanel").hidden = true; return; }
  var list = enVoices();
  if (!list.length) {
    sel.innerHTML = "<option>（本机没有英文语音）</option>";
    sel.disabled = true;
    $("#btnTestVoice").disabled = true;
    tip.textContent = "备用方案不可用：本机没装英文语音。已内置录音的词不受影响。";
    return;
  }
  sel.disabled = false;
  $("#btnTestVoice").disabled = false;
  sel.innerHTML = "";
  var cur = pickVoice();
  list.slice().sort(function (x, y) { return voiceScore(y) - voiceScore(x); }).forEach(function (v) {
    var o = document.createElement("option");
    o.value = v.name;
    o.textContent = v.name + "（" + v.lang + (v.localService ? " · 本地" : " · 需联网") + "）";
    if (cur && v.name === cur.name) o.selected = true;
    sel.appendChild(o);
  });
  tip.textContent = "备用音色：" + (cur ? cur.name : "默认") +
    "，仅在没有录音时兜底。标「本地」的断网也能用。";
}
$("#voiceSel").addEventListener("change", function (e) {
  S.voice = e.target.value; save();
  speakWord(BY_EN["honey"], true);
});
$("#btnTestVoice").addEventListener("click", function () {
  speakWord(BY_EN["honey"], true);
  toast("这是 honey 的读音");
});

/* =========================================================================
   考试模式（single-format 看图选词 · 每题 30s · 自动评分）
   ========================================================================= */
var EXAM = {
  n: 20,           // 题数
  timePerQ: 30,    // 每题限时（秒）
  list: [],         // 抽到的题目（shuffled）
  i: 0,             // 当前题号 0-based
  answers: [],      // {wId, picked, isRight, timeMs, status}
  startQ: 0,        // 本场开始时刻（ms）
  qStart: 0,        // 当前题开始时刻
  qLeft: 30,        // 当前题剩余秒
  timer: null,      // 每 100ms 的倒计时 setInterval
  locked: false,    // 当前题答题后锁定
  flashTO: null,
};

function clearExamTimer() {
  if (EXAM.timer) { clearInterval(EXAM.timer); EXAM.timer = null; }
  if (EXAM.flashTO) { clearTimeout(EXAM.flashTO); EXAM.flashTO = null; }
}

function shuffle(a) {
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function renderExamConfig() {
  // 默认 N：上次没记，固定 20，segmented control 由 HTML 默认 on
  $$("#examN button").forEach(function (b) {
    var n = b.dataset.n;
    var val = (n === "all") ? "all" : parseInt(n, 10);
    b.classList.toggle("on", val === EXAM.n);
  });
}

function pickExamList(n) {
  var pool = WORDS.slice();
  shuffle(pool);
  if (n === "all" || n >= pool.length) return pool;
  return pool.slice(0, n);
}

function pickExamOptions(correctW) {
  // 3 个 distractor + 正确选项 = 4 个，再打乱
  var pool = WORDS.filter(function (w) { return w.id !== correctW.id; });
  shuffle(pool);
  var opts = [correctW].concat(pool.slice(0, 3));
  shuffle(opts);
  return opts;
}

function startExam() {
  // 读 config
  var n = EXAM.n;
  EXAM.list = pickExamList(n);
  EXAM.n = EXAM.list.length;
  EXAM.i = 0;
  EXAM.answers = [];
  EXAM.startQ = Date.now();
  clearExamTimer();
  runPreCountdown(function () { renderExamPlay(); });
}

function runPreCountdown(done) {
  show("exam-pre");
  var n = 3;
  var elN = $("#examPreNum");
  elN.textContent = String(n);
  // re-trigger animation
  elN.style.animation = "none";
  void elN.offsetWidth;
  elN.style.animation = "prePulse 1s ease-out";
  var t = setInterval(function () {
    n--;
    if (n <= 0) { clearInterval(t); setTimeout(done, 250); return; }
    elN.textContent = String(n);
    elN.style.animation = "none";
    void elN.offsetWidth;
    elN.style.animation = "prePulse 1s ease-out";
  }, 1000);
  // auto-press shouldn't fire; if user clicks back during countdown, we just abandon
}

function renderExamPlay() {
  show("exam-play");
  var w = EXAM.list[EXAM.i];
  // 图片 + 4 词
  var img = $("#examImg");
  img.src = w.img;
  img.alt = w.en;
  var opts = pickExamOptions(w);
  var box = $("#examOpts");
  box.innerHTML = "";
  opts.forEach(function (o) {
    var c = document.createElement("button");
    c.className = "opt-card";
    c.innerHTML = '<span class="w">' + esc(o.en) + '</span>' +
      ((S.zh) ? '<span class="z">' + esc(o.zh) + '</span>' : "");
    c.dataset.id = o.id;
    c.addEventListener("click", function () { examAnswer(parseInt(c.dataset.id, 10), c); });
    box.appendChild(c);
  });
  // 进度 / 倒计时
  EXAM.qStart = Date.now();
  EXAM.qLeft = EXAM.timePerQ;
  EXAM.locked = false;
  $("#examCount").textContent = (EXAM.i + 1) + " / " + EXAM.list.length;
  $("#examBar").style.width = ((EXAM.i) / EXAM.list.length * 100) + "%";
  // 数字 + 圆环
  $("#examSecText").textContent = EXAM.timePerQ;
  var ring = $("#examRingFg");
  ring.classList.remove("low");
  var C = 2 * Math.PI * 44;
  ring.style.strokeDasharray = C + "";
  ring.style.strokeDashoffset = "0";
  clearExamTimer();
  var lastT = Date.now();
  EXAM.timer = setInterval(function () {
    if (EXAM.locked) return;
    var now = Date.now();
    var dt = (now - lastT) / 1000;
    lastT = now;
    EXAM.qLeft -= dt;
    if (EXAM.qLeft <= 0) {
      EXAM.qLeft = 0;
      tickExamUI(0, true);
      examAnswer(null, null);
      return;
    }
    tickExamUI(EXAM.qLeft, false);
  }, 100);
}

function tickExamUI(leftSec, low) {
  $("#examSecText").textContent = Math.max(0, Math.ceil(leftSec));
  var C = 2 * Math.PI * 44;
  var pct = leftSec / EXAM.timePerQ;
  $("#examRingFg").style.strokeDashoffset = (C * (1 - pct)) + "";
  if (low) $("#examRingFg").classList.add("low");
}

function showExamFlash(isRight, pickedW, correctW) {
  var el = document.createElement("div");
  el.className = "exam-flash" + (isRight ? "" : " bad");
  el.innerHTML = (isRight ? "✔" : "✘") +
    '<div class="ft-en">' + esc(correctW.en) + '</div>';
  $("#scr-exam-play").appendChild(el);
  // 1.5s 后清
  setTimeout(function () {
    if (el.parentNode) el.parentNode.removeChild(el);
  }, 1500);
}

function lockOptCards(pickedW, correctW, isRight) {
  $$("#examOpts .opt-card").forEach(function (c) {
    var id = parseInt(c.dataset.id, 10);
    c.classList.add("locked");
    if (id === correctW.id) c.classList.add("correct");
    if (pickedW && id === pickedW.id && !isRight) c.classList.add("wrong");
    if (!pickedW && id === correctW.id) c.classList.add("timeout");
  });
}

function examAnswer(pickedId, pickedNode) {
  if (EXAM.locked) return;
  EXAM.locked = true;
  if (EXAM.timer) { clearInterval(EXAM.timer); EXAM.timer = null; }
  var w = EXAM.list[EXAM.i];
  var isRight = pickedId !== null && pickedId === w.id;
  var picked = pickedId ? WORD_BY_ID[pickedId] : null;
  EXAM.answers.push({
    wId: w.id, pickedId: pickedId || null,
    isRight: isRight, timeMs: Date.now() - EXAM.qStart,
    status: pickedId === null ? "timeout" : (isRight ? "right" : "wrong"),
  });
  lockOptCards(picked, w, isRight);
  showExamFlash(isRight, picked, w);
  EXAM.flashTO = setTimeout(function () {
    EXAM.i++;
    if (EXAM.i >= EXAM.list.length) finishExam();
    else renderExamPlay();
  }, 1500);
}

function finishExam() {
  clearExamTimer();
  var total = EXAM.answers.length;
  var right = EXAM.answers.filter(function (a) { return a.isRight; }).length;
  var rate = total ? right / total : 0;
  var grade = rate >= 0.9 ? "A" : rate >= 0.8 ? "B" : rate >= 0.6 ? "C" : "D";
  var comment = grade === "A" ? "优秀！可以挑战更高难度" :
                grade === "B" ? "不错！把错题再过一遍就稳了" :
                grade === "C" ? "中等，错的几个词多花点时间" :
                                 "需要多练习，别灰心哦";
  var usedSec = Math.round((Date.now() - EXAM.startQ) / 1000);
  EXAM.result = { total: total, right: right, wrong: total - right, rate: rate, grade: grade,
                  comment: comment, usedSec: usedSec };

  // render
  $("#examGradeLetter").textContent = grade;
  var card = $("#examGradeLetter");
  card.classList.remove("A", "B", "C", "D");
  card.classList.add(grade);
  $("#examRateLine").textContent = right + " / " + total + "  ·  " + Math.round(rate * 100) + "%";
  $("#examComment").textContent = comment;
  $("#examCorrectN").textContent = right;
  $("#examWrongN").textContent = total - right;
  $("#examTimeN").textContent = usedSec;
  show("exam-result");
}

function renderExamReview() {
  var wrong = EXAM.answers.filter(function (a) { return !a.isRight; });
  var list = $("#examReviewList");
  list.innerHTML = "";
  $("#examReviewCount").textContent = wrong.length + " / " + EXAM.answers.length;
  if (!wrong.length) {
    var ok = document.createElement("div");
    ok.style.cssText = "padding:30px;text-align:center;color:var(--ink2);font-size:14px";
    ok.textContent = "全对！没有错题 🎉";
    list.appendChild(ok);
    return;
  }
  wrong.forEach(function (a) {
    var w = WORD_BY_ID[a.wId];
    var picked = a.pickedId ? WORD_BY_ID[a.pickedId] : null;
    var item = document.createElement("div");
    item.className = "exam-rev-item";
    item.innerHTML =
      '<img src="' + esc(w.img) + '" alt="">' +
      '<div class="exam-rev-info">' +
        '<div class="exam-rev-en">' + esc(w.en) + '</div>' +
        '<div class="exam-rev-pick">你的答案：<b>' + (picked ? esc(picked.en) : "超时未答") + '</b></div>' +
        '<div class="exam-rev-pick" style="color:var(--ink2)">正确：' + esc(w.zh) + '</div>' +
      '</div>' +
      '<button class="speak" aria-label="朗读">🔊</button>';
    item.querySelector(".speak").addEventListener("click", function (e) {
      e.stopPropagation();
      clearTimeout(autoTimer); clearTimeout(goTimer);
      if (playClip(w)) return;
      ttsSpeak(say(w));
    });
    list.appendChild(item);
  });
}

/* 考试操作挂线 */
$("#btnStartExam").addEventListener("click", function () { startExam(); });
$("#btnExamAgain").addEventListener("click", function () { clearExamTimer(); EXAM.answers = []; EXAM.i = 0; show("exam-config"); renderExamConfig(); });
$("#btnExamReview").addEventListener("click", function () { renderExamReview(); show("exam-review"); });

/* 考试 N 段控件 */
$$("#examN button").forEach(function (b) {
  b.addEventListener("click", function () {
    var n = b.dataset.n;
    EXAM.n = (n === "all") ? "all" : parseInt(n, 10);
    $$("#examN button").forEach(function (x) { x.classList.remove("on"); });
    b.classList.add("on");
  });
});
/* 默认选中 20 题 */
EXAM.n = 20;

/* ---------------- 启动 ---------------- */
renderHome();
renderVoices();
if (!hasTTS) toast("当前浏览器不支持朗读，仅看图练习");
/* debug hook - handy when a browser misbehaves with speech */
window.__wk = {
  speakWord: speakWord, ttsSpeak: ttsSpeak,
  pickVoice: pickVoice, enVoices: enVoices,
  voices: function () { return voices; },
  ready: function () { return voicesReady; },
  haveClips: function () { return HAVE_CLIPS; },
  playClip: function (en) { return playClip(BY_EN[en]); },
  clipInfo: function () {
    return { perWordClips: true, brokenCount: Object.keys(clipBroken).length };
  },
  examState: function () {
    return {
      n: EXAM.n, listLen: EXAM.list.length, i: EXAM.i,
      locked: EXAM.locked, qLeft: EXAM.qLeft,
      answered: EXAM.answers.length, lastResult: EXAM.result,
    };
  },
  startExam: startExam,
  examAnswer: examAnswer
};
})();
