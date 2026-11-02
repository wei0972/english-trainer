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
    if ('checkedRange' in state && (typeof state.checkedRange !== 'number' || Number.isNaN(state.checkedRange))) continue;
    if ('mastered' in state && typeof state.mastered !== 'boolean') continue;
    if ('familiarOn' in state && !(Array.isArray(state.familiarOn) && state.familiarOn.every((day) => typeof day === 'string'))) continue;
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

// Frequency ranges: new words come from the most frequent 100 of a category first, then 500, 1000, then all.
// "熟悉了" on two different days masters a word (it then returns only every 60 days). A range opens the next one
// once 90% of it is mastered and every mastered word in it has passed one check round.
export const RANGES = [100, 500, 1000, Infinity];
export const MASTER_DAYS = 2;
export const RANGE_SHARE = 0.9;
export const MASTER_INTERVAL = 60;

export function rankOf(word, category = 'all') {
  return word.ranks?.[category] ?? 1e6;
}

// Range sizes actually distinct for this category (food has 458 words, so 500, 1000 and all are the same range).
export function rangeSizes(count) {
  const sizes = [];
  for (const size of RANGES) { const effective = Math.min(size, count); if (!sizes.includes(effective)) sizes.push(effective); }
  return sizes;
}

export function markFamiliar(state = freshState(), now = Date.now()) {
  const today = localDateKey(now);
  const days = Array.isArray(state.familiarOn) ? state.familiarOn : [];
  const next = { ...freshState(), ...state, familiarOn: days.includes(today) ? days : [...days, today].slice(-MASTER_DAYS) };
  if (next.familiarOn.length >= MASTER_DAYS && !next.mastered) {
    next.mastered = true;
    next.interval = Math.max(next.interval, MASTER_INTERVAL);
    next.due = now + next.interval * DAY;
  }
  return next;
}

export function failCheck(state = freshState(), now = Date.now()) {
  return { ...grade(state, 'again', now), mastered: false, familiarOn: [] };
}

export function rangeStatus(words, progress = {}, category = 'all', level = 0) {
  const members = words.filter((word) => category === 'all' || word.category?.includes(category))
    .sort((a, b) => rankOf(a, category) - rankOf(b, category));
  const sizes = rangeSizes(members.length);
  const index = Math.max(0, Math.min(level, sizes.length - 1));
  const size = sizes[index] ?? 0;
  const inRange = members.slice(0, size);
  const mastered = inRange.filter((word) => progress[word.word]?.mastered);
  const ready = size > 0 && mastered.length >= RANGE_SHARE * size;
  const pending = ready ? mastered.filter((word) => (progress[word.word].checkedRange ?? 0) < size) : [];
  return { level: index, size, last: index === sizes.length - 1, inRange, mastered: mastered.length, checking: ready && pending.length > 0, pending, complete: ready && !pending.length };
}

// Opens later ranges while the current one is complete; the last range stays open (its check round still runs).
export function advanceRange(words, progress, category, level = 0) {
  let status = rangeStatus(words, progress, category, level);
  while (status.complete && !status.last) status = rangeStatus(words, progress, category, status.level + 1);
  return status;
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
  // Mistake-book drill: exactly the requested words (any category, no new words), priority order, capped at 30.
  const byKey = new Map(words.map((word) => [word.word, word]));
  const drillQueue = Array.isArray(options.onlyWords)
    ? options.onlyWords.map((key) => byKey.get(key)).filter(Boolean).slice(0, 30).map((word) => ({ word, kind: 'drill', drillMode: options.drillModes?.[word.word], attempts: 0, defer: 0 }))
    : null;
  const filtered = words.filter((word) => category === 'all' || word.category?.includes(category));
  // Check round: mastered words of a nearly finished range come back once each (10 per session) before it widens.
  const checkWords = drillQueue ? [] : (options.checks ?? []).slice(0, 10);
  const checking = new Set(checkWords.map((word) => word.word));
  const reviews = drillQueue ? [] : filtered.filter((word) => !checking.has(word.word) && progress[word.word]?.learnedOn && (progress[word.word].due ?? 0) <= now)
    .sort((a, b) => (progress[a.word].due ?? 0) - (progress[b.word].due ?? 0)).slice(0, 30);
  const alreadyNew = options.todayNew ?? Object.values(progress).filter((state) => state.learnedOn === today).length;
  const remaining = drillQueue ? 0 : options.extraNew ? Math.min(20, newLimit) : Math.max(0, Math.min(20, newLimit) - alreadyNew);
  const unseen = filtered.filter((word) => !progress[word.word]?.learnedOn && !reviews.some((review) => review.word === word.word));
  const pool = [...unseen];
  const newWords = [];
  // More frequent words (by their rank in the practised category) are drawn more often; words beyond the open
  // range are drawn only once the range has no unseen words left, still nearest-first.
  const rangeSize = options.rangeSize ?? Infinity;
  const weightOf = (word) => { const rank = rankOf(word, category); return (rank <= rangeSize ? 1 : 1e-4) / rank; };
  while (pool.length && newWords.length < remaining) {
    const inRange = pool.some((word) => rankOf(word, category) <= rangeSize);
    const candidates = inRange ? pool.filter((word) => rankOf(word, category) <= rangeSize) : pool;
    const total = candidates.reduce((sum, word) => sum + weightOf(word), 0);
    let pick = Math.min(.999999999, Math.max(0, rng())) * total;
    let chosen = candidates.findIndex((word) => (pick -= weightOf(word)) < 0);
    if (chosen < 0) chosen = candidates.length - 1;
    let index = pool.indexOf(candidates[chosen]);
    if (index < 0) index = pool.length - 1;
    newWords.push(pool.splice(index, 1)[0]);
  }
  const queue = drillQueue || reviews.map((word) => ({ word, kind: 'review', attempts: 0, defer: 0 }));
  for (const word of newWords) queue.push({ word, kind: 'new', attempts: 0, defer: 0 });
  for (const word of checkWords) queue.push({ word, kind: 'check', attempts: 0, defer: 0 });
  if (options.retryToday && !drillQueue) {
    for (const word of filtered) {
      const state = progress[word.word];
      if (state?.lapsedOn === today && state.lapses > 0 && state.due > now && !reviews.includes(word) && !checking.has(word.word)) {
        queue.unshift({ word, kind: 'review', attempts: 0, defer: 0 });
      }
    }
  }
  // Due order only decides WHICH reviews make the cap; presenting in that order replays the order the
  // words were learned, so every session would start the same way. Shuffle reviews and new words together.
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.max(0, Math.min(.999999, rng())) * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
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
      if (quality === 'again' && entry.attempts < 2) {
        const retry = { word: entry.word, kind: entry.kind === 'drill' ? 'drill' : 'retry', attempts: entry.attempts + 1, defer: 4 };
        if (entry.kind === 'drill') retry.drillMode = entry.drillMode;
        retries.push(retry);
      }
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
