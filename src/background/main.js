/*
 * Background entry point: sidebar port, message routing, approvals, and
 * model discovery.
 */

import {
  load, state, persist, saveSettings, resetConversation, clearLog,
  addTranscript, activeModel, activeProvider, PROVIDERS, clearNotes,
} from "./store.js";
import { runAgent } from "./agent.js";
import { listModels } from "./providers.js";
import { RECIPES } from "./recipes.js";
import { activeTab, tabInfo } from "./page.js";

const ready = load().catch((err) => console.error("FoxAgent: failed to load state", err));

const ports = new Set();
const pending = new Map();
// Model lists are per provider, so switching back and forth stays instant.
const modelCache = new Map();

/* ------------------------------------------------------------------ */
/* Messaging                                                           */
/* ------------------------------------------------------------------ */

function send(port, message) {
  try { port.postMessage(message); } catch { /* port closed */ }
}

function broadcast(message) {
  for (const port of ports) send(port, message);
}

function toast(text, level = "info") {
  broadcast({ type: "toast", text, level });
}

/*
 * The sidebar is untrusted display code: it never needs a raw API key.
 * Strip keys here and expose only whether one is stored plus a masked hint.
 */
function maskKey(key) {
  const value = String(key || "");
  if (!value) return "";
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}

function publicSettings() {
  const providers = {};
  for (const [key, meta] of Object.entries(PROVIDERS)) {
    const stored = state.settings.providers?.[key] || {};
    providers[key] = {
      baseUrl: stored.baseUrl || meta.baseUrl || "",
      model: stored.model || "",
      hasKey: Boolean(stored.apiKey),
      keyMask: maskKey(stored.apiKey),
    };
  }
  return {
    ...state.settings,
    providers,
    providerKeys: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, {
      label: v.label,
      baseUrl: v.baseUrl,
      hint: v.hint,
      cloud: Boolean(v.cloud),
      kind: v.kind || "",
      keyUrl: v.keyUrl || "",
    }])),
  };
}

function stateMessage() {
  return {
    type: "state",
    settings: publicSettings(),
    transcript: state.transcript,
    log: state.log,
    notes: state.notes,
    busy: state.busy,
    models: state.models,
    modelsByProvider: Object.fromEntries(modelCache),
    selectedModel: activeModel(),
    provider: state.settings.provider,
    recipes: RECIPES,
  };
}

function rememberModels(providerKey, models) {
  modelCache.set(providerKey, models);
  if (providerKey === state.settings.provider) state.models = models;
  return models;
}

async function pushTab() {
  let tab = null;
  try {
    const t = await activeTab();
    tab = await tabInfo(t);
  } catch {}
  broadcast({ type: "tab", tab });
}

let tabTimer = null;
function scheduleTabPush() {
  clearTimeout(tabTimer);
  tabTimer = setTimeout(pushTab, 200);
}

browser.tabs.onActivated.addListener(scheduleTabPush);
browser.tabs.onUpdated.addListener((id, info) => {
  if (info.status === "complete" || info.url) scheduleTabPush();
});
browser.tabs.onRemoved.addListener(scheduleTabPush);
browser.windows.onFocusChanged.addListener(scheduleTabPush);

browser.action.onClicked.addListener(() => {
  browser.sidebarAction.open().catch((err) => console.warn("FoxAgent: could not open sidebar", err));
});

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidebar") return;
  ports.add(port);

  port.onMessage.addListener(async (msg) => {
    try {
      await ready;
      await handleMessage(msg, port);
    } catch (err) {
      console.error("FoxAgent: message failed", msg?.type, err);
      send(port, { type: "toast", text: err?.message || String(err), level: "error" });
    }
  });

  port.onDisconnect.addListener(() => {
    ports.delete(port);
    // The sidebar is the only UI; closing it must not leave a turn waiting forever.
    settleAll("(no answer — the sidebar closed)");
    if (!ports.size && state.controller) {
      state.controller.abort();
    }
  });

  ready.then(() => {
    send(port, stateMessage());
    pushTab();
    if (!state.models.length) {
      const key = state.settings.provider;
      listModels(state.settings, key)
        .then((models) => {
          rememberModels(key, models);
          send(port, { type: "models", provider: key, models, selected: activeModel() });
        })
        .catch(() => {});
    }
  });
});

/* ------------------------------------------------------------------ */
/* Approvals and questions                                             */
/* ------------------------------------------------------------------ */

function settle(id, value) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(value);
}

/*
 * A stop, a closed sidebar or a finished turn must never leave the agent
 * waiting on an approval or a question that nobody can answer.
 */
function settleAll(value) {
  const entries = [...pending.values()];
  for (const entry of entries) {
    entry.resolve(entry.kind === "ask"
      ? (typeof value === "string" ? value : "(no answer — the task stopped)")
      : false);
    clearTimeout(entry.timer);
  }
  pending.clear();
  broadcast({ type: "pending_clear" });
}

function requestApproval(req) {
  return new Promise((resolve) => {
    const id = "ap_" + Math.random().toString(36).slice(2, 10);
    const timer = setTimeout(() => {
      settle(id, false);
      broadcast({ type: "confirm_expired", id });
    }, 180000);
    pending.set(id, { resolve, timer, kind: "approve", port: null });
    broadcast({ type: "confirm", request: { ...req, id } });
  });
}

function requestAnswer(req) {
  return new Promise((resolve) => {
    const id = "ask_" + Math.random().toString(36).slice(2, 10);
    const timer = setTimeout(() => {
      settle(id, "(no answer — the user did not respond)");
      broadcast({ type: "ask_expired", id });
    }, 300000);
    pending.set(id, { resolve, timer, kind: "ask", port: null });
    broadcast({ type: "ask", request: { ...req, id } });
  });
}

/* ------------------------------------------------------------------ */
/* Turns                                                               */
/* ------------------------------------------------------------------ */

async function startRun(text, origin = "chat") {
  const prompt = String(text || "").trim();
  if (!prompt) return;
  if (state.busy) {
    toast("FoxAgent is already working. Stop it first.", "warn");
    return;
  }

  state.busy = true;
  state.controller = new AbortController();

  const userItem = addTranscript({ type: "user", text: prompt });
  state.history.push({ role: "user", text: prompt, at: Date.now(), origin });
  broadcast({ type: "item", item: userItem });
  broadcast({ type: "busy", busy: true });

  try {
    await persist();
    await runAgent({
      state,
      settings: state.settings,
      emit: broadcast,
      approve: requestApproval,
      ask: requestAnswer,
      signal: state.controller.signal,
    });
  } catch (err) {
    const item = addTranscript({
      type: "notice",
      text: err?.message || String(err),
      level: err?.aborted ? "warn" : "error",
    });
    broadcast({ type: "item", item });
  } finally {
    settleAll();
    state.busy = false;
    state.controller = null;
    await persist().catch((err) => console.error("FoxAgent: could not save session", err));
    broadcast({ type: "busy", busy: false });
    broadcast({ type: "notes", notes: state.notes });
    await pushTab();
  }
}

/* ------------------------------------------------------------------ */
/* Message handling                                                    */
/* ------------------------------------------------------------------ */

async function refreshModels(providerKey = state.settings.provider, silent = false) {
  const models = await listModels(state.settings, providerKey);
  rememberModels(providerKey, models);
  if (!silent) {
    broadcast({ type: "models", provider: providerKey, models, selected: activeModel() });
  }
  return models;
}

async function handleMessage(msg, port) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "getState":
      send(port, stateMessage());
      return;

    case "send":
      if (state.busy) {
        send(port, { type: "toast", text: "Still working on the previous request.", level: "warn" });
        return;
      }
      if (!activeModel()) {
        send(port, { type: "needModel" });
        return;
      }
      startRun(msg.text);
      return;

    case "runRecipe": {
      const recipe = RECIPES.find((r) => r.id === msg.id);
      if (!recipe) {
        send(port, { type: "toast", text: "Unknown task.", level: "error" });
        return;
      }
      if (state.busy) {
        send(port, { type: "toast", text: "Still working on the previous request.", level: "warn" });
        return;
      }
      if (!activeModel()) {
        send(port, { type: "needModel" });
        return;
      }
      const extra = String(msg.extra || "").trim();
      startRun(recipe.prompt + (extra ? `\n\nExtra context from me: ${extra}` : ""), recipe.id);
      return;
    }

    case "abort":
      if (state.controller) state.controller.abort();
      settleAll("(no answer — the task was stopped)");
      return;

    case "approve": {
      const entry = pending.get(msg.id);
      if (!entry || entry.kind !== "approve") return;
      const hosts = Array.isArray(msg.hosts) && msg.hosts.length
        ? msg.hosts
        : msg.host ? [msg.host] : [];
      if (msg.always && hosts.length) {
        const sites = [...state.settings.trustedSites];
        for (const host of hosts) {
          const site = String(host).toLowerCase().trim();
          if (site && !sites.includes(site)) sites.push(site);
        }
        await saveSettings({ trustedSites: sites });
        broadcast({ type: "settings", settings: publicSettings() });
      }
      settle(msg.id, Boolean(msg.allow));
      return;
    }

    case "answer": {
      const entry = pending.get(msg.id);
      if (!entry || entry.kind !== "ask") return;
      settle(msg.id, String(msg.text || "").trim());
      return;
    }

    case "saveSettings": {
      const patch = msg.patch || {};
      const before = state.settings.provider;
      await saveSettings(patch);
      broadcast({ type: "settings", settings: publicSettings() });
      if (patch.provider && patch.provider !== before) {
        const key = state.settings.provider;
        const cached = modelCache.get(key);
        if (cached) {
          state.models = cached;
          broadcast({ type: "models", provider: key, models: cached, selected: activeModel() });
        } else {
          state.models = [];
          refreshModels(key, true)
            .then((models) => broadcast({ type: "models", provider: key, models, selected: activeModel() }))
            .catch(() => {});
        }
      }
      return;
    }

    case "saveKey": {
      const key = String(msg.provider || state.settings.provider);
      if (!PROVIDERS[key]) return;
      const apiKey = String(msg.apiKey || "").trim();
      if (!apiKey) {
        send(port, { type: "toast", text: "Paste an API key first.", level: "warn" });
        return;
      }
      await saveSettings({ providers: { [key]: { apiKey } } });
      broadcast({ type: "settings", settings: publicSettings() });
      send(port, { type: "toast", text: `Key saved for ${PROVIDERS[key].label}.`, level: "success" });
      return;
    }

    case "forgetKey": {
      const key = String(msg.provider || state.settings.provider);
      if (!PROVIDERS[key]) return;
      await saveSettings({ providers: { [key]: { apiKey: "" } } });
      modelCache.delete(key);
      if (key === state.settings.provider) state.models = [];
      broadcast({ type: "settings", settings: publicSettings() });
      broadcast({ type: "models", provider: key, models: [], selected: activeModel() });
      send(port, { type: "toast", text: `Key removed for ${PROVIDERS[key].label}.`, level: "info" });
      return;
    }

    case "useModel": {
      const key = String(msg.provider || state.settings.provider);
      if (!PROVIDERS[key]) return;
      const model = String(msg.model || "").trim();
      if (!model) {
        send(port, { type: "toast", text: "Pick or type a model first.", level: "warn" });
        return;
      }
      const patch = { provider: key, providers: { [key]: { model } } };
      const baseUrl = String(msg.baseUrl || "").trim();
      if (baseUrl && /^https?:\/\//i.test(baseUrl)) patch.providers[key].baseUrl = baseUrl;
      await saveSettings(patch);
      broadcast({ type: "settings", settings: publicSettings() });
      const cached = modelCache.get(key);
      if (cached) {
        state.models = cached;
        broadcast({ type: "models", provider: key, models: cached, selected: activeModel() });
      } else {
        state.models = [];
        broadcast({ type: "models", provider: key, models: [], selected: activeModel() });
        refreshModels(key, true)
          .then((models) => broadcast({ type: "models", provider: key, models, selected: activeModel() }))
          .catch(() => {});
      }
      if (PROVIDERS[key].cloud && !state.settings.providers[key]?.apiKey) {
        send(port, { type: "toast", text: `Using ${model}. Save a ${PROVIDERS[key].label} key before chatting.`, level: "warn" });
      } else {
        send(port, { type: "toast", text: `Using ${model} on ${PROVIDERS[key].label}.`, level: "success" });
      }
      return;
    }

    case "refreshModels": {
      const target = String(msg.provider || msg.patch?.provider || state.settings.provider);
      if (!PROVIDERS[target]) return;
      if (msg.patch) {
        await saveSettings(msg.patch);
        broadcast({ type: "settings", settings: publicSettings() });
      }
      try {
        const models = await refreshModels(target, true);
        send(port, {
          type: "models",
          provider: target,
          models,
          selected: target === state.settings.provider
            ? activeModel()
            : (state.settings.providers[target]?.model || ""),
        });
        if (!models.length) send(port, { type: "toast", text: "The server answered but listed no models. Load a model first.", level: "warn" });
      } catch (err) {
        send(port, { type: "modelsError", provider: target, text: err?.message || String(err) });
      }
      return;
    }

    case "reset":
      if (state.busy) {
        send(port, { type: "toast", text: "Stop the current task before starting a new conversation.", level: "warn" });
        return;
      }
      await resetConversation();
      broadcast({ type: "reset", transcript: state.transcript });
      return;

    case "clearNotes":
      clearNotes();
      await persist();
      broadcast({ type: "notes", notes: [] });
      return;

    case "clearLog":
      await clearLog();
      broadcast({ type: "log", log: [] });
      return;

    case "exportLog": {
      const blob = new Blob([state.log.map((e) => JSON.stringify(e)).join("\n")], { type: "application/x-ndjson" });
      const url = URL.createObjectURL(blob);
      try {
        await browser.downloads.download({
          url,
          filename: `FoxAgent/logs/foxagent-log-${new Date().toISOString().slice(0, 10)}.jsonl`,
          saveAs: false,
          conflictAction: "uniquify",
        });
        send(port, { type: "toast", text: "Activity log exported to Downloads/FoxAgent/logs.", level: "success" });
      } catch (err) {
        send(port, { type: "toast", text: `Could not export log: ${err.message}`, level: "error" });
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      return;
    }

    default:
      return;
  }
}

// Warm the model list once so the header is populated on first open.
ready.then(() => {
  const key = state.settings.provider;
  listModels(state.settings, key)
    .then((models) => {
      rememberModels(key, models);
      broadcast({ type: "models", provider: key, models, selected: activeModel() });
    })
    .catch(() => {});
});
