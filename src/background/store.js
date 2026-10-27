/*
 * Settings + session persistence. Everything lives in browser.storage.local,
 * on the user's machine. Page data is sent only to the provider chosen in
 * Models: a local server, or a cloud API the user connected with their own key.
 */

export const PROVIDERS = {
  lmstudio: {
    label: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    hint: "Start the local server in LM Studio, load a tool-capable model, then enable the server.",
  },
  ollama: {
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    hint: "Requires a tool-capable model, e.g. qwen2.5:7b or llama3.1:8b. Uses Ollama's OpenAI-compatible endpoint.",
  },
  vllm: {
    label: "vLLM",
    baseUrl: "http://localhost:8000/v1",
    hint: "Start with --enable-auto-tool-choice --tool-call-parser hermes (or your model's parser).",
  },
  llamacpp: {
    label: "llama.cpp",
    baseUrl: "http://localhost:8080/v1",
    hint: "Run llama-server --jinja with a tool-capable GGUF; the /v1 endpoint is OpenAI-compatible.",
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    baseUrl: "http://localhost:1234/v1",
    hint: "Any server exposing POST /chat/completions and GET /models.",
  },
  openai: {
    label: "OpenAI · GPT",
    baseUrl: "https://api.openai.com/v1",
    hint: "Uses your OpenAI API key. Pick a tool-capable GPT model; usage is billed by OpenAI.",
    cloud: true,
    keyUrl: "https://platform.openai.com/api-keys",
  },
  anthropic: {
    label: "Anthropic · Claude",
    baseUrl: "https://api.anthropic.com/v1",
    hint: "Uses the Anthropic Messages API and your Claude API key. Tool use is supported.",
    cloud: true,
    kind: "anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    hint: "One key for many hosted models. Choose a tool-capable model; some are free.",
    cloud: true,
    keyUrl: "https://openrouter.ai/keys",
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    hint: "DeepSeek chat and reasoning models. Create an API key in the DeepSeek platform.",
    cloud: true,
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    hint: "Fast hosted open models. Create an API key in the Groq console.",
    cloud: true,
    keyUrl: "https://console.groq.com/keys",
  },
  mistral: {
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    hint: "Mistral's hosted API. Create a key in the Mistral console.",
    cloud: true,
    keyUrl: "https://console.mistral.ai/api-keys",
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    hint: "Uses Gemini's OpenAI-compatible endpoint with a Google AI Studio key.",
    cloud: true,
    keyUrl: "https://aistudio.google.com/app/apikey",
  },
  xai: {
    label: "xAI · Grok",
    baseUrl: "https://api.x.ai/v1",
    hint: "Grok models from xAI. Create an API key in the xAI console.",
    cloud: true,
    keyUrl: "https://console.x.ai",
  },
};

function defaultProviders() {
  return Object.fromEntries(
    Object.entries(PROVIDERS).map(([key, meta]) => [
      key,
      { baseUrl: meta.baseUrl, apiKey: "", model: "" },
    ])
  );
}

export const DEFAULT_SETTINGS = {
  provider: "lmstudio",
  providers: defaultProviders(),
  temperature: 0.2,
  maxSteps: 32,
  toolMode: "auto",
  contextChars: 48000,
  maxPageChars: 12000,
  approval: { read: "auto", act: "confirm", write: "confirm" },
  trustedSites: [],
  siteAllowlist: [],
  dryRun: false,
  autoIncludePage: true,
};

export const state = {
  settings: structuredClone(DEFAULT_SETTINGS),
  history: [],
  transcript: [],
  log: [],
  notes: [],
  models: [],
  busy: false,
  controller: null,
  activeTab: null,
};

const SESSION_CAP = 240;
const LOG_CAP = 400;
const NOTES_CAP = 6000;

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

export async function load() {
  const stored = await browser.storage.local.get(["settings", "session", "log"]);
  state.settings = mergeSettings(DEFAULT_SETTINGS, stored.settings || {});
  const session = stored.session || {};
  state.history = Array.isArray(session.history) ? session.history.slice(-SESSION_CAP) : [];
  state.transcript = Array.isArray(session.transcript) ? session.transcript.slice(-SESSION_CAP) : [];
  state.notes = Array.isArray(session.notes) ? session.notes : [];
  state.log = Array.isArray(stored.log) ? stored.log.slice(-LOG_CAP) : [];
  return state;
}

export async function saveSettings(patch) {
  state.settings = mergeSettings(state.settings, patch);
  await browser.storage.local.set({ settings: state.settings });
  return state.settings;
}

export function activeProvider() {
  const key = state.settings.provider;
  return { key, ...PROVIDERS[key], ...(state.settings.providers[key] || {}) };
}

export function activeModel() {
  return activeProvider().model || "";
}

export function addNote(text) {
  const t = String(text || "").trim();
  if (!t) return 0;
  state.notes.push(t);
  let total = state.notes.join("\n").length;
  while (total > NOTES_CAP && state.notes.length > 1) {
    total -= state.notes.shift().length + 1;
  }
  return total;
}

export function clearNotes() {
  state.notes = [];
}

export function addTranscript(item) {
  const withId = { id: "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), ...item };
  state.transcript.push(withId);
  if (state.transcript.length > SESSION_CAP) state.transcript = state.transcript.slice(-SESSION_CAP);
  return withId;
}

export function addLog(entry) {
  const withId = { id: "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), ...entry };
  state.log.push(withId);
  if (state.log.length > LOG_CAP) state.log = state.log.slice(-LOG_CAP);
  return withId;
}

export async function persist() {
  await browser.storage.local.set({
    settings: state.settings,
    session: {
      history: state.history.slice(-SESSION_CAP),
      transcript: state.transcript.slice(-SESSION_CAP),
      notes: state.notes.slice(-40),
    },
    log: state.log.slice(-LOG_CAP),
  });
}

export async function resetConversation() {
  state.history = [];
  state.transcript = [];
  state.notes = [];
  await persist();
}

export async function clearLog() {
  state.log = [];
  await persist();
}
