import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { grade, buildSession, validateProgress, maskSentence, uniqueChoices, finalConsonant, markFamiliar, failCheck, rangeSizes, rangeStatus, advanceRange, MASTER_INTERVAL } from '../srs.js';

test('again resets interval, delays ten minutes, lowers ease and counts a lapse', () => {
  const state = { reps: 2, interval: 6, ease: 2.5, due: 0, lapses: 1, lastSentence: 0 };
  assert.deepEqual(grade(state, 'again', 1_000), {
    reps: 0, interval: 0, ease: 2.3, due: 601_000, lapses: 2, lastSentence: 0,
  });
});

test('good uses one day then three days and subsequently ease', () => {
  let state = { reps: 0, interval: 0, ease: 2.5, due: 0, lapses: 0, lastSentence: 0 };
  state = grade(state, 'good', 0);
  assert.equal(state.interval, 1);
  state = grade(state, 'good', 0);
  assert.equal(state.interval, 3);
  state = grade(state, 'good', 0);
  assert.equal(state.interval, 7.5);
});

test('easy applies the easy multiplier and ease increase', () => {
  const next = grade({ reps: 0, interval: 0, ease: 2.5, due: 0, lapses: 0, lastSentence: 0 }, 'easy', 10);
  assert.equal(next.interval, 1.3);
  assert.equal(next.ease, 2.65);
});

test('buildSession includes due reviews, honors daily new limit and schedules missed words again', () => {
  const words = ['a', 'b', 'c', 'd', 'e', 'f'].map((word) => ({ word, tier: 1, category: ['daily'] }));
  const progress = {
    a: { reps: 1, interval: 2, ease: 2.5, due: 30, lapses: 0, learnedOn: '2026-01-01' },
    b: { reps: 1, interval: 2, ease: 2.5, due: 10, lapses: 0, learnedOn: '2026-01-01' },
  };
  const session = buildSession(words, progress, { category: 'daily', newLimit: 5, now: 100, rng: () => 0, todayNew: 1 });
  assert.deepEqual(session.reviews.map((w) => w.word).sort(), ['a', 'b']);
  assert.equal(session.newWords.length, 4);
  // Order is shuffled; check membership and that a missed word comes back after the queue.
  const seen = [];
  let missedWord = null;
  for (let entry = session.next(); entry; entry = session.next()) {
    seen.push(entry.word.word);
    if (seen.length === 3 && !missedWord) { missedWord = entry.word.word; assert.equal(session.mark(entry, 'again'), true); }
  }
  assert.deepEqual([...new Set(seen.slice(0, 6))].sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(seen.length, 7);
  assert.equal(seen[6], missedWord);
});

test('again-due learned words review while ungraded new words do not count as learned', () => {
  const words = ['learned', 'ungraded'].map((word) => ({ word, tier: 1, category: ['daily'] }));
  const progress = { learned: { ...grade({}, 'again', 0), learnedOn: '2026-01-01' }, ungraded: { reps: 0, interval: 0, ease: 2.5, due: 0, lapses: 0 } };
  const session = buildSession(words, progress, { now: 600_001, newLimit: 2, todayNew: 0, rng: () => 0 });
  assert.equal(session.reviews[0].word, 'learned');
  assert.equal(session.newWords.some((word) => word.word === 'ungraded'), true);
  assert.equal(validateProgress({ ungraded: progress.ungraded }).ungraded.learnedOn, undefined);
});

test('last failed entry is retried after queue exhaustion', () => {
  const session = buildSession([{ word: 'last', tier: 1, category: ['daily'] }], {}, { newLimit: 1, rng: () => 0 });
  const first = session.next(); session.mark(first, 'again');
  const second = session.next(); assert.equal(second.word.word, 'last'); session.mark(second, 'again');
  const third = session.next(); assert.equal(third.word.word, 'last'); session.mark(third, 'again');
  assert.equal(session.next(), null);
});

test('new-word quizzes are queued after cards, exclude cards, and avoid repeat glosses', () => {
  const words = ['one', 'two', 'three', 'four'].map((word, i) => ({ word, tier: 1, category: ['daily'], gloss_zh: ['同義', '同義', '二', '三'][i] }));
  const session = buildSession(words, {}, { newLimit: 3, mode: 'mixed', rng: () => 0 });
  for (let i = 0; i < 3; i++) { const card = session.next(); assert.equal(card.kind, 'new'); session.mark(card, 'good'); if (i === 0) session.pushQuiz(card.word, 'quiz'); }
  assert.equal(session.queue.slice(session.position).some((entry) => entry.kind === 'card'), false);
  assert.equal(session.queue.findIndex((entry) => entry.kind === 'quiz') >= 3, true);
  assert.deepEqual(uniqueChoices(words[0], words, () => 0).map((word) => word.gloss_zh), ['同義', '二', '三']);
});

test('sentence masking uses form case-insensitively and masks the whole word', () => {
  assert.equal(maskSentence('We checked the CHECKOUT counter.', 'checkout'), 'We checked the ____ counter.');
  assert.equal(maskSentence('A checkoutline is long.', 'checkout'), null);
});

test('progress validation drops malformed records and invalid root objects', () => {
  assert.deepEqual(validateProgress(null), {});
  assert.deepEqual(validateProgress({ a: null, b: { reps: Infinity }, c: { reps: 1, interval: 3, ease: 2.5, due: 1, lapses: 0 } }), { c: { reps: 1, interval: 3, ease: 2.5, due: 1, lapses: 0 } });
});

test('ḷ and ṇ are recognized as final consonants', () => {
  assert.equal(finalConsonant('pɪḷ'), true);
  assert.equal(finalConsonant('fɑṇ'), true);
});

test('extra new words ignore the daily limit', () => {
  const words = Array.from({ length: 6 }, (_, i) => ({ word: `w${i}`, tier: 1, category: ['daily'] }));
  assert.equal(buildSession(words, {}, { newLimit: 2, todayNew: 2, extraNew: true, rng: () => 0 }).newWords.length, 2);
});

test('every source sentence (6 per word, 3 for elementary) is masked at the form word boundary', async () => {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '../words.json');
  const words = JSON.parse(await readFile(source, 'utf8'));
  for (const word of words) assert.equal(word.sentences.length, word.category.includes('elementary') ? 3 : 6, word.word);
  const sentences = words.flatMap((word) => word.sentences);
  for (const sentence of sentences) {
    const masked = maskSentence(sentence.en, sentence.form);
    assert.ok(masked, `could not mask ${sentence.form}: ${sentence.en}`);
    assert.equal(maskSentence(masked, sentence.form), null, `form remains: ${sentence.form}: ${masked}`);
  }
});

test('session order is shuffled, not replayed in due order', async () => {
  const { buildSession } = await import('../srs.js');
  const now = Date.UTC(2026, 9, 28, 12);
  const words = Array.from({ length: 12 }, (_, i) => ({ word: `w${i}`, tier: 1, category: ['daily'] }));
  const progress = {};
  // w0..w9 learned yesterday in order, so their due times are strictly increasing.
  words.slice(0, 10).forEach((w, i) => { progress[w.word] = { reps: 1, interval: 1, ease: 2.5, due: now - 100000 + i, lapses: 0, lastSentence: -1, learnedOn: '2026-10-27' }; });
  let seed = 7;
  const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const order = (s) => { const out = []; let e; while ((e = s.next())) out.push(e.word.word); return out; };
  const first = order(buildSession(words, progress, { now, newLimit: 2, todayNew: 0, rng }));
  const dueOrder = words.slice(0, 10).map((w) => w.word);
  assert.equal(first.length, 12);
  assert.deepEqual([...first].sort(), [...dueOrder, 'w10', 'w11'].sort());
  assert.notDeepEqual(first.filter((w) => dueOrder.includes(w)), dueOrder);
  const second = order(buildSession(words, progress, { now, newLimit: 2, todayNew: 0, rng }));
  assert.notDeepEqual(first, second);
});

test('buildSession weights new words by the rank in the selected category', () => {
  // 'x' is rank 1 in senior but rank 50 in daily; 'y' is the opposite. rng 0.5 picks by weight (1 / rank).
  const words = [
    { word: 'x', tier: 1, ranks: { daily: 50, senior: 1 }, category: ['daily', 'senior'] },
    { word: 'y', tier: 1, ranks: { daily: 1, senior: 50 }, category: ['daily', 'senior'] },
  ];
  const pick = (category) => buildSession(words, {}, { category, newLimit: 1, rng: () => 0.5 }).newWords[0].word;
  assert.equal(pick('senior'), 'x');
  assert.equal(pick('daily'), 'y');
});

test('buildSession onlyWords builds a drill queue: no new words, ignores category, keeps drillMode, caps at 30', () => {
  const words = Array.from({ length: 40 }, (_, i) => ({ word: `w${i}`, tier: 1, category: i % 2 ? ['travel'] : ['daily'] }));
  const progress = { w0: { reps: 1, interval: 1, ease: 2.5, due: 0, lapses: 0, learnedOn: '2026-01-01' } };
  const session = buildSession(words, progress, { category: 'travel', newLimit: 8, now: 100, rng: () => 0, onlyWords: ['w0', 'w2', 'w1', 'missing'], drillModes: { w0: 'spell', w2: 'listen', w1: 'speak' } });
  assert.equal(session.total, 3);
  assert.equal(session.newWords.length, 0);
  assert.equal(session.reviews.length, 0);
  const entries = [];
  for (let entry = session.next(); entry; entry = session.next()) entries.push(entry);
  assert.deepEqual(entries.map((e) => e.word.word).sort(), ['w0', 'w1', 'w2']);
  assert.ok(entries.every((e) => e.kind === 'drill'));
  assert.deepEqual(Object.fromEntries(entries.map((e) => [e.word.word, e.drillMode])), { w0: 'spell', w1: 'speak', w2: 'listen' });
  const capped = buildSession(words, {}, { rng: () => 0, onlyWords: words.map((w) => w.word) });
  assert.equal(capped.total, 30);
});

test('a missed drill entry comes back as a drill with the same drillMode', () => {
  const words = [{ word: 'a', tier: 1, category: ['daily'] }];
  const session = buildSession(words, {}, { rng: () => 0, onlyWords: ['a'], drillModes: { a: 'spell' } });
  const first = session.next();
  assert.equal(session.mark(first, 'again'), true);
  const retry = session.next();
  assert.equal(retry.kind, 'drill');
  assert.equal(retry.drillMode, 'spell');
  assert.equal(retry.attempts, 1);
  // Ordinary entries still become plain retries.
  const normal = buildSession([{ word: 'b', tier: 1, category: ['daily'] }], {}, { newLimit: 1, rng: () => 0 });
  const entry = normal.next(); normal.mark(entry, 'again');
  assert.equal(normal.next().kind, 'retry');
});

const DAY = 86_400_000;
const ranked = (n, category = 'daily') => Array.from({ length: n }, (_, i) => ({ word: `w${i + 1}`, tier: 1, category: [category], ranks: { [category]: i + 1, all: i + 1 } }));

test('new words stay inside the open range until it has no unseen words left', () => {
  const words = ranked(300);
  for (let seed = 0; seed < 20; seed++) {
    const picked = buildSession(words, {}, { category: 'daily', rangeSize: 100, newLimit: 20, rng: () => (seed * 0.049) % 1 }).newWords;
    assert.equal(picked.every((word) => Number(word.word.slice(1)) <= 100), true);
  }
  const learned = Object.fromEntries(words.slice(0, 98).map((word) => [word.word, { reps: 1, interval: 3, ease: 2.5, due: Date.now() + 9 * DAY, lapses: 0, learnedOn: '2026-01-01' }]));
  const spill = buildSession(words, learned, { category: 'daily', rangeSize: 100, newLimit: 4, rng: () => 0 }).newWords.map((word) => word.word);
  assert.deepEqual(spill.slice(0, 2).sort(), ['w100', 'w99']);
  assert.equal(spill.length, 4);
});

test('frequent words are drawn first more often than rare ones', () => {
  const words = ranked(100);
  let seed = 3; const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let top = 0; let bottom = 0;
  for (let i = 0; i < 400; i++) {
    const first = buildSession(words, {}, { category: 'daily', rangeSize: 100, newLimit: 1, rng }).newWords[0];
    const rank = first.ranks.daily; if (rank <= 10) top++; if (rank > 90) bottom++;
  }
  assert.ok(top > bottom * 5, `top ${top} bottom ${bottom}`);
});

test('familiar on two different days masters a word; twice on one day does not', () => {
  const day1 = Date.UTC(2026, 10, 2, 4); const day2 = day1 + DAY;
  let state = markFamiliar(undefined, day1);
  state = markFamiliar(state, day1 + 1000);
  assert.equal(state.mastered, undefined);
  assert.equal(state.familiarOn.length, 1);
  state = markFamiliar(state, day2);
  assert.equal(state.mastered, true);
  assert.ok(state.due >= day2 + MASTER_INTERVAL * DAY);
  const failed = failCheck(state, day2);
  assert.equal(failed.mastered, false);
  assert.deepEqual(failed.familiarOn, []);
  assert.equal(failed.lapses, 1);
});

test('range sizes collapse when a category is smaller than the next range', () => {
  assert.deepEqual(rangeSizes(458), [100, 458]);
  assert.deepEqual(rangeSizes(1826), [100, 500, 1000, 1826]);
  assert.deepEqual(rangeSizes(60), [60]);
});

test('a range opens the next one only after 90% mastered and every mastered word passed a check', () => {
  const words = ranked(600);
  const progress = {};
  for (const word of words.slice(0, 89)) progress[word.word] = { mastered: true, learnedOn: '2026-01-01' };
  let status = advanceRange(words, progress, 'daily', 0);
  assert.equal(status.size, 100); assert.equal(status.checking, false); assert.equal(status.pending.length, 0);
  progress.w90 = { mastered: true, learnedOn: '2026-01-01' };
  status = advanceRange(words, progress, 'daily', 0);
  assert.equal(status.size, 100); assert.equal(status.checking, true); assert.equal(status.pending.length, 90);
  const session = buildSession(words, progress, { category: 'daily', rangeSize: status.size, checks: status.pending, newLimit: 2, rng: () => 0 });
  assert.equal(session.queue.filter((entry) => entry.kind === 'check').length, 10);
  for (const word of status.pending) progress[word.word].checkedRange = 100;
  status = advanceRange(words, progress, 'daily', 0);
  assert.equal(status.size, 500); assert.equal(status.level, 1); assert.equal(status.checking, false);
  assert.equal(rangeStatus(words, progress, 'daily', 1).mastered, 90);
});

test('the last range runs its check round and then stays complete', () => {
  const words = ranked(50);
  const progress = Object.fromEntries(words.map((word) => [word.word, { mastered: true, checkedRange: 50, learnedOn: '2026-01-01' }]));
  const status = advanceRange(words, progress, 'daily', 0);
  assert.equal(status.last, true); assert.equal(status.complete, true); assert.equal(status.pending.length, 0);
});

test('progress validation keeps familiar fields and drops malformed ones', () => {
  const ok = { reps: 1, interval: 1, ease: 2.5, due: 1, lapses: 0, familiarOn: ['2026-11-01'], mastered: true, checkedRange: 100 };
  assert.deepEqual(validateProgress({ ok }), { ok });
  assert.deepEqual(validateProgress({ a: { familiarOn: 'x' }, b: { mastered: 'yes' }, c: { checkedRange: '100' } }), {});
});
