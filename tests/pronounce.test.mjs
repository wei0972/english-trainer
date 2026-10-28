import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, matchResult, tipsForKK, stressKK } from '../pronounce.js';

test('normalize removes punctuation and standardizes hyphens and spaces', () => {
  assert.equal(normalize("Check-out, PLEASE!"), 'check out please');
  assert.equal(normalize("I'll"), 'ill');
});

test('matchResult distinguishes first candidate clear, later close and miss', () => {
  assert.equal(matchResult('luggage', [{ transcript: 'luggage', confidence: 0.8 }]).level, 'clear');
  assert.equal(matchResult('luggage', [{ transcript: 'luggage rack', confidence: 0.2 }]).level, 'clear');
  assert.equal(matchResult('luggage', [{ transcript: 'language' }, { transcript: 'luggage' }]).level, 'close');
  assert.equal(matchResult('luggage', [{ transcript: 'language' }]).level, 'miss');
});

test('matchResult accepts spacing variants, spoken forms, homophones and word boundaries', () => {
  for (const [target, heard] of [['checkout', 'check-out'], ['gonna', 'going to'], ['suite', 'sweet'], ['aisle', "I'll"], ['fare', 'fair']]) {
    assert.notEqual(matchResult(target, [{ transcript: heard }]).level, 'miss', `${target} / ${heard}`);
  }
  assert.equal(matchResult('suite', [{ transcript: 'suite' }]).level, 'clear');
  assert.equal(matchResult('suite', [{ transcript: 'sweet' }]).level, 'close');
  assert.equal(matchResult('bag', [{ transcript: 'the baggage' }]).level, 'miss');
  assert.equal(matchResult('luggage', [{ transcript: 'the luggage' }]).level, 'clear');
  assert.notEqual(matchResult('okay', [{ transcript: 'ok' }]).level, 'miss');
  assert.notEqual(matchResult('okay', [{ transcript: 'o.k.' }]).level, 'miss');
});

test('tipsForKK returns at most two pronunciation cues and stressKK marks the stressed syllable', () => {
  assert.ok(tipsForKK('θɪŋk').some((tip) => tip.includes('th')));
  assert.ok(tipsForKK('ˋvɝb').some((tip) => tip.includes('捲舌')));
  assert.ok(tipsForKK('kæt').some((tip) => tip.includes('æ')));
  assert.ok(tipsForKK('lɪft').some((tip) => tip.includes('字尾')));
  assert.ok(tipsForKK('ˋkɑˏtə').some((tip) => tip.includes('重音')));
  assert.ok(tipsForKK('ˋrɪl').some((tip) => tip.includes('r 捲舌')));
  assert.ok(tipsForKK('ˋvɝ').length <= 2);
  assert.match(stressKK('ˋleˏovɚ'), /<strong>ˋle<\/strong>/);
  assert.doesNotMatch(stressKK('<img src=x>ˋvɝb'), /<img/);
  assert.ok(tipsForKK('pɪḷ').some((tip) => tip.includes('字尾')));
  assert.ok(tipsForKK('fɑṇ').some((tip) => tip.includes('字尾')));
});
