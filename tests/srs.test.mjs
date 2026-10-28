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

test('buildSession sorts due reviews, honors daily new limit and schedules missed words again', () => {
  const words = ['a', 'b', 'c', 'd', 'e', 'f'].map((word) => ({ word, tier: 1, category: ['daily'] }));
  const progress = {
    a: { reps: 1, interval: 2, ease: 2.5, due: 30, lapses: 0, learnedOn: '2026-01-01' },
    b: { reps: 1, interval: 2, ease: 2.5, due: 10, lapses: 0, learnedOn: '2026-01-01' },
  };
  const session = buildSession(words, progress, { category: 'daily', newLimit: 5, now: 100, rng: () => 0, todayNew: 1 });
  assert.deepEqual(session.queue.slice(0, 2).map((q) => q.word.word), ['b', 'a']);
  assert.equal(session.newWords.length, 4);
  assert.equal(session.next().word.word, 'b');
  assert.equal(session.next().word.word, 'a');
  const miss = session.next();
  assert.equal(miss.word.word, 'c');
  assert.equal(session.mark(miss, 'again'), true);
  assert.equal(session.next().word.word, 'd');
  assert.equal(session.next().word.word, 'e');
  assert.equal(session.next().word.word, 'f');
  assert.equal(session.next().word.word, 'c');
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

test('all 732 source sentences are masked at the form word boundary', async () => {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '../words.json');
  const words = JSON.parse(await readFile(source, 'utf8'));
  const sentences = words.flatMap((word) => word.sentences);
  assert.equal(sentences.length, 732);
  for (const sentence of sentences) {
    const masked = maskSentence(sentence.en, sentence.form);
    assert.ok(masked, `could not mask ${sentence.form}: ${sentence.en}`);
    assert.equal(maskSentence(masked, sentence.form), null, `form remains: ${sentence.form}: ${masked}`);
  }
});
