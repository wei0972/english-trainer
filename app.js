import { buildSession, finalConsonant, freshState, grade, localDateKey, maskSentence, uniqueChoices, validateProgress } from './srs.js?v=20261030135844';
import { finishListening, isListening, matchResult, normalize, recognitionSupported, startListening, stopListening, stressKK, tipsForKK } from './pronounce.js?v=20261030135844';

const app = document.querySelector('#app');
const STORAGE_KEY = 'et_progress_v1';
const PREF_KEY = 'et_preferences_v1';
const icons = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.8c0-.8.9-1.3 1.6-.9l10 6.2a1 1 0 0 1 0 1.7l-10 6.2c-.7.4-1.6-.1-1.6-.9V5.8Z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3.2 3.2 0 0 0 3.2-3.2V5.2a3.2 3.2 0 0 0-6.4 0v5.6A3.2 3.2 0 0 0 12 14Zm5.6-3.2a1 1 0 1 1 2 0 7.6 7.6 0 0 1-6.6 7.5V21h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2.7a7.6 7.6 0 0 1-6.6-7.5 1 1 0 1 1 2 0 5.6 5.6 0 0 0 11.2 0Z"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m19.4 13.5 1.4 1.1-1.4 2.4-1.7-.7a7.8 7.8 0 0 1-1.6.9l-.3 1.8h-2.8l-.3-1.8a7.8 7.8 0 0 1-1.6-.9l-1.7.7-1.4-2.4 1.4-1.1a7.3 7.3 0 0 1 0-1.9L6 10.5l1.4-2.4 1.7.7a7.8 7.8 0 0 1 1.6-.9l.3-1.8h2.8l.3 1.8a7.8 7.8 0 0 1 1.6.9l1.7-.7 1.4 2.4-1.4 1.1a7.3 7.3 0 0 1 0 1.9ZM12 14.7a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z"/></svg>',
};
const escapeHTML = (value = '') => String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const safeRead = (key, fallback) => { try { const value = JSON.parse(localStorage.getItem(key)); return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback; } catch { return fallback; } };
const safeWrite = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };
const defaults = { category: 'all', mode: 'mixed', dailyLimit: 8, speed: 0.85, autoplay: true };
let prefs = { ...defaults, ...safeRead(PREF_KEY, {}) };
let progress = validateProgress(safeRead(STORAGE_KEY, {}));
let words = [];
let session = null;
let current = null;
let currentMode = 'mixed';
let currentQuestion = 'card';
let answerShown = false;
let sentenceTranslationShown = false;
let questionDone = false;
let speechAttempts = 0;
let rightCount = 0;
let answeredCount = 0;
let newSeen = new Set();
let missed = new Set();
let sentencesUsed = new Map();
let sharedAudio = null;
let audioTarget = null;
let audioUnlocked = false;
let voices = [];
let notice = '';
let micFeedback = null;
let recognitionToken = 0;
let micAttempts = 0;
let attemptResolved = true;
const debugMode = /[?&]debug=1\b/.test(location.search);
const micLog = [];
let forceExtraNew = false;
let forceRetryToday = false;

if ('speechSynthesis' in window) {
  voices = speechSynthesis.getVoices();
  speechSynthesis.addEventListener('voiceschanged', () => { voices = speechSynthesis.getVoices(); });
}

function countTodayNew() {
  const today = localDateKey();
  return Object.values(progress).filter((state) => state.learnedOn === today).length;
}
function categoryWords() { return words.filter((word) => (prefs.category === 'all' || word.category.includes(prefs.category))); }
function learnedCount() { return categoryWords().filter((word) => Boolean(progress[word.word]?.learnedOn)).length; }
function dueCount() { const now = Date.now(); return words.filter((word) => progress[word.word]?.learnedOn && (progress[word.word].due ?? 0) <= now && (prefs.category === 'all' || word.category.includes(prefs.category))).length; }
function savePrefs() { safeWrite(PREF_KEY, prefs); }
function saveProgress() { if (!safeWrite(STORAGE_KEY, progress)) notice = '此瀏覽器目前無法儲存進度；離開頁面後資料可能不會保留。'; }
function initAudioUnlock() {
  if (audioUnlocked || !sharedAudio) return;
  audioUnlocked = true;
  document.removeEventListener('pointerdown', initAudioUnlock);
  sharedAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
  sharedAudio.muted = true;
  // A word may start playing before this promise settles (autoplay on the first question); only undo the silent clip.
  const stillSilent = () => sharedAudio.src.startsWith('data:audio/wav');
  sharedAudio.play().then(() => { if (stillSilent()) { sharedAudio.pause(); sharedAudio.currentTime = 0; sharedAudio.removeAttribute('src'); } sharedAudio.muted = false; }).catch(() => { if (stillSilent()) sharedAudio.removeAttribute('src'); sharedAudio.muted = false; });
}

// iOS keeps the page in its "record" audio route after the mic is used, which plays through the quiet earpiece
// path. The Audio Session API (iOS 16.4+) lets us switch back to normal playback; older iOS simply ignores this.
function setAudioSession(type) {
  try { if (navigator.audioSession && navigator.audioSession.type !== type) navigator.audioSession.type = type; } catch { /* unsupported */ }
}
setAudioSession('playback');
document.addEventListener('pointerdown', initAudioUnlock);

function makeSpeech(text, rate = 1) {
  if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) return false;
  setAudioSession('playback');
  if (sharedAudio) sharedAudio.pause();
  const wasBusy = speechSynthesis.speaking || speechSynthesis.pending;
  if (wasBusy) speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US'; utterance.rate = rate;
  utterance.onerror = (event) => { if (!['canceled', 'interrupted'].includes(event.error)) { notice = '語音播放失敗，請再試一次。'; renderCurrentQuestion(); } };
  const preferred = ['samantha', 'ava', 'allison', 'enhanced', 'premium', 'google us english'];
  const englishVoices = voices.filter((voice) => /^en(-|_)/i.test(voice.lang));
  const usVoices = englishVoices.filter((voice) => /^en[-_]us$/i.test(voice.lang));
  utterance.voice = preferred.map((needle) => usVoices.find((voice) => voice.name.toLowerCase().includes(needle))).find(Boolean) || usVoices[0] || englishVoices[0] || null;
  setTimeout(() => { try { speechSynthesis.speak(utterance); } catch { notice = '語音播放失敗，請再試一次。'; renderCurrentQuestion(); } }, wasBusy ? 20 : 0);
  return true;
}
function playWord(word, forceSpeech = false) {
  if (!forceSpeech && word.audio?.file && sharedAudio) {
    setAudioSession('playback');
    audioTarget = word;
    if ('speechSynthesis' in window && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
    sharedAudio.src = word.audio.file;
    sharedAudio.currentTime = 0;
    sharedAudio.play().catch((error) => { if (['NotAllowedError', 'NotSupportedError', 'EncodingError'].includes(error.name)) makeSpeech(word.word); else if (error.name !== 'AbortError') { notice = '播放失敗，請再試一次。'; renderCurrentQuestion(); } });
    return true;
  }
  return makeSpeech(word.word);
}
function sentenceFor(word, requireForm = false) {
  const used = sentencesUsed.get(word.word) ?? word.lastSentence ?? progress[word.word]?.lastSentence ?? -1;
  let options = word.sentences.map((_, index) => index).filter((index) => index !== used);
  if (!options.length) options = word.sentences.map((_, index) => index);
  if (requireForm) options = options.filter((index) => maskSentence(word.sentences[index].en, word.sentences[index].form));
  if (!options.length && requireForm) return sentenceFor(word, false);
  const index = options[Math.floor(Math.random() * options.length)];
  sentencesUsed.set(word.word, index);
  const state = { ...freshState(), ...progress[word.word], lastSentence: index };
  progress[word.word] = state;
  saveProgress();
  return { ...word.sentences[index], index };
}
function svgButton(kind, label, attrs = '') { return `<button class="icon-button" type="button" aria-label="${escapeHTML(label)}" title="${escapeHTML(label)}" ${attrs}>${icons[kind]}</button>`; }

function renderMicLog() {
  if (!debugMode || !micLog.length) return '';
  return `<pre class="mic-log">${escapeHTML(micLog.slice(-12).join('\n'))}</pre>`;
}

function renderMicFeedback() {
  if (!micFeedback) return renderMicLog();
  // Attempt number makes a repeated identical result visibly a new judgment.
  const attempt = micFeedback.attempt ? `第 ${micFeedback.attempt} 次：` : '';
  if (micFeedback.text) return `<div class="feedback ${micFeedback.bad ? 'bad' : ''}">${escapeHTML(attempt + micFeedback.text)}</div>${renderMicLog()}`;
  const { result, kk, confidence = '', cue = '' } = micFeedback;
  const message = result.level === 'clear' ? `很清楚！系統一次就聽懂了 ${confidence}` : result.level === 'close' ? `接近，但系統不太確定。聽到：${escapeHTML(result.heard)}` : `系統聽成：${escapeHTML(result.heard || '沒有辨識到')}${cue ? `<br>${escapeHTML(cue)}` : ''}`;
  return `<div class="kk">[${stressKK(kk)}]</div><div class="feedback ${result.level === 'miss' ? 'bad' : 'good'}">${escapeHTML(attempt)}${message}</div>${renderMicLog()}`;
}

function renderHome() {
  const cats = [['all', '全部'], ['daily', '日常'], ['travel', '旅遊'], ['food', '飲食'],
    ['senior', '高中'], ['toeic', '多益'], ['business', '商務'], ['ielts', '雅思']];
  const modes = [['mixed', '混合（推薦）'], ['card', '字卡'], ['listen', '聽音選意思'], ['speak', `看中文說英文${recognitionSupported(window) ? '' : '（此瀏覽器不支援）'}`], ['spell', '聽音拼字']];
  if (!recognitionSupported(window) && prefs.mode === 'speak') prefs.mode = 'mixed';
  const eligible = words.filter((word) => (prefs.category === 'all' || word.category.includes(prefs.category)) && !progress[word.word]?.learnedOn).length;
  // Ask the session builder itself, so the home screen never offers a start button that would do nothing.
  const noPractice = !buildSession(words, progress, { category: prefs.category, newLimit: prefs.dailyLimit, now: Date.now(), mode: prefs.mode }).total;
  const todayMisses = words.filter((word) => progress[word.word]?.lapsedOn === localDateKey() && (prefs.category === 'all' || word.category.includes(prefs.category))).length;
  app.innerHTML = `<section><p class="eyebrow">美國生活・考試・職場</p><h1 class="page-title">英文單字練習</h1><p class="intro">用短短幾分鐘，把常用單字記起來。</p>
    ${!recognitionSupported(window) ? '<p class="feedback">此瀏覽器不支援語音辨識。請使用 Safari 並在「設定 &gt; Siri」開啟聽寫。</p>' : ''}
    ${!('speechSynthesis' in window) ? '<p class="feedback">此瀏覽器不支援語音播放，練習中的播放鍵已停用。</p>' : ''}
    <div class="panel"><h2 class="section-heading">選擇單字分類</h2><div class="segmented" role="group" aria-label="單字分類">${cats.map(([value, label]) => `<button type="button" data-category="${value}" aria-pressed="${prefs.category === value}">${label}</button>`).join('')}</div></div>
    <div class="stats"><div class="stat-card"><span class="stat-value">${dueCount()}</span><span class="stat-label">待複習字</span></div><div class="stat-card"><span class="stat-value">${countTodayNew()}／${prefs.dailyLimit}</span><span class="stat-label">今日新字（已學／上限）</span></div><div class="stat-card"><span class="stat-value">${learnedCount()}<span class="stat-total">／${categoryWords().length}</span></span><span class="stat-label">已學單字</span></div></div>
    <div class="panel"><h2 class="section-heading">選擇練習方式</h2><div class="mode-grid">${modes.map(([value, label]) => `<label class="mode-option"><input type="radio" name="mode" value="${value}" ${prefs.mode === value ? 'checked' : ''} ${value === 'speak' && !recognitionSupported(window) ? 'disabled' : ''}><span>${label}</span></label>`).join('')}</div></div>
    ${noPractice ? `<div class="panel empty-state"><h2>今天的新字和複習都完成了</h2><p>${eligible ? '想多練，可以再加一批新字。' : '這個分類的字都學過了，到期的字會自動出現在複習。'}</p><div class="button-row">${eligible ? `<button class="btn btn-primary" type="button" data-action="extra-new">加練 ${prefs.dailyLimit} 個新字</button>` : ''}${todayMisses ? `<button class="btn btn-soft" type="button" data-action="retry-today">複習今天答錯的字</button>` : ''}</div></div>`
      : '<button class="btn btn-primary" type="button" data-action="start">開始練習</button>'}
    <div class="button-row"><button class="btn btn-soft" type="button" data-action="settings">${icons.gear.replace('<svg', '<svg aria-hidden="true"')}　設定</button><button class="btn btn-soft" type="button" data-action="sources">來源與授權</button></div>
    ${notice ? `<p class="feedback">${escapeHTML(notice)}</p>` : ''}</section>`;
}

function pickQuestion(entry) {
  if (entry.kind === 'new') return 'card';
  if (entry.kind === 'quiz') {
    const quizTypes = ['listen', 'spell', ...(recognitionSupported(window) ? ['speak'] : [])];
    return quizTypes[Math.floor(Math.random() * quizTypes.length)];
  }
  if (currentMode === 'card') return 'card';
  if (currentMode === 'listen') return 'listen';
  if (currentMode === 'speak') return 'speak';
  if (currentMode === 'spell') return 'spell';
  const available = ['listen', 'spell', ...(recognitionSupported(window) ? ['speak'] : []), 'card'];
  return available[Math.floor(Math.random() * available.length)];
}
function renderExerciseTop() {
  const total = Math.max(session.total, session.position + 1);
  const percent = Math.min(100, session.position / total * 100);
  return `<div class="exercise-top"><div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div><span class="progress-label">第 ${Math.min(Math.max(1, session.position), total)}／${total} 題</span><button class="end-button" type="button" data-action="end">結束</button></div>`;
}
function renderWordCard(word, reveal = true, sentence = null) {
  const disabledPlay = !('speechSynthesis' in window) ? 'disabled title="此瀏覽器不支援語音播放"' : '';
  return `<article class="word-card"><div class="word-heading"><h2 class="word">${escapeHTML(word.word)}</h2>${svgButton('play', '播放單字', `data-action="play-word" ${disabledPlay}`)}${recognitionSupported(window) ? svgButton('mic', '練習發音', 'data-action="mic"') : `<button class="icon-button" disabled aria-label="發音練習不支援">${icons.mic}</button>`}</div><div class="mic-feedback">${renderMicFeedback()}</div><p class="kk">[${stressKK(word.kk)}]</p>${reveal ? `<div class="answer-area"><p class="translation">${escapeHTML(word.gloss_zh)}</p><p class="word-meta">${escapeHTML(word.pos)}${word.other_senses?.length ? `・另有：${escapeHTML(word.other_senses.join('、'))}` : ''}</p>${word.gloss_note ? `<p class="note">${escapeHTML(word.gloss_note)}</p>` : ''}</div>` : ''}</article>${sentence ? `<div class="sentence"><div class="sentence-top"><div class="sentence-en">${escapeHTML(sentence.en)}</div>${svgButton('play', '播放例句', `data-action="play-sentence" ${disabledPlay}`)}</div><div class="sentence-zh">${sentence.zhVisible ? escapeHTML(sentence.zh) : ''}</div>${sentence.canReveal ? `<button class="btn btn-link" type="button" data-action="toggle-zh">${sentence.zhVisible ? '隱藏中譯' : '顯示中譯'}</button>` : ''}</div>` : ''}`;
}
function renderCard() {
  const word = current.word;
  const sentence = current.sentence || sentenceFor(word);
  current.sentence = sentence;
  const reveal = current.kind === 'new' || answerShown;
  const card = renderWordCard(word, reveal, { ...sentence, zhVisible: sentenceTranslationShown, canReveal: true });
  app.innerHTML = `${renderExerciseTop()}${card}${!reveal ? `<button class="btn btn-primary" type="button" data-action="reveal">看答案</button>` : `<div class="toolbar"><button class="btn" type="button" data-grade="again">不熟</button><button class="btn btn-primary" type="button" data-grade="good">認識</button></div>`}${!recognitionSupported(window) ? `<p class="small muted">請用 Safari 開啟，並在 設定 &gt; Siri 開啟聽寫。</p>` : ''}${!('speechSynthesis' in window) ? '<p class="feedback">此瀏覽器不支援語音播放，播放鍵已停用。</p>' : ''}${notice ? `<div class="feedback bad" role="status">${escapeHTML(notice)}</div>` : ''}`;
}
function otherChoices(target) {
  const category = prefs.category === 'all' ? target.category[0] : prefs.category;
  const pool = words.filter((word) => category === 'all' || word.category.includes(category));
  return uniqueChoices(target, pool).sort(() => Math.random() - .5);
}
function renderListen() {
  current.sentence ||= sentenceFor(current.word);
  const choices = current.choices ||= otherChoices(current.word);
  app.innerHTML = `${renderExerciseTop()}<div class="word-card"><div class="listen-prompt"><button class="icon-button" type="button" data-action="play-word" aria-label="播放單字" ${!('speechSynthesis' in window) ? 'disabled title="此瀏覽器不支援語音播放"' : ''}>${icons.play}</button><span>聽聽看，選出正確意思</span></div><div class="choice-list">${choices.map((word) => `<button class="choice" type="button" data-choice="${escapeHTML(word.word)}" ${questionDone ? 'disabled' : ''}>${escapeHTML(word.gloss_zh)}</button>`).join('')}</div>${!('speechSynthesis' in window) ? '<div class="feedback">此瀏覽器不支援語音播放，播放鍵已停用。</div>' : ''}${notice ? `<div class="feedback bad" role="status">${escapeHTML(notice)}</div>` : ''}</div>${questionDone ? `${renderWordCard(current.word, true, { ...current.sentence, zhVisible: true, canReveal: false })}<div class="feedback ${current.correct ? 'good' : 'bad'}">${current.correct ? '答對了！' : `正確答案是「${escapeHTML(current.word.gloss_zh)}」。`}</div><button class="btn btn-primary" type="button" data-action="next">下一題</button>` : ''}`;
  if (!questionDone && prefs.autoplay) playWord(current.word);
}
function renderSpeak() {
  const sentence = current.sentence || sentenceFor(current.word, true);
  current.sentence = sentence;
  const hiddenEn = maskSentence(sentence.en, sentence.form) || sentence.en;
  const mic = recognitionSupported(window) ? svgButton('mic', speechAttempts ? '再試一次' : '開始辨識', `data-action="mic" ${questionDone ? 'disabled' : ''}`) : `<button class="icon-button" type="button" disabled aria-label="語音辨識不支援" title="請用 Safari 開啟並啟用聽寫">${icons.mic}</button>`;
  app.innerHTML = `${renderExerciseTop()}<div class="word-card"><p class="eyebrow">看中文，說出英文</p><p class="translation">${escapeHTML(current.word.gloss_zh)}</p><p class="word-meta">${escapeHTML(current.word.pos)}</p><div class="sentence"><div class="sentence-en">${escapeHTML(hiddenEn)}</div><div class="sentence-zh">${escapeHTML(sentence.zh)}</div></div><div class="toolbar">${mic}<button class="btn" type="button" data-action="dont-know" ${questionDone ? 'disabled' : ''}>我不會</button></div><div class="mic-feedback">${renderMicFeedback()}</div>${!('speechSynthesis' in window) ? '<div class="feedback">此瀏覽器不支援語音播放，播放鍵已停用。</div>' : ''}${notice ? `<div class="feedback bad" role="status">${escapeHTML(notice)}</div>` : ''}</div>${questionDone ? `<div class="word-card">${renderWordCard(current.word, true)}<button class="btn btn-primary" type="button" data-action="next">下一題</button></div>` : !recognitionSupported(window) ? `<p class="small muted">請用 Safari 開啟，並在 設定 &gt; Siri 開啟聽寫。</p>` : ''}`;
}
function spellingDiff(target, input) {
  const expected = normalize(target); const heard = normalize(input);
  let i = 0; while (i < expected.length && expected[i] === heard[i]) i++;
  return `差異從第 ${i + 1} 個字元附近開始。`;
}
function renderSpell() {
  app.innerHTML = `${renderExerciseTop()}<div class="word-card"><div class="listen-prompt"><button class="icon-button" type="button" data-action="play-word" aria-label="播放單字" ${!('speechSynthesis' in window) ? 'disabled title="此瀏覽器不支援語音播放"' : ''}>${icons.play}</button><span>聽發音，再輸入單字</span></div><form data-form="spell"><label class="eyebrow" for="spelling">英文拼字</label><input id="spelling" class="text-answer" name="spelling" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off" ${questionDone ? 'disabled' : ''}><button class="btn btn-primary" type="submit" style="margin-top:10px" ${questionDone ? 'disabled' : ''}>送出答案</button></form>${!('speechSynthesis' in window) ? '<div class="feedback">此瀏覽器不支援語音播放，播放鍵已停用。</div>' : ''}${notice ? `<div class="feedback bad" role="status">${escapeHTML(notice)}</div>` : ''}${questionDone ? `<div class="feedback ${current.correct ? 'good' : 'bad'}">${current.correct ? '拼對了！' : `${current.nearHyphen ? '接近，空格或連字號和標準拼法不同。' : ''}正確拼法：<strong>${escapeHTML(current.word.word)}</strong><br>${escapeHTML(spellingDiff(current.word.word, current.input))}`}</div><button class="btn btn-primary" type="button" data-action="next">下一題</button>` : ''}</div>`;
  if (!questionDone && prefs.autoplay) playWord(current.word);
}
function renderQuestion() {
  stopListening(); recognitionToken++; micFeedback = null; notice = ''; answerShown = false; sentenceTranslationShown = false; questionDone = false; speechAttempts = 0; micAttempts = 0; attemptResolved = true; current.sentence = null;
  currentQuestion = pickQuestion(current);
  if (current.kind === 'new') newSeen.add(current.word.word);
  if (currentQuestion === 'card') renderCard();
  if (currentQuestion === 'listen') renderListen();
  if (currentQuestion === 'speak') renderSpeak();
  if (currentQuestion === 'spell') renderSpell();
}
function renderCurrentQuestion() {
  if (currentQuestion === 'card') renderCard();
  else if (currentQuestion === 'listen') renderListen();
  else if (currentQuestion === 'speak') renderSpeak();
  else renderSpell();
}
function nextQuestion() {
  stopListening(); recognitionToken++; micFeedback = null; notice = '';
  const entry = session.next();
  if (!entry) { renderResults(); return; }
  current = entry;
  renderQuestion();
}
function setGrade(word, quality) {
  const previous = progress[word.word] || freshState();
  const next = grade(previous, quality, Date.now());
  next.learnedOn = previous.learnedOn || localDateKey();
  if (quality === 'again') next.lapsedOn = localDateKey();
  progress[word.word] = next;
  saveProgress();
}
function answer(quality) {
  if (questionDone) return;
  questionDone = true;
  const correct = quality === 'good';
  if (!(current.kind === 'quiz' && correct)) setGrade(current.word, correct ? 'good' : 'again');
  if (correct) rightCount++; else missed.add(current.word.word);
  answeredCount++;
  session.mark(current, correct ? 'good' : 'again');
  if (current.kind === 'new' && currentMode === 'mixed' && correct) session.pushQuiz(current.word, 'quiz');
  if (currentQuestion === 'card') { nextQuestion(); return; }
  current.correct = correct;
  if (currentQuestion === 'listen') renderListen();
  if (currentQuestion === 'speak') renderSpeak();
  if (currentQuestion === 'spell') renderSpell();
}
function beginSession() {
  currentMode = prefs.mode;
  session = buildSession(words, progress, { category: prefs.category, newLimit: prefs.dailyLimit, now: Date.now(), extraNew: forceExtraNew, retryToday: forceRetryToday, mode: currentMode });
  forceExtraNew = false; forceRetryToday = false;
  if (!session.total) { renderHome(); app.querySelector('.empty-state')?.scrollIntoView({ block: 'center' }); return; }
  rightCount = 0; answeredCount = 0; missed = new Set(); newSeen = new Set(); sentencesUsed = new Map();
  nextQuestion();
}
function renderResults() {
  stopListening();
  const accuracy = answeredCount ? Math.round(rightCount / answeredCount * 100) : 0;
  const failed = [...missed].map((word) => words.find((item) => item.word === word)).filter(Boolean);
  const title = accuracy >= 80 ? '做得很好' : accuracy >= 50 ? '不錯，再接再厲' : '這些字多練幾次就會熟';
  app.innerHTML = `<section class="word-card"><p class="eyebrow">本回合完成</p><h1 class="page-title">${title}</h1><div class="result-number">${accuracy}%</div><p>答對率（${rightCount}／${answeredCount} 題）</p><p>本回合新學 ${[...newSeen].filter((key) => progress[key]?.learnedOn).length} 字</p><h2 class="section-heading">需要再練的單字</h2>${failed.length ? `<ul class="result-list">${failed.map((word) => `<li><strong>${escapeHTML(word.word)}</strong>　${escapeHTML(word.gloss_zh)}</li>`).join('')}</ul>` : '<p class="muted">本回合沒有答錯的單字。</p>'}<button class="btn btn-primary" type="button" data-action="home">回首頁</button></section>`;
}
function renderSettings() {
  const exported = JSON.stringify({ progress, preferences: prefs }, null, 2);
  app.innerHTML = `<section><button class="btn btn-link" type="button" data-action="home">‹ 回首頁</button><h1 class="page-title">設定</h1><p class="intro">依照自己的步調調整練習。</p><div class="panel"><div class="setting-row"><label for="daily-limit">每日新字數（4–20）</label><select id="daily-limit">${Array.from({ length: 17 }, (_, i) => i + 4).map((n) => `<option value="${n}" ${n === prefs.dailyLimit ? 'selected' : ''}>${n} 字</option>`).join('')}</select></div><div class="setting-row"><label for="speed">例句語速</label><select id="speed">${[['0.7', '慢速'], ['0.85', '稍慢'], ['1', '一般']].map(([v, label]) => `<option value="${v}" ${Number(v) === prefs.speed ? 'selected' : ''}>${label}（${v}）</option>`).join('')}</select></div><div class="setting-row"><label><input type="checkbox" id="autoplay" ${prefs.autoplay ? 'checked' : ''}> 自動播放單字</label></div><div class="actions"><button class="btn" type="button" data-action="reset">重設所有學習進度</button></div></div><div class="panel"><h2 class="section-heading">匯出／匯入進度</h2><p class="small muted">匯出後複製 JSON 備份；匯入時貼上備份內容，再按匯入。</p><div class="setting-row"><textarea id="progress-json" aria-label="進度 JSON">${escapeHTML(exported)}</textarea></div><div class="button-row"><button class="btn btn-soft" type="button" data-action="export">匯出進度</button><button class="btn btn-soft" type="button" data-action="import">匯入進度</button></div></div></section>`;
}
const SOURCES = [
  ['SUBTLEX-US（Brysbaert & New）', 'https://doi.org/10.3758/BRM.41.4.977', 'CC BY-NC-SA 4.0'],
  ['Kuperman 2012 習得年齡', 'https://doi.org/10.3758/s13428-012-0210-4', '研究用公開資料'],
  ['Brysbaert 2014 具體度', 'https://doi.org/10.3758/s13428-013-0403-5', '研究用公開資料'],
  ['Google Taskmaster', 'https://github.com/google-research-datasets/Taskmaster', 'CC BY 4.0'],
  ['Schema-Guided Dialogue', 'https://github.com/google-research-datasets/dstc8-schema-guided-dialogue', 'CC BY-SA 4.0'],
  ['CMU Pronouncing Dictionary', 'https://github.com/cmusphinx/cmudict', 'BSD'],
  ['ECDICT', 'https://github.com/skywind3000/ECDICT', 'MIT'],
  ['Open English WordNet', 'https://github.com/globalwordnet/english-wordnet', 'CC BY 4.0'],
  ['AGID', 'https://www.gutenberg.org/ebooks/3201', '寬鬆授權（需保留版權聲明，Kevin Atkinson）'],
];
function renderSources() {
  const recordingList = words.filter((word) => word.audio).map((word) => { const page = /^https:\/\//i.test(word.audio.page || '') ? word.audio.page : ''; return `<div class="source-item"><span class="source-word">${escapeHTML(word.word)}</span><br>錄音者：${escapeHTML(word.audio.artist || '見檔案頁')}<br>授權：${escapeHTML(word.audio.license)}<br>${page ? `<a href="${escapeHTML(page)}" target="_blank" rel="noopener">錄音來源頁</a>` : '來源頁未提供 HTTPS 連結'}</div>`; }).join('');
  app.innerHTML = `<section><button class="btn btn-link" type="button" data-action="home">‹ 回首頁</button><h1 class="page-title">來源與授權</h1><p class="intro">單字與錄音來源資訊。</p><div class="panel"><h2 class="section-heading">單字錄音（${words.filter((word) => word.audio).length} 筆）</h2><div class="source-list">${recordingList}</div></div><div class="panel"><h2 class="section-heading">資料來源</h2>${SOURCES.map(([name, url, license]) => `<div class="source-item"><a href="${url}" target="_blank" rel="noopener">${name}</a> — ${license}</div>`).join('')}<p class="small muted">例句與中譯為本站自寫。僅供個人非商業學習。</p></div></section>`;
}

app.addEventListener('change', (event) => {
  if (event.target.matches('input[name="mode"]')) { prefs.mode = event.target.value; savePrefs(); }
  if (event.target.id === 'daily-limit') { prefs.dailyLimit = Number(event.target.value); savePrefs(); }
  if (event.target.id === 'speed') { prefs.speed = Number(event.target.value); savePrefs(); }
  if (event.target.id === 'autoplay') { prefs.autoplay = event.target.checked; savePrefs(); }
});
app.addEventListener('submit', (event) => {
  if (event.target.matches('[data-form="spell"]')) {
    event.preventDefault();
    const input = event.target.elements.spelling.value.trim(); current.input = input;
    const exact = input.toLowerCase() === current.word.word.toLowerCase();
    const nearHyphen = normalize(input).replace(/\s/g, '') === normalize(current.word.word).replace(/\s/g, '') && !exact;
    current.nearHyphen = nearHyphen;
    answer(exact ? 'good' : 'again');
  }
});
app.addEventListener('click', (event) => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.category) { prefs.category = button.dataset.category; savePrefs(); renderHome(); return; }
  if (button.dataset.grade) { answer(button.dataset.grade); return; }
  if (button.dataset.choice) {
    if (questionDone) return;
    questionDone = true;
    const correct = button.dataset.choice === current.word.word;
    current.correct = correct;
    if (correct) { rightCount++; if (current.kind !== 'quiz') setGrade(current.word, 'good'); } else { missed.add(current.word.word); setGrade(current.word, 'again'); }
    answeredCount++; session.mark(current, correct ? 'good' : 'again');
    if (current.kind === 'new' && currentMode === 'mixed' && correct) session.pushQuiz(current.word, 'quiz');
    renderListen(); return;
  }
  const action = button.dataset.action;
  if (action === 'start') beginSession();
  else if (action === 'home') { stopListening(); recognitionToken++; notice = ''; renderHome(); }
  else if (action === 'settings') renderSettings();
  else if (action === 'sources') renderSources();
  else if (action === 'end') { stopListening(); recognitionToken++; renderResults(); }
  else if (action === 'extra-new') { forceExtraNew = true; beginSession(); }
  else if (action === 'retry-today') { forceRetryToday = true; beginSession(); }
  else if (action === 'reveal') { answerShown = true; renderCard(); }
  else if (action === 'toggle-zh') { sentenceTranslationShown = !sentenceTranslationShown; renderCard(); }
  else if (action === 'play-word') {
    const supported = playWord(current.word);
    if (!supported) { notice = '此瀏覽器不支援語音播放。'; if (currentQuestion === 'card') renderCard(); else if (currentQuestion === 'listen') renderListen(); else if (currentQuestion === 'speak') renderSpeak(); else renderSpell(); }
  } else if (action === 'play-sentence') {
    const sentence = current.sentence;
    if (!makeSpeech(sentence.en, prefs.speed)) { notice = '此瀏覽器不支援語音播放。'; renderCard(); }
  } else if (action === 'mic') {
    if (!recognitionSupported(window)) { notice = '請用 Safari 開啟，並在 設定 > Siri 開啟聽寫。'; micFeedback = { text: notice, bad: true }; if (currentQuestion === 'speak') renderSpeak(); else renderCard(); return; }
    if (isListening()) {
      // Still capturing this attempt: the tap means "I'm done talking", so judge what was heard.
      if (!attemptResolved) { finishListening(); return; }
      // Previous attempt was already judged but iOS has not closed it yet: drop it and start fresh.
      recognitionToken++; stopListening();
    }
    speechAttempts++;
    micAttempts++;
    attemptResolved = false;
    const attempt = micAttempts;
    const token = ++recognitionToken;
    const expectedWord = current.word.word;
    const expectedQuestion = currentQuestion;
    const isCurrent = () => token === recognitionToken && current?.word.word === expectedWord && currentQuestion === expectedQuestion;
    const rerender = () => { if (currentQuestion === 'speak') renderSpeak(); else if (currentQuestion === 'card') renderCard(); else renderCurrentQuestion(); };
    micFeedback = { text: '聆聽中…請說出單字，說完再按一次麥克風或稍等。', attempt };
    rerender();
    setAudioSession('play-and-record');
    const result = startListening({
      onDebug: (name, detail) => { if (!debugMode) return; micLog.push(`${new Date().toISOString().slice(14, 23)} #${attempt} ${name} ${detail}`); },
      onState: (active) => { if (!active) setAudioSession('playback'); if (!isCurrent()) return; for (const mic of app.querySelectorAll('[data-action="mic"]')) { mic.classList.toggle('listening', active); mic.setAttribute('aria-label', active ? '停止聆聽' : '開始辨識'); } if (!active && debugMode) rerender(); },
      onResult: (alternatives) => {
        if (!isCurrent()) return;
        attemptResolved = true;
        const resultMatch = matchResult(expectedWord, alternatives);
        const first = alternatives[0];
        const cue = resultMatch.level === 'miss' ? tipsForKK(current.word.kk).join(' ') : '';
        const confidence = resultMatch.level === 'clear' && first?.confidence > 0 ? `（信心度 ${Math.round(first.confidence * 100)}%）` : '';
        micFeedback = { result: resultMatch, kk: current.word.kk, cue, confidence, attempt };
        if (questionDone) renderCurrentQuestion();
        else if (currentQuestion === 'speak') {
          if (resultMatch.level !== 'miss') answer('good');
          else if (speechAttempts >= 2) answer('again');
          else renderSpeak();
        } else if (currentQuestion === 'card') renderCard();
      },
      onError: (error) => {
        if (!isCurrent()) return;
        attemptResolved = true;
        const messages = { 'not-allowed': '麥克風權限未開啟，請在 Safari 網站設定允許麥克風。', 'service-not-allowed': '語音辨識服務未開啟，請用 Safari 開啟，並在 設定 > Siri 開啟聽寫。', 'no-speech': '沒有聽到聲音，請靠近麥克風再試一次。' };
        micFeedback = { text: messages[error] || '語音辨識暫時無法使用，請再試一次。', bad: true, attempt };
        notice = micFeedback.text;
        if (currentQuestion === 'speak') renderSpeak(); else if (currentQuestion === 'card') renderCard();
      },
      onNoResult: () => { if (!isCurrent()) return; attemptResolved = true; micFeedback = { text: '沒有聽到聲音，請再試一次。', bad: true, attempt }; notice = micFeedback.text; if (currentQuestion === 'speak') renderSpeak(); else if (currentQuestion === 'card') renderCard(); },
    });
    if (!result.ok) { attemptResolved = true; notice = result.reason === 'unsupported' ? '請用 Safari 開啟，並在 設定 > Siri 開啟聽寫。' : '無法啟動語音辨識，請稍後再試。'; micFeedback = { text: notice, bad: true }; if (currentQuestion === 'speak') renderSpeak(); else renderCard(); }
  } else if (action === 'dont-know') { current.input = ''; answer('again'); }
  else if (action === 'next') nextQuestion();
  else if (action === 'reset') {
    if (window.confirm('確定要重設所有學習進度嗎？此操作無法復原。') && window.confirm('再確認一次：要清除全部已學進度嗎？')) { progress = {}; saveProgress(); renderSettings(); }
  } else if (action === 'export') {
    const area = app.querySelector('#progress-json'); area.value = JSON.stringify({ progress, preferences: prefs }, null, 2); area.focus(); area.select();
  } else if (action === 'import') {
    try {
      const parsed = JSON.parse(app.querySelector('#progress-json').value);
      if (!parsed || typeof parsed !== 'object' || !parsed.progress || typeof parsed.progress !== 'object' || Array.isArray(parsed.progress)) throw new Error('format');
      progress = validateProgress(parsed.progress); const importedPrefs = parsed.preferences && typeof parsed.preferences === 'object' && !Array.isArray(parsed.preferences) ? parsed.preferences : {}; prefs = { ...defaults, ...prefs, ...importedPrefs }; saveProgress(); savePrefs(); renderSettings();
    } catch { const area = app.querySelector('#progress-json'); area.setCustomValidity('JSON 格式不正確，或缺少 progress 欄位。'); area.reportValidity(); }
  }
});

try {
  const response = await fetch('words.json?v=20261030135844');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  words = await response.json();
  sharedAudio = new Audio();
  renderHome();
} catch {
  app.innerHTML = '<section class="panel"><h1 class="page-title">無法載入單字資料</h1><p>請確認 words.json 與此網頁放在同一個資料夾，並透過網站伺服器開啟。</p></section>';
}
