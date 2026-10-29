import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { grade, buildSession, validateProgress, maskSentence, uniqueChoices, finalConsonant } from '../srs.js';

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

test('every source sentence (6 per word) is masked at the form word boundary', async () => {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '../words.json');
  const words = JSON.parse(await readFile(source, 'utf8'));
  const sentences = words.flatMap((word) => word.sentences);
  assert.equal(sentences.length, words.length * 6);
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

test('buildSession weights new words by the tier of the selected category', () => {
  // 'x' is tier 1 in senior but tier 3 in daily; 'y' is the opposite. rng 0.5 picks by weight.
  const words = [
    { word: 'x', tier: 1, tiers: { daily: 3, senior: 1 }, category: ['daily', 'senior'] },
    { word: 'y', tier: 1, tiers: { daily: 1, senior: 3 }, category: ['daily', 'senior'] },
  ];
  const pick = (category) => buildSession(words, {}, { category, newLimit: 1, rng: () => 0.5 }).newWords[0].word;
  assert.equal(pick('senior'), 'x');
  assert.equal(pick('daily'), 'y');
});
