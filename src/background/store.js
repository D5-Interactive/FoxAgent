import { loadSessions, saveSessions } from "./sessions.js";
const PROVIDERS = {
  lmstudio: {
    label: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    hint: "Start the local server in LM Studio, load a tool-capable model, then enable the server."
  },
  ollama: {
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    hint: "Requires a tool-capable model, e.g. qwen2.5:7b or llama3.1:8b. Uses Ollama's OpenAI-compatible endpoint."
  },
  vllm: {
    label: "vLLM",
    baseUrl: "http://localhost:8000/v1",
    hint: "Start with --enable-auto-tool-choice --tool-call-parser hermes (or your model's parser)."
  },
  llamacpp: {
    label: "llama.cpp",
    baseUrl: "http://localhost:8080/v1",
    hint: "Run llama-server --jinja with a tool-capable GGUF; the /v1 endpoint is OpenAI-compatible."
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    baseUrl: "http://localhost:1234/v1",
    hint: "Any server exposing POST /chat/completions and GET /models."
  },
  openai: {
    label: "OpenAI \xB7 GPT",
    baseUrl: "https://api.openai.com/v1",
    hint: "Uses your OpenAI API key. Pick a tool-capable GPT model; usage is billed by OpenAI.",
    cloud: true,
    keyUrl: "https://platform.openai.com/api-keys"
  },
  anthropic: {
    label: "Anthropic \xB7 Claude",
    baseUrl: "https://api.anthropic.com/v1",
    hint: "Uses the Anthropic Messages API and your Claude API key. Tool use is supported.",
    cloud: true,
    kind: "anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys"
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    hint: "One key for many hosted models. Choose a tool-capable model; some are free.",
    cloud: true,
    keyUrl: "https://openrouter.ai/keys"
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    hint: "DeepSeek chat and reasoning models. Create an API key in the DeepSeek platform.",
    cloud: true,
    keyUrl: "https://platform.deepseek.com/api_keys"
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    hint: "Fast hosted open models. Create an API key in the Groq console.",
    cloud: true,
    keyUrl: "https://console.groq.com/keys"
  },
  mistral: {
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    hint: "Mistral's hosted API. Create a key in the Mistral console.",
    cloud: true,
    keyUrl: "https://console.mistral.ai/api-keys"
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    hint: "Uses Gemini's OpenAI-compatible endpoint with a Google AI Studio key.",
    cloud: true,
    keyUrl: "https://aistudio.google.com/app/apikey"
  },
  xai: {
    label: "xAI \xB7 Grok",
    baseUrl: "https://api.x.ai/v1",
    hint: "Grok models from xAI. Create an API key in the xAI console.",
    cloud: true,
    keyUrl: "https://console.x.ai"
  }
};
function defaultProviders() {
  return Object.fromEntries(
    Object.entries(PROVIDERS).map(([key, meta]) => [
      key,
      { baseUrl: meta.baseUrl, apiKey: "", model: "" }
    ])
  );
}
const DEFAULT_SETTINGS = {
  provider: "lmstudio",
  providers: defaultProviders(),
  temperature: 0.2,
  maxSteps: 32,
  maxOutputTokens: 8192,
  toolMode: "auto",
  vision: "auto",
  contextChars: 96e3,
  contextMigrated: false,
  maxPageChars: 12e3,
  approval: { read: "auto", act: "confirm", write: "confirm" },
  trustedSites: [],
  siteAllowlist: [],
  dryRun: false,
  packs: ["canvas"],
  autoUpdate: false,
  dismissedUpdate: ""
};
const state = {
  settings: structuredClone(DEFAULT_SETTINGS),
  log: [],
  models: []
};
const LOG_CAP = 400;
function clone(v) {
  return v == null ? v : structuredClone(v);
}
function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}
function mergeSettings(base, patch) {
  const deep = (target, source) => {
    const out = clone(target);
    for (const [key, value] of Object.entries(source || {})) {
      if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deep(out[key], value);
      else out[key] = clone(value);
    }
    return out;
  };
  return deep(base, patch);
}
async function load() {
  const stored = await browser.storage.local.get(["settings", "log"]);
  state.settings = mergeSettings(DEFAULT_SETTINGS, stored.settings || {});
  if (Number(stored.settings?.contextChars) === 48e3 && !stored.settings?.contextMigrated) {
    state.settings.contextChars = 96e3;
    state.settings.contextMigrated = true;
  }
  state.log = Array.isArray(stored.log) ? stored.log.slice(-LOG_CAP) : [];
  await loadSessions();
  return state;
}
async function saveSettings(patch) {
  state.settings = mergeSettings(state.settings, patch);
  await browser.storage.local.set({ settings: state.settings });
  return state.settings;
}
function activeProvider() {
  const key = state.settings.provider;
  return { key, ...PROVIDERS[key], ...state.settings.providers[key] || {} };
}
function activeModel() {
  return activeProvider().model || "";
}
function addLog(entry) {
  const withId = { id: "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), ...entry };
  state.log.push(withId);
  if (state.log.length > LOG_CAP) state.log = state.log.slice(-LOG_CAP);
  return withId;
}
async function persist() {
  await browser.storage.local.set({
    settings: state.settings,
    log: state.log.slice(-LOG_CAP)
  });
  await saveSessions();
}
async function clearLog() {
  state.log = [];
  await persist();
}
export {
  DEFAULT_SETTINGS,
  PROVIDERS,
  activeModel,
  activeProvider,
  addLog,
  clearLog,
  load,
  persist,
  saveSettings,
  state
};
