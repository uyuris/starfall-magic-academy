import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OFFER_GENERATION_MAX_ATTEMPTS,
  generateGatedOfferTextWithRetry
} from '../src/llm/offerGenerationRetry.mjs';

const GATE_CODE = 'STUDY_CIRCLE_GENERATION_FAILED';

function gateError(message) {
  const error = new Error(message);
  error.statusCode = 503;
  error.errorCode = GATE_CODE;
  return error;
}

// The gate rejects '『' (a forbidden bracket) but accepts plain prose.
function forbiddenSymbolGate(candidate) {
  if (typeof candidate.appeal !== 'string' || candidate.appeal.includes('『')) {
    throw gateError('appeal must not contain quotation or bracket symbols: 『');
  }
  return candidate;
}

test('the retry cap is a single shared tunable of 3 attempts/offer', () => {
  assert.equal(OFFER_GENERATION_MAX_ATTEMPTS, 3);
});

test('a first-attempt gate violation recovers on the next clean regeneration', async () => {
  let attempt = 0;
  const result = await generateGatedOfferTextWithRetry({
    generate: async () => {
      attempt += 1;
      return { appeal: attempt === 1 ? '誘う『声』' : 'そのまま来てほしい' };
    },
    validate: forbiddenSymbolGate,
    generationErrorCode: GATE_CODE
  });
  assert.equal(attempt, 2, 'the offer is regenerated exactly once after the gate violation');
  assert.deepEqual(result, { appeal: 'そのまま来てほしい' });
});

test('a candidate the generator itself gates (throws the code) is also retried', async () => {
  let attempt = 0;
  const result = await generateGatedOfferTextWithRetry({
    generate: async () => {
      attempt += 1;
      if (attempt === 1) throw gateError('appeal must not contain quotation or bracket symbols: 『');
      return { appeal: '一緒にやろう' };
    },
    validate: forbiddenSymbolGate,
    generationErrorCode: GATE_CODE
  });
  assert.equal(attempt, 2);
  assert.deepEqual(result, { appeal: '一緒にやろう' });
});

test('every attempt violating the gate exhausts the cap and rethrows the last gate error', async () => {
  let attempt = 0;
  await assert.rejects(
    generateGatedOfferTextWithRetry({
      generate: async () => {
        attempt += 1;
        return { appeal: '『ずっと』' };
      },
      validate: forbiddenSymbolGate,
      generationErrorCode: GATE_CODE
    }),
    (error) => {
      assert.equal(error.errorCode, GATE_CODE);
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /must not contain quotation or bracket symbols/);
      return true;
    }
  );
  assert.equal(attempt, OFFER_GENERATION_MAX_ATTEMPTS, 'exactly the cap number of attempts are spent');
});

test('an LM connection failure is not retried — it fails fast on the first attempt', async () => {
  let attempt = 0;
  const connectionError = new Error('LM Studioの接続が確認できません。');
  connectionError.errorCode = 'LMSTUDIO_CONNECTION_UNAVAILABLE';
  connectionError.statusCode = 503;
  await assert.rejects(
    generateGatedOfferTextWithRetry({
      generate: async () => {
        attempt += 1;
        throw connectionError;
      },
      validate: forbiddenSymbolGate,
      generationErrorCode: GATE_CODE
    }),
    (error) => error.errorCode === 'LMSTUDIO_CONNECTION_UNAVAILABLE'
  );
  assert.equal(attempt, 1, 'a non-gate failure class is not retried');
});

test('a plain LM HTTP error (no errorCode) is not retried', async () => {
  let attempt = 0;
  await assert.rejects(
    generateGatedOfferTextWithRetry({
      generate: async () => {
        attempt += 1;
        throw new Error('LM Studio 500: internal error');
      },
      validate: forbiddenSymbolGate,
      generationErrorCode: GATE_CODE
    }),
    /LM Studio 500/
  );
  assert.equal(attempt, 1);
});

test('generate/validate/generationErrorCode are required', async () => {
  await assert.rejects(generateGatedOfferTextWithRetry({ validate: forbiddenSymbolGate, generationErrorCode: GATE_CODE }), /generate is required/);
  await assert.rejects(generateGatedOfferTextWithRetry({ generate: async () => ({}), generationErrorCode: GATE_CODE }), /validate is required/);
  await assert.rejects(generateGatedOfferTextWithRetry({ generate: async () => ({}), validate: forbiddenSymbolGate }), /generationErrorCode is required/);
});
