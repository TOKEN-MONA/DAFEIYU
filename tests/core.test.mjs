import test from 'node:test';
import assert from 'node:assert/strict';

import {
  priceFor,
  isPeakTime,
  isTransientBalanceResult,
  parseModelResponse,
  rollEngineLedger,
  shouldRetryBalanceResult,
  usageTokenCount,
  rollBalanceLedger,
} from '../core.js';

test('flash pricing follows the current official price table', () => {
  assert.deepEqual(priceFor('deepseek-flash'), {
    hit: [0.02, 0.04],
    miss: [1.0, 2.0],
    out: [4.0, 8.0],
  });
  assert.deepEqual(priceFor('DeepSeek-V4-FLASH'), priceFor('deepseek-flash'));
});

test('peak windows use Beijing time and weekends are valley', () => {
  // 2026-09-12 Saturday 10:00 Beijing
  assert.equal(isPeakTime(Date.UTC(2026, 8, 12, 2) / 1000), false);
  // 2026-09-14 Monday 10:00 Beijing
  assert.equal(isPeakTime(Date.UTC(2026, 8, 14, 2) / 1000), true);
  // 2026-09-14 Monday 13:00 Beijing
  assert.equal(isPeakTime(Date.UTC(2026, 8, 14, 5) / 1000), false);
});

test('parses usage and generated text from a streamed response', () => {
  const text = [
    'data: {"model":"deepseek-flash","choices":[{"delta":{"content":"你"}}]}',
    'data: {"model":"deepseek-flash","choices":[{"delta":{"content":"好"}}]}',
    'data: {"model":"deepseek-flash","choices":[{"delta":{"content":""}}],"usage":{"prompt_tokens":20,"prompt_cache_hit_tokens":5,"prompt_cache_miss_tokens":15,"completion_tokens":2}}',
    'data: [DONE]',
  ].join('\n\n');
  const parsed = parseModelResponse(text);
  assert.equal(parsed.model, 'deepseek-flash');
  assert.equal(parsed.outputText, '你好');
  assert.equal(parsed.usage.prompt_tokens, 20);
  assert.equal(parsed.usage.prompt_cache_hit_tokens, 5);
});

test('parses non-streaming JSON responses', () => {
  const parsed = parseModelResponse(JSON.stringify({
    model: 'deepseek-flash',
    choices: [{ message: { content: 'hello' } }],
    usage: { prompt_tokens: 7, completion_tokens: 2 },
  }));
  assert.equal(parsed.model, 'deepseek-flash');
  assert.equal(parsed.outputText, 'hello');
  assert.equal(parsed.usage.prompt_tokens, 7);
});

test('engine ledger archives yesterday and accumulates today', () => {
  const result = rollEngineLedger({
    date: '2026-09-11',
    todayUsage: 1,
    todayTokens: 100,
    todayEstimated: 0,
    history: { '2026-09-10': 0.5 },
  }, {
    amount: 0.25,
    tokens: { hit: 1, miss: 2, out: 3 },
  }, true, '2026-09-12');

  assert.equal(result.date, '2026-09-12');
  assert.equal(result.todayUsage, 0.25);
  assert.equal(result.todayTokens, 6);
  assert.equal(result.todayEstimated, 1);
  assert.equal(result.history['2026-09-11'], 1);
  assert.equal(result.history['2026-09-10'], 0.5);
});

test('balance ledger carries engine usage recorded before the first balance query', () => {
  const first = rollBalanceLedger({
    date: '2026-09-11',
    lastBalance: 10,
    lastCurrency: 'CNY',
    todayUsage: 1,
    history: {},
  }, 9, 'CNY', 0.3, '2026-09-12');

  assert.equal(first.date, '2026-09-12');
  assert.equal(first.lastBalance, 9);
  assert.equal(first.carryUsage, 0.3);
  assert.equal(first.todayUsage, 0.3);

  const second = rollBalanceLedger(first, 8, 'CNY', 0.3, '2026-09-12');
  assert.equal(second.todayUsage, 1.3);
  assert.equal(second.lastBalance, 8);
});

test('balance ledger keeps accrued usage across a top-up', () => {
  const start = {
    date: '2026-09-12',
    lastBalance: 9,
    lastCurrency: 'CNY',
    carryUsage: 0.3,
    balanceUsage: 0,
    todayUsage: 0.3,
  };
  const spent = rollBalanceLedger(start, 8, 'CNY', 0.3, '2026-09-12');
  assert.equal(spent.todayUsage, 1.3);

  const toppedUp = rollBalanceLedger(spent, 20, 'CNY', 0.3, '2026-09-12');
  assert.equal(toppedUp.lastBalance, 20);
  assert.equal(toppedUp.todayUsage, 1.3);

  const spentAgain = rollBalanceLedger(toppedUp, 19, 'CNY', 0.3, '2026-09-12');
  assert.equal(spentAgain.todayUsage, 2.3);
});
test('balance transient and retry classification follows upstream behavior', () => {
  assert.equal(shouldRetryBalanceResult({ ok: false, code: 'ERROR' }), true);
  assert.equal(shouldRetryBalanceResult({ ok: false, code: 'HTTP500' }), true);
  assert.equal(shouldRetryBalanceResult({ ok: false, code: 'HTTP503' }), true);
  assert.equal(shouldRetryBalanceResult({ ok: false, code: 'HTTP401' }), false);
  assert.equal(shouldRetryBalanceResult({ ok: false, code: 'SHAPE' }), false);

  assert.equal(isTransientBalanceResult({ ok: false, code: 'ERROR' }), true);
  assert.equal(isTransientBalanceResult({ ok: false, code: 'HTTP500' }), true);
  assert.equal(isTransientBalanceResult({ ok: false, code: 'HTTP401' }), false);
  assert.equal(isTransientBalanceResult({ ok: false, code: 'BASE' }), false);
});

test('model response parser preserves the usage chunk creation time', () => {
  const parsed = parseModelResponse([
    'data: {"created":1770000000,"model":"deepseek-flash","choices":[{"delta":{"content":"你"}}]}',
    'data: {"created":1770000060,"model":"deepseek-flash","choices":[{"delta":{"content":""}}],"usage":{"prompt_tokens":20,"completion_tokens":2}}',
    'data: [DONE]',
  ].join('\n\n'));
  assert.equal(parsed.createdAtSec, 1770000060);
});

test('usage token count uses the full hit/miss/output total', () => {
  assert.equal(usageTokenCount({
    hit: 1,
    miss: 20,
    out: 2,
  }), 23);
  assert.equal(usageTokenCount(null), 0);
});
