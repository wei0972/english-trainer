const HOMOPHONES = {
  suite: ['sweet'], aisle: ['isle', "i'll"], fare: ['fair'], inn: ['in'],
  complimentary: ['complementary'],
};
const VARIANTS = {
  checkout: ['check out'], pickup: ['pick up'], nonstop: ['non stop'],
  sightseeing: ['sight seeing'], layover: ['lay over'], 'e mail': ['email'], email: ['e mail'],
  gonna: ['going to'], gotta: ['got to'], wanna: ['want to'],
  okay: ['ok', 'o.k.'], ok: ['okay', 'o.k.'],
};
const CONTRACTIONS = { 'going to': ['gonna'], 'got to': ['gotta'], 'want to': ['wanna'] };

export function normalize(value = '') {
  return String(value).toLowerCase().replace(/-/g, ' ').replace(/[’']/g, '').replace(/[.,!?;:"()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
}

function formsFor(target) {
  const normalized = normalize(target);
  const forms = new Set([normalized]);
  for (const [key, values] of Object.entries(VARIANTS)) {
    if (normalize(key) === normalized || values.map(normalize).includes(normalized)) {
      forms.add(normalize(key));
      values.forEach((value) => forms.add(normalize(value)));
    }
  }
  for (const [key, values] of Object.entries(CONTRACTIONS)) {
    if (normalized === key || values.includes(normalized)) {
      forms.add(normalize(key));
      values.forEach((value) => forms.add(normalize(value)));
    }
  }
  for (const [key, values] of Object.entries(HOMOPHONES)) {
    if (normalized === key || values.includes(normalized)) {
      forms.add(normalize(key));
      values.forEach((value) => forms.add(normalize(value)));
    }
  }
  return forms;
}

function includesPhrase(haystack, phrase) {
  return (` ${haystack} `).includes(` ${phrase} `);
}

export function matchResult(target, alternatives = []) {
  const forms = formsFor(target);
  let heard = '';
  for (let i = 0; i < alternatives.length; i++) {
    const candidate = alternatives[i] || {};
    const text = normalize(candidate.transcript || '');
    if (!heard) heard = candidate.transcript || '';
    if (!text) continue;
    for (const form of forms) {
      if (includesPhrase(text, form)) {
        const normalizedTarget = normalize(target);
        const homophone = Object.entries(HOMOPHONES).some(([key, values]) => {
          const normalizedKey = normalize(key);
          const normalizedValues = values.map(normalize);
          return (normalizedTarget === normalizedKey && normalizedValues.includes(form)) || (normalizedValues.includes(normalizedTarget) && form === normalizedKey);
        });
        return { level: i === 0 && !homophone ? 'clear' : 'close', heard: candidate.transcript || '' };
      }
    }
  }
  return { level: 'miss', heard };
}

export function tipsForKK(kk = '') {
  const tips = [];
  const text = String(kk);
  if (/[θð]/.test(text)) tips.push('th 要舌尖輕咬。');
  if (text.includes('r')) tips.push('r 捲舌、l 舌尖頂上齒齦。');
  if (text.includes('v')) tips.push('v 上齒輕碰下唇，不是 b。');
  if (/[ɝɚ]/.test(text)) tips.push('ɝ／ɚ 是捲舌的「兒」音。');
  if (text.includes('æ')) tips.push('æ 嘴巴張大，不是 ɛ。');
  if (/[bcdfghjklmnpqrstvwxyzḷṇ](?:[\u0300-\u036f]*)$/iu.test(text)) tips.push('字尾子音要發出來，不要吞掉。');
  const syllables = (text.match(/[aeiouɑæɛɪʊʌɔəɚɝ]+/gi) || []).length;
  if (text.includes('ˋ') && syllables > 1) tips.push('重音在 ˋ 後的音節。');
  return tips.slice(0, 2);
}

export function stressKK(kk = '') {
  const text = String(kk).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  return text.replace(/ˋ([^ˏˋ]+)|ˏ([^ˏˋ]+)/g, (match, primary, secondary) => primary ? `<strong>ˋ${primary}</strong>` : `<span class="secondary-stress">ˏ${secondary}</span>`);
}

let activeRecognition = null;
let activeTimer = null;

export function recognitionSupported(env = globalThis) {
  return Boolean(env.SpeechRecognition || env.webkitSpeechRecognition);
}

// The button's CSS class can lag behind iOS (onend often arrives late); this is the source of truth.
export function isListening() {
  return activeRecognition !== null;
}

// User pressed stop: end capture but still evaluate what was heard (stopListening discards it).
export function finishListening() {
  if (activeRecognition) {
    try { activeRecognition.stop(); } catch { /* already stopped */ }
  }
}

export function stopListening() {
  if (activeTimer) clearTimeout(activeTimer);
  activeTimer = null;
  if (activeRecognition) {
    const recognition = activeRecognition;
    activeRecognition = null;
    try { recognition.stop(); } catch { /* already stopped */ }
  }
}

export function startListening(handlers = {}, env = globalThis) {
  const Recognition = env.SpeechRecognition || env.webkitSpeechRecognition;
  if (!Recognition) return { ok: false, reason: 'unsupported' };
  stopListening();
  if (env.speechSynthesis?.speaking || env.speechSynthesis?.pending) env.speechSynthesis.cancel();
  const recognition = new Recognition();
  activeRecognition = recognition;
  let timer = null;
  let receivedFinal = false;
  let latestAlternatives = [];
  let hadError = false;
  const debug = (name, detail = '') => handlers.onDebug?.(name, detail);
  recognition.lang = 'en-US';
  recognition.interimResults = true;
  recognition.maxAlternatives = 5;
  recognition.continuous = false;
  recognition.onstart = () => { debug('start'); if (activeRecognition === recognition) handlers.onState?.(true); };
  recognition.onresult = (event) => {
    if (activeRecognition !== recognition) { debug('result-stale'); return; }
    const alternatives = [];
    for (let i = event.resultIndex || 0; i < event.results.length; i++) {
      for (let j = 0; j < event.results[i].length; j++) {
        const result = event.results[i][j];
        alternatives.push({ transcript: result.transcript, confidence: result.confidence || 0 });
      }
    }
    const isFinal = Boolean(event.results[event.results.length - 1]?.isFinal);
    debug(isFinal ? 'final' : 'interim', alternatives[0]?.transcript || '');
    if (alternatives.length) latestAlternatives = alternatives;
    if (isFinal && !receivedFinal) {
      receivedFinal = true;
      handlers.onResult?.(alternatives);
      // Release the mic now so the next tap starts a fresh attempt instead of hitting a session iOS has not closed yet.
      try { recognition.stop(); } catch { /* already stopping */ }
    }
  };
  recognition.onerror = (event) => {
    debug('error', event.error || 'unknown');
    if (activeRecognition !== recognition) return;
    hadError = true;
    handlers.onError?.(event.error || 'unknown');
  };
  recognition.onend = () => {
    debug('end', receivedFinal ? 'had-final' : `interim=${latestAlternatives.length}`);
    if (activeRecognition !== recognition) return;
    if (timer) clearTimeout(timer);
    activeTimer = null;
    activeRecognition = null;
    // iOS Safari frequently ends without ever flagging a result as final; judge the last interim result instead.
    if (!receivedFinal && latestAlternatives.length) { receivedFinal = true; handlers.onResult?.(latestAlternatives); }
    // An error (e.g. permission denied) already told the user why; "no speech" would hide it.
    else if (!receivedFinal && !hadError) handlers.onNoResult?.();
    handlers.onState?.(false);
  };
  try {
    recognition.start();
    timer = setTimeout(() => { if (activeRecognition === recognition) { try { recognition.stop(); } catch { /* already stopped */ } } }, 8_000);
    activeTimer = timer;
    return { ok: true };
  } catch (error) {
    activeRecognition = null;
    return { ok: false, reason: error.name || 'start-failed' };
  }
}
