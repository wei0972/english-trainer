const DAY = 86_400_000;

export function freshState() {
  return { reps: 0, interval: 0, ease: 2.5, due: 0, lapses: 0, lastSentence: -1 };
}

export function validateProgress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const cleaned = {};
  const numeric = ['reps', 'interval', 'ease', 'due', 'lapses', 'lastSentence'];
  for (const [word, state] of Object.entries(value)) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
    if (numeric.some((key) => key in state && (typeof state[key] !== 'number' || !Number.isFinite(state[key])))) continue;
    if (['learnedOn', 'lapsedOn'].some((key) => key in state && typeof state[key] !== 'string')) continue;
    cleaned[word] = { ...state };
  }
  return cleaned;
}

export function grade(state = freshState(), quality, now = Date.now()) {
  const next = { ...freshState(), ...state };
  if (quality === 'again') {
    next.reps = 0;
    next.interval = 0;
    next.ease = Math.max(1.3, next.ease - 0.2);
    next.due = now + 10 * 60_000;
    next.lapses += 1;
  } else if (quality === 'good' || quality === 'easy') {
    next.interval = next.reps === 0 ? 1 : next.reps === 1 ? 3 : next.interval * next.ease;
    if (quality === 'easy') { next.interval *= 1.3; next.ease += 0.15; }
    next.reps += 1;
    next.due = now + next.interval * DAY;
  } else throw new TypeError(`Unknown quality: ${quality}`);
  return next;
}

export function localDateKey(now = Date.now()) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function maskSentence(sentence, form) {
  if (!sentence || !form) return null;
  const escaped = String(form).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped})(?=$|[^\\p{L}\\p{N}])`, 'giu');
  const masked = String(sentence).replace(pattern, '$1____');
  return masked === sentence ? null : masked;
}

export function uniqueChoices(target, words, rng = Math.random) {
  const selected = new Map([[target.gloss_zh, target]]);
  const pool = words.filter((word) => word.word !== target.word && word.gloss_zh && word.gloss_zh !== target.gloss_zh);
  while (pool.length && selected.size < 4) {
    const candidate = pool.splice(Math.floor(Math.max(0, Math.min(.999999, rng())) * pool.length), 1)[0];
    if (!selected.has(candidate.gloss_zh)) selected.set(candidate.gloss_zh, candidate);
  }
  return [...selected.values()];
}

export function finalConsonant(kk = '') {
  return /[bcdfghjklmnpqrstvwxyzḷṇ](?:[\u0300-\u036f]*)$/iu.test(String(kk).trim());
}

export function buildSession(words, progress = {}, options = {}) {
  const { category = 'all', newLimit = 8, now = Date.now(), rng = Math.random } = options;
  const today = localDateKey(now);
  const filtered = words.filter((word) => category === 'all' || word.category?.includes(category));
  const reviews = filtered.filter((word) => progress[word.word]?.learnedOn && (progress[word.word].due ?? 0) <= now)
    .sort((a, b) => (progress[a.word].due ?? 0) - (progress[b.word].due ?? 0)).slice(0, 30);
  const alreadyNew = options.todayNew ?? Object.values(progress).filter((state) => state.learnedOn === today).length;
  const remaining = options.extraNew ? Math.min(20, newLimit) : Math.max(0, Math.min(20, newLimit) - alreadyNew);
  const unseen = filtered.filter((word) => !progress[word.word]?.learnedOn && !reviews.some((review) => review.word === word.word));
  const pool = [...unseen];
  const newWords = [];
  const tierWeight = (tier) => tier === 1 ? 0.7 : tier === 2 ? 0.25 : 0.05;
  while (pool.length && newWords.length < remaining) {
    const total = pool.reduce((sum, word) => sum + tierWeight(word.tier), 0);
    let pick = Math.min(.999999999, Math.max(0, rng())) * total;
    let index = pool.findIndex((word) => (pick -= tierWeight(word.tier)) < 0);
    if (index < 0) index = pool.length - 1;
    newWords.push(pool.splice(index, 1)[0]);
  }
  const queue = reviews.map((word) => ({ word, kind: 'review', attempts: 0, defer: 0 }));
  for (const word of newWords) queue.push({ word, kind: 'new', attempts: 0, defer: 0 });
  if (options.retryToday) {
    for (const word of filtered) {
      const state = progress[word.word];
      if (state?.lapsedOn === today && state.lapses > 0 && state.due > now && !reviews.includes(word)) {
        queue.unshift({ word, kind: 'review', attempts: 0, defer: 0 });
      }
    }
  }
  const retries = [];
  let cursor = 0;
  let consumed = 0;
  const session = {
    queue, newWords, reviews, current: null,
    next() {
      for (const retry of retries) retry.defer = Math.max(0, retry.defer - 1);
      let index = retries.findIndex((retry) => retry.defer === 0);
      if (index >= 0) session.current = retries.splice(index, 1)[0];
      else if (cursor < queue.length) session.current = queue[cursor++];
      else if (retries.length) {
        index = retries.reduce((best, retry, i, list) => retry.defer < list[best].defer ? i : best, 0);
        session.current = retries.splice(index, 1)[0];
      } else return null;
      consumed += 1;
      return session.current;
    },
    mark(entry, quality) {
      if (!entry || entry._marked) return false;
      entry._marked = true;
      if (quality === 'again' && entry.attempts < 2) retries.push({ word: entry.word, kind: 'retry', attempts: entry.attempts + 1, defer: 4 });
      return true;
    },
    pushQuiz(word, kind = 'quiz') {
      if (queue.slice(cursor).some((entry) => entry.word.word === word.word && entry.kind === kind) || retries.some((entry) => entry.word.word === word.word)) return false;
      const lastNew = queue.reduce((last, entry, index) => entry.kind === 'new' ? index : last, cursor - 1);
      const low = Math.max(cursor, lastNew + 1);
      const index = low + Math.floor(Math.max(0, Math.min(.999999, rng())) * (queue.length - low + 1));
      queue.splice(index, 0, { word, kind, attempts: 0, defer: 0 });
      return true;
    },
    get total() { return consumed + queue.length - cursor + retries.length; },
    get position() { return consumed; },
  };
  return session;
}
