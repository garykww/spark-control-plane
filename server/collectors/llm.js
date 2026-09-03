import { config } from '../config.js';

/*
 * Probes an inference server over plain HTTP from wherever this dashboard runs,
 * so the LLM port has to be reachable on the LAN (the usual case when the server
 * binds 0.0.0.0). Detection is by response shape rather than configuration:
 *
 *   /v1/models   OpenAI-compatible - vLLM, llama.cpp, SGLang, LM Studio, TGI
 *   /api/tags    Ollama's native API
 *   /metrics     Prometheus counters, whose key prefix names the backend
 *
 * Throughput is not reported directly by most backends, so cumulative token
 * counters are diffed between polls in monitor.js the same way network rates are.
 */

const BACKEND_BY_METRIC_PREFIX = [
  ['vllm:', 'vLLM'],
  ['llamacpp:', 'llama.cpp'],
  ['sglang:', 'SGLang'],
  ['tgi_', 'TGI'],
];

async function getJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getText(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/*
 * Prometheus exposition format. Labels are ignored and samples with the same
 * name are summed, which is what we want for per-model or per-worker splits.
 */
export function parsePrometheus(text) {
  const metrics = {};

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(-?[\d.eE+]+|NaN)$/.exec(trimmed);
    if (!match) continue;

    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    metrics[match[1]] = (metrics[match[1]] ?? 0) + value;
  }

  return metrics;
}

const firstOf = (metrics, names) => {
  for (const name of names) {
    if (metrics[name] !== undefined) return metrics[name];
  }
  return null;
};

export function readLlmCounters(metrics) {
  return {
    generatedTokens: firstOf(metrics, [
      'vllm:generation_tokens_total',
      'llamacpp:tokens_predicted_total',
      'sglang:generation_tokens_total',
      'tgi_request_generated_tokens_sum',
    ]),
    promptTokens: firstOf(metrics, [
      'vllm:prompt_tokens_total',
      'llamacpp:prompt_tokens_total',
      'sglang:prompt_tokens_total',
      'tgi_request_input_length_sum',
    ]),
    running: firstOf(metrics, [
      'vllm:num_requests_running',
      'llamacpp:requests_processing',
      'sglang:num_running_reqs',
      'tgi_batch_current_size',
    ]),
    queued: firstOf(metrics, [
      'vllm:num_requests_waiting',
      'llamacpp:requests_deferred',
      'sglang:num_queue_reqs',
      'tgi_queue_size',
    ]),
    /* Some backends publish a ready-made rate; prefer it over our own diffing. */
    reportedDecodeRate: firstOf(metrics, [
      'vllm:avg_generation_throughput_toks_per_s',
      'llamacpp:predicted_tokens_seconds',
    ]),
    reportedPrefillRate: firstOf(metrics, [
      'vllm:avg_prompt_throughput_toks_per_s',
      'llamacpp:prompt_tokens_seconds',
    ]),
    /*
     * Prompt tokens served from the prefix cache. vLLM counts these inside
     * prompt_tokens_total, so prefill throughput includes work that was never
     * done - which is exactly why this is worth showing beside it. Only vLLM
     * publishes it; the other backends report nothing here and it stays null.
     */
    cachedTokens: firstOf(metrics, ['vllm:prompt_tokens_cached_total']),
    kvCacheUsage: firstOf(metrics, [
      /* vLLM's V1 engine renamed this; the old name stays for older servers. */
      'vllm:kv_cache_usage_perc',
      'vllm:gpu_cache_usage_perc',
      'llamacpp:kv_cache_usage_ratio',
      'sglang:token_usage',
    ]),
  };
}

function backendFromMetrics(metrics) {
  const keys = Object.keys(metrics);
  for (const [prefix, name] of BACKEND_BY_METRIC_PREFIX) {
    if (keys.some((k) => k.startsWith(prefix))) return name;
  }
  return null;
}

/*
 * Returns a probe result for one endpoint. Never throws: an unreachable port is
 * a normal steady state (the model server simply is not running yet), so it is
 * reported as offline with the reason attached.
 */
export async function probeLlmEndpoint(endpoint) {
  const { host, port, label } = endpoint;
  const base = `http://${host}:${port}`;
  const timeout = config.httpProbeTimeoutMs;
  const startedAt = Date.now();

  const result = {
    id: `${host}:${port}`,
    label: label || `${port}`,
    port,
    online: false,
    backend: null,
    models: [],
    error: null,
    latencyMs: null,
    counters: null,
  };

  /* Identify the server and its loaded models. */
  try {
    const data = await getJson(`${base}/v1/models`, timeout);
    result.online = true;
    result.backend = 'OpenAI-compatible';
    result.models = (data?.data ?? []).map((m) => m.id).filter(Boolean);
  } catch (err) {
    try {
      const data = await getJson(`${base}/api/tags`, timeout);
      result.online = true;
      result.backend = 'Ollama';
      result.models = (data?.models ?? []).map((m) => m.name).filter(Boolean);
    } catch {
      result.error = String(err?.message || err);
    }
  }

  /* Metrics are optional, and also sharpen the backend name when present. */
  try {
    const metrics = parsePrometheus(await getText(`${base}/metrics`, timeout));
    if (Object.keys(metrics).length > 0) {
      result.online = true;
      result.error = null;
      result.counters = readLlmCounters(metrics);
      result.backend = backendFromMetrics(metrics) ?? result.backend ?? 'unknown';
    }
  } catch {
    /* No /metrics endpoint - throughput stays unavailable but the probe stands. */
  }

  result.latencyMs = result.online ? Date.now() - startedAt : null;
  return result;
}

export async function probeLlmEndpoints(endpoints) {
  return Promise.all(endpoints.map((e) => probeLlmEndpoint(e)));
}
