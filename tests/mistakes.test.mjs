import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMistakes, recordMistake, markFixed, activeWords, activeEventsOf, confusionPairs, mistakeCount } from '../mistakes.js';

const ev = (mode, heard, level, at) => ({ mode, heard, level, at });

test('recordMistake appends without mutating and caps 10 events per word per mode', () => {
  const empty = {};
  let book = recordMistake(empty, 'luggage', ev('speak', 'language', 'miss', 1));
  assert.deepEqual(empty, {});
  assert.equal(mistakeCount(book, 'luggage'), 1);
  const before = JSON.stringify(book);
  const next = recordMistake(book, 'luggage', ev('spell', 'lugage', 'wrong', 2));
  assert.equal(JSON.stringify(book), before);
  assert.notEqual(next, book);
  for (let i = 0; i < 14; i++) book = recordMistake(book, 'luggage', ev('speak', `h${i}`, 'miss', 10 + i));
  const speak = book.luggage.events.filter((e) => e.mode === 'speak');
  assert.equal(speak.length, 10);
  assert.deepEqual(speak.map((e) => e.heard), Array.from({ length: 10 }, (_, i) => `h${i + 4}`));
  const mixed = recordMistake(book, 'luggage', ev('listen', '語言', 'wrong', 99));
  assert.equal(mixed.luggage.events.filter((e) => e.mode === 'speak').length, 10);
  assert.equal(mistakeCount(mixed, 'luggage'), 11);
  assert.equal(mistakeCount(mixed, 'nope'), 0);
});

test('markFixed only touches existing words, sets per-mode time and does not mutate', () => {
  const book = recordMistake({}, 'a', ev('speak', 'x', 'miss', 1));
  const same = markFixed(book, 'zzz', 'speak', 5);
  assert.deepEqual(same, book);
  assert.equal(same.zzz, undefined);
  const fixed = markFixed(book, 'a', 'speak', 5);
  assert.deepEqual(fixed.a.fixed, { speak: 5 });
  assert.deepEqual(book.a.fixed, {});
  assert.deepEqual(markFixed(fixed, 'a', 'spell', 7).a.fixed, { speak: 5, spell: 7 });
});

test('activeWords uses per-mode fixed time and sorts by active count then recency', () => {
  let book = {};
  book = recordMistake(book, 'a', ev('speak', 'x', 'miss', 1));
  book = recordMistake(book, 'b', ev('speak', 'x', 'miss', 5));
  book = recordMistake(book, 'b', ev('speak', 'y', 'miss', 6));
  book = recordMistake(book, 'c', ev('spell', 'cc', 'wrong', 9));
  book = recordMistake(book, 'd', ev('speak', 'x', 'miss', 2));
  // b has 2 active events; then c (latest 9), d (2), a (1).
  assert.deepEqual(activeWords(book), ['b', 'c', 'd', 'a']);
  // Fixing speak does not clear a spell mistake.
  book = recordMistake(book, 'a', ev('spell', 'aa', 'wrong', 3));
  book = markFixed(book, 'a', 'speak', 4);
  assert.deepEqual(activeEventsOf(book, 'a').map((e) => e.mode), ['spell']);
  book = markFixed(book, 'd', 'speak', 3);
  assert.ok(!activeWords(book).includes('d'));
  // A later event re-activates the word.
  book = recordMistake(book, 'd', ev('speak', 'z', 'close', 8));
  assert.deepEqual(activeEventsOf(book, 'd').map((e) => e.at), [8]);
  assert.deepEqual(activeWords(book), ['b', 'c', 'd', 'a']);
  assert.deepEqual(activeEventsOf(book, 'missing'), []);
});

test('confusionPairs normalizes, skips self-matches and non speak/spell, applies threshold, includes fixed history', () => {
  let book = {};
  for (const heard of ['Language', ' language ', 'LANGUAGE']) book = recordMistake(book, 'luggage', ev('speak', heard, 'miss', 1));
  book = recordMistake(book, 'luggage', ev('speak', 'Luggage', 'close', 2));
  book = recordMistake(book, 'luggage', ev('speak', '', 'skip', 3));
  book = recordMistake(book, 'luggage', ev('listen', '語言', 'wrong', 4));
  book = recordMistake(book, 'luggage', ev('listen', '語言', 'wrong', 5));
  book = recordMistake(book, 'sweet', ev('spell', 'swet', 'wrong', 1));
  book = recordMistake(book, 'sweet', ev('spell', 'swet', 'wrong', 3));
  book = recordMistake(book, 'sweet', ev('spell', 'sw  et', 'wrong', 4));
  book = recordMistake(book, 'sweet', ev('spell', 'sw et', 'wrong', 5));
  book = markFixed(book, 'luggage', 'speak', 100);
  const pairs = confusionPairs(book);
  assert.deepEqual(pairs.map((p) => [p.word, p.heard, p.count]), [['luggage', 'language', 3], ['sweet', 'swet', 2], ['sweet', 'sw et', 2]]);
  assert.equal(pairs[0].mode, 'speak');
  assert.equal(pairs[1].mode, 'spell');
  assert.equal(confusionPairs(book, 3).length, 1);
  assert.equal(confusionPairs(book, 1).length, 3);
});

test('validateMistakes drops malformed entries and events', () => {
  assert.deepEqual(validateMistakes(null), {});
  assert.deepEqual(validateMistakes([]), {});
  assert.deepEqual(validateMistakes('x'), {});
  const cleaned = validateMistakes({
    ok: { events: [ev('speak', 'x', 'miss', 1), { mode: 'bogus', heard: 'x', level: 'miss', at: 1 }, ev('spell', 5, 'wrong', 1), ev('listen', 'x', 'nope', 1), ev('speak', 'x', 'miss', NaN), null, 'junk'], fixed: { speak: 3, spell: 'x', other: 4 } },
    noEvents: { events: [], fixed: {} },
    allBad: { events: [{ mode: 'speak' }], fixed: {} },
    notObject: 5,
    noArray: { events: 'x' },
    noFixed: { events: [ev('listen', '語言', 'wrong', 2)] },
  });
  assert.deepEqual(Object.keys(cleaned).sort(), ['noFixed', 'ok']);
  assert.deepEqual(cleaned.ok.events, [ev('speak', 'x', 'miss', 1)]);
  assert.deepEqual(cleaned.ok.fixed, { speak: 3 });
  assert.deepEqual(cleaned.noFixed.fixed, {});
});
