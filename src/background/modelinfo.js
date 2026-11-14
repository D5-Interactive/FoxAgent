// Ask the model server what it is actually running: context window, tool and
// image support, and parameter count. Model ids alone are a poor guide
// ("llama3.2" says nothing about size, "llama-3.2" may or may not see images),
// and the window a local server allocates is often far smaller than the one
// the model was trained for. Every probe is best effort: a missing endpoint or
// an unknown answer leaves the field null and callers fall back to settings.

const TTL_MS = 10 * 60e3;
const FAIL_TTL_MS = 60e3;
const PROBE_MS = 4e3;
// LM Studio loads a model on first request (JIT) with its own default window.
// Until the model is loaded we cannot read the real value, so assume the
// common default rather than the trained maximum.
const LMSTUDIO_JIT_GUESS = 4096;
const cache = new Map();

function serverRoot(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function emptyInfo(source = "") {
  return {
    source,
    contextWindow: null,   // what the server will actually use for this model
    trainedWindow: null,   // the model's own maximum, when the server reports it
    tools: null,           // true / false / null (unknown)
    vision: null,
    thinking: null,
    paramsB: 0,            // parameter count in billions, 0 when unknown
    guessed: false         // true when contextWindow is an assumption
  };
}

async function getJson(url, init = {}, ms = PROBE_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseParams(value) {
  const m = String(value || "").trim().match(/^([\d.]+)\s*([KMBT])?/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] || "B").toUpperCase();
  const scale = { K: 1e-6, M: 1e-3, B: 1, T: 1e3 }[unit] || 1;
  return Number.isFinite(n) ? Math.round(n * scale * 100) / 100 : 0;
}

function positive(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

// Ollama: /api/show has the trained window, capabilities and size. /api/ps has
// the window of the loaded runner, when the model is loaded.
export function readOllamaShow(show, ps, model) {
  const info = emptyInfo("ollama");
  if (!show) return info;
  let trained = null;
  for (const [key, value] of Object.entries(show.model_info || {})) {
    if (/\.context_length$/.test(key)) trained = Math.max(trained || 0, positive(value) || 0) || trained;
  }
  info.trainedWindow = trained;
  const param = String(show.parameters || "").match(/num_ctx\s+(\d+)/);
  const modelfileCtx = param ? positive(param[1]) : null;
  const running = (ps?.models || []).find((m) => m?.name === model || m?.model === model);
  info.contextWindow = positive(running?.context_length) || modelfileCtx || null;
  const caps = Array.isArray(show.capabilities) ? show.capabilities : null;
  if (caps) {
    info.tools = caps.includes("tools");
    info.vision = caps.includes("vision");
    info.thinking = caps.includes("thinking");
  }
  info.paramsB = parseParams(show.details?.parameter_size);
  return info;
}

export function readLmStudio(entry) {
  const info = emptyInfo("lmstudio");
  if (!entry) return info;
  info.trainedWindow = positive(entry.max_context_length);
  info.contextWindow = positive(entry.loaded_context_length);
  if (!info.contextWindow) {
    info.contextWindow = Math.min(info.trainedWindow || LMSTUDIO_JIT_GUESS, LMSTUDIO_JIT_GUESS);
    info.guessed = true;
  }
  const caps = Array.isArray(entry.capabilities) ? entry.capabilities : null;
  if (caps) info.tools = caps.includes("tool_use");
  if (entry.type) info.vision = entry.type === "vlm";
  return info;
}

export function readLlamaCpp(props) {
  const info = emptyInfo("llamacpp");
  if (!props) return info;
  info.contextWindow = positive(props.default_generation_settings?.n_ctx) || positive(props.n_ctx);
  if (props.modalities && typeof props.modalities.vision === "boolean") info.vision = props.modalities.vision;
  return info;
}

export function readOpenAiModels(list, model) {
  const info = emptyInfo("models");
  const entry = (list?.data || []).find((m) => m?.id === model);
  if (!entry) return info;
  // vLLM reports max_model_len; some gateways use context_length / context_window.
  info.contextWindow = positive(entry.max_model_len) || positive(entry.context_length) || positive(entry.context_window);
  return info;
}

async function probe(provider, model) {
  const key = provider.key;
  const root = serverRoot(provider.baseUrl);
  const auth = provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {};
  if (key === "ollama") {
    const [show, ps] = await Promise.all([
      getJson(root + "/api/show", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) }),
      getJson(root + "/api/ps")
    ]);
    return readOllamaShow(show, ps, model);
  }
  if (key === "lmstudio") {
    const one = await getJson(root + "/api/v0/models/" + encodeURIComponent(model), { headers: auth });
    if (one) return readLmStudio(one);
    const all = await getJson(root + "/api/v0/models", { headers: auth });
    return readLmStudio((all?.data || []).find((m) => m?.id === model));
  }
  if (key === "llamacpp") {
    return readLlamaCpp(await getJson(root + "/props", { headers: auth }));
  }
  // vLLM and custom OpenAI-compatible servers.
  const fromModels = readOpenAiModels(await getJson(serverRoot(provider.baseUrl) + "/v1/models", { headers: auth }), model);
  if (fromModels.contextWindow || key === "vllm") return fromModels;
  const props = readLlamaCpp(await getJson(root + "/props", { headers: auth }));
  return props.contextWindow ? props : fromModels;
}

// Returns model facts for a local or custom provider; cloud providers return an
// empty record (their windows are large and the character budget governs).
export async function modelInfo(provider, model, { refresh = false } = {}) {
  if (!provider || !model || provider.cloud) return emptyInfo(provider?.cloud ? "cloud" : "");
  const cacheKey = `${provider.key}|${provider.baseUrl}|${model}`;
  const hit = cache.get(cacheKey);
  if (!refresh && hit && Date.now() - hit.at < (hit.ok ? TTL_MS : FAIL_TTL_MS)) return hit.info;
  let info;
  try {
    info = await probe(provider, model);
  } catch {
    info = emptyInfo(provider.key);
  }
  // A guessed window (LM Studio before the model is loaded) changes as soon as
  // the first request loads the model, so it is never cached.
  if (!info.guessed) {
    const ok = Boolean(info.contextWindow || info.trainedWindow || info.tools != null);
    cache.set(cacheKey, { at: Date.now(), ok, info });
  }
  return info;
}

export function forgetModelInfo(provider, model) {
  if (!provider) return;
  cache.delete(`${provider.key}|${provider.baseUrl}|${model}`);
}

// The num_ctx FoxAgent asks Ollama for: the user's setting, never above what
// the model was trained for, never below what the prompt and tools need.
export function ollamaNumCtx(info, settings) {
  const wanted = Math.max(2048, Number(settings?.localContextTokens) || 16384);
  const trained = info?.trainedWindow || 0;
  return trained ? Math.min(wanted, trained) : wanted;
}

export { serverRoot, parseParams, emptyInfo };
