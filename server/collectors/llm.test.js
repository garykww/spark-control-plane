import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrometheus, readLlmCounters } from './llm.js';

test('parsePrometheus skips comments and sums samples sharing a name', () => {
  const metrics = parsePrometheus(
    [
      '# HELP vllm:generation_tokens_total Number of generated tokens.',
      '# TYPE vllm:generation_tokens_total counter',
      'vllm:generation_tokens_total{model_name="llama"} 1200',
      'vllm:generation_tokens_total{model_name="qwen"} 300',
      'vllm:num_requests_running 4',
      'vllm:broken_line',
      'vllm:not_a_number NaN',
    ].join('\n'),
  );

  assert.equal(metrics['vllm:generation_tokens_total'], 1500);
  assert.equal(metrics['vllm:num_requests_running'], 4);
  assert.equal(metrics['vllm:broken_line'], undefined);
  assert.equal(metrics['vllm:not_a_number'], undefined);
});

test('parsePrometheus reads scientific notation and bare metric names', () => {
  const metrics = parsePrometheus('llamacpp:tokens_predicted_total 1.5e3\nllamacpp:kv_cache_usage_ratio 0.42');
  assert.equal(metrics['llamacpp:tokens_predicted_total'], 1500);
  assert.equal(metrics['llamacpp:kv_cache_usage_ratio'], 0.42);
});

test('readLlmCounters maps vLLM metric names to the shared shape', () => {
  const counters = readLlmCounters({
    'vllm:generation_tokens_total': 900,
    'vllm:prompt_tokens_total': 4000,
    'vllm:num_requests_running': 2,
    'vllm:num_requests_waiting': 1,
    'vllm:gpu_cache_usage_perc': 0.31,
  });

  assert.equal(counters.generatedTokens, 900);
  assert.equal(counters.promptTokens, 4000);
  assert.equal(counters.running, 2);
  assert.equal(counters.queued, 1);
  assert.equal(counters.kvCacheUsage, 0.31);
});

/* vLLM's V1 engine renamed the KV gauge. A server exposing either name has to
 * report the same figure, or the panel silently loses the reading. */
test('readLlmCounters reads the KV gauge under either vLLM name', () => {
  const v1 = readLlmCounters({ 'vllm:kv_cache_usage_perc': 0.62 });
  const v0 = readLlmCounters({ 'vllm:gpu_cache_usage_perc': 0.31 });

  assert.equal(v1.kvCacheUsage, 0.62);
  assert.equal(v0.kvCacheUsage, 0.31);
});

/* Cached prompt tokens are counted inside vLLM's prompt-token total, so the
 * panel can only tell the two apart if this counter is read. */
test('readLlmCounters reads cached prompt tokens where the backend reports them', () => {
  const vllm = readLlmCounters({
    'vllm:prompt_tokens_total': 6785034,
    'vllm:prompt_tokens_cached_total': 6380880,
  });
  assert.equal(vllm.cachedTokens, 6380880);

  /* A backend that does not publish it must report null, not zero - "no cache
   * reporting" and "nothing cached" are different claims. */
  assert.equal(readLlmCounters({ 'llamacpp:prompt_tokens_total': 700 }).cachedTokens, null);
});

test('readLlmCounters maps llama.cpp names to the same shape', () => {
  const counters = readLlmCounters({
    'llamacpp:tokens_predicted_total': 50,
    'llamacpp:prompt_tokens_total': 700,
    'llamacpp:requests_processing': 1,
  });

  assert.equal(counters.generatedTokens, 50);
  assert.equal(counters.promptTokens, 700);
  assert.equal(counters.running, 1);
  /* Absent metrics must stay null so the UI shows "unavailable", not zero. */
  assert.equal(counters.queued, null);
  assert.equal(counters.kvCacheUsage, null);
});
