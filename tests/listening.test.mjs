import test from 'node:test';
import assert from 'node:assert/strict';
import { isListening, startListening, stopListening } from '../pronounce.js';

// Minimal stand-in for webkitSpeechRecognition that lets a test fire events by hand.
function fakeEnv() {
  const made = [];
  class FakeRecognition {
    constructor() { this.stopped = 0; made.push(this); }
    start() { this.onstart?.(); }
    stop() { this.stopped += 1; }
    emit(transcript, isFinal) {
      const alt = { transcript, confidence: 0 };
      const result = Object.assign([alt], { isFinal });
      this.onresult?.({ resultIndex: 0, results: [result] });
    }
    end() { this.onend?.(); }
  }
  return { env: { webkitSpeechRecognition: FakeRecognition }, made };
}

test('interim-only session (iOS) is judged on end instead of reporting no speech', () => {
  const { env, made } = fakeEnv();
  const got = [];
  let noResult = 0;
  startListening({ onResult: (a) => got.push(a[0].transcript), onNoResult: () => { noResult += 1; } }, env);
  made[0].emit('lay', false);
  made[0].emit('layover', false);
  made[0].end();
  assert.deepEqual(got, ['layover']);
  assert.equal(noResult, 0);
  assert.equal(isListening(), false);
});

test('final result is reported once and releases the mic', () => {
  const { env, made } = fakeEnv();
  const got = [];
  startListening({ onResult: (a) => got.push(a[0].transcript) }, env);
  made[0].emit('suite', true);
  assert.equal(made[0].stopped, 1);
  made[0].end();
  assert.deepEqual(got, ['suite']);
});

test('second attempt after a judged first attempt gets its own result', () => {
  const { env, made } = fakeEnv();
  const got = [];
  const handlers = { onResult: (a) => got.push(a[0].transcript) };
  startListening(handlers, env);
  made[0].emit('sweet', true);
  // iOS has not fired onend yet; the app drops the old session and starts again.
  stopListening();
  startListening(handlers, env);
  made[0].end(); // late end from the first session must not disturb the second
  assert.equal(isListening(), true);
  made[1].emit('suite', true);
  made[1].end();
  assert.deepEqual(got, ['sweet', 'suite']);
  assert.equal(isListening(), false);
});

test('silence with no results still reports no speech', () => {
  const { env, made } = fakeEnv();
  let noResult = 0;
  startListening({ onNoResult: () => { noResult += 1; } }, env);
  made[0].end();
  assert.equal(noResult, 1);
});

test('an error message is not overwritten by "no speech" on end', () => {
  const { env, made } = fakeEnv();
  const errors = [];
  let noResult = 0;
  startListening({ onError: (e) => errors.push(e), onNoResult: () => { noResult += 1; } }, env);
  made[0].onerror?.({ error: 'not-allowed' });
  made[0].end();
  assert.deepEqual(errors, ['not-allowed']);
  assert.equal(noResult, 0);
});
