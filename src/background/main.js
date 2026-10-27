import {
  load,
  state,
  persist,
  saveSettings,
  clearLog,
  activeModel,
  PROVIDERS
} from "./store.js";
import { runAgent } from "./agent.js";
import { listModels } from "./providers.js";
import { RECIPES } from "./recipes.js";
import { activeTab, tabInfo } from "./page.js";
import { cleanSettingsPatch } from "./settings-guard.js";
import { packList, packDescription, checkRemotePacks, loadCatalog } from "./packs.js";
import { checkUpdate, cachedUpdate, downloadUpdate } from "./updates.js";
import {
  sessions,
  getSession,
  sessionForTabId,
  dropSession,
  runningCount,
  addTranscript,
  clearNotes,
  resetSession,
  allSummaries,
  toDto
} from "./sessions.js";
const ready = load().catch((err) => console.error("FoxAgent: failed to load state", err));
const MAX_RUNNING = 2;
const ports = new Map();
const pendingOwners = new Map();
const modelCache = new Map();
function send(port, message) {
  try {
    port.postMessage(message);
  } catch {
  }
}
function broadcastWindow(windowId, message) {
  for (const [port, meta] of ports) {
    if (meta.windowId === windowId) send(port, message);
  }
}
function broadcastAll(message) {
  for (const port of ports.keys()) send(port, message);
}
function toast(text, level = "info") {
  broadcastAll({ type: "toast", text, level });
}
function broadcastSessions() {
  broadcastAll({ type: "sessions", sessions: allSummaries() });
}
function maskKey(key) {
  const value = String(key || "");
  if (!value) return "";
  return value.length <= 4 ? "\u2022\u2022\u2022\u2022" : `\u2022\u2022\u2022\u2022${value.slice(-4)}`;
}
function publicSettings() {
  const providers = {};
  for (const [key, meta] of Object.entries(PROVIDERS)) {
    const stored = state.settings.providers?.[key] || {};
    providers[key] = {
      baseUrl: stored.baseUrl || meta.baseUrl || "",
      model: stored.model || "",
      hasKey: Boolean(stored.apiKey),
      keyMask: maskKey(stored.apiKey)
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
      keyUrl: v.keyUrl || ""
    }]))
  };
}
function visibleUpdate(update) {
  if (!update?.available) return null;
  if (update.latest && update.latest === state.settings.dismissedUpdate) return null;
  return update;
}
async function stateMessage(tab, session) {
  return {
    type: "state",
    settings: publicSettings(),
    tab: tab ? tabInfo(tab) : null,
    tabId: session?.tabId ?? null,
    transcript: session?.transcript || [],
    notes: session?.notes || [],
    busy: Boolean(session?.busy),
    pending: session ? [...session.pending.values()].map((entry) => entry.request) : [],
    sessions: allSummaries(),
    packs: await packList(state.settings.packs || []),
    update: visibleUpdate(await cachedUpdate()),
    log: state.log,
    models: state.models,
    modelsByProvider: Object.fromEntries(modelCache),
    selectedModel: activeModel(),
    provider: state.settings.provider,
    recipes: RECIPES
  };
}
function rememberModels(providerKey, models) {
  modelCache.set(providerKey, models);
  if (providerKey === state.settings.provider) state.models = models;
  return models;
}
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persist().catch(() => {
  }), 400);
}
function emitSession(session, message) {
  broadcastWindow(session.windowId, { ...message, tabId: session.tabId });
  if (message.type !== "delta") {
    broadcastSessions();
    scheduleSave();
  }
}
async function tabForMessage(msg, meta) {
  if (msg?.tabId != null) {
    try {
      return await browser.tabs.get(Number(msg.tabId));
    } catch {
      throw new Error("That tab was closed.");
    }
  }
  return activeTab(meta.windowId ?? void 0);
}
async function pushTab(port, meta) {
  let tab = null;
  try {
    tab = await activeTab(meta.windowId ?? void 0);
  } catch {
  }
  const session = tab ? getSession(tab) : null;
  send(port, {
    type: "tab",
    tab: tab ? tabInfo(tab) : null,
    session: session ? toDto(session) : null,
    sessions: allSummaries()
  });
}
const tabTimers = new Map();
function scheduleTabPush(windowId) {
  if (windowId == null) return;
  clearTimeout(tabTimers.get(windowId));
  tabTimers.set(windowId, setTimeout(() => {
    for (const [port, meta] of ports) {
      if (meta.windowId === windowId) pushTab(port, meta);
    }
  }, 200));
}
browser.tabs.onActivated.addListener(({ windowId }) => scheduleTabPush(windowId));
browser.tabs.onUpdated.addListener((id, info, tab) => {
  const session = sessionForTabId(id);
  if (session) {
    session.title = tab.title || session.title;
    session.url = tab.url || session.url;
    broadcastSessions();
  }
  if (info.status === "complete" || info.url) scheduleTabPush(tab.windowId);
});
browser.tabs.onRemoved.addListener((id, info) => {
  const session = dropSession(id);
  if (session) {
    broadcastWindow(session.windowId, { type: "session_removed", tabId: id });
    broadcastSessions();
    for (const key of [...pendingOwners.keys()]) {
      if (pendingOwners.get(key) === id) pendingOwners.delete(key);
    }
  }
  scheduleTabPush(info.windowId);
});
browser.tabs.onAttached.addListener((id, info) => {
  const session = sessionForTabId(id);
  if (session) {
    session.windowId = info.newWindowId;
    broadcastSessions();
    scheduleSave();
  }
  scheduleTabPush(info.newWindowId);
});
browser.windows.onFocusChanged.addListener((windowId) => scheduleTabPush(windowId));
browser.action.onClicked.addListener(() => {
  browser.sidebarAction.open().catch((err) => console.warn("FoxAgent: could not open sidebar", err));
});
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidebar") return;
  const senderUrl = port.sender?.url || "";
  if (senderUrl && !senderUrl.startsWith(browser.runtime.getURL("src/sidebar/"))) return;
  const meta = { windowId: null };
  ports.set(port, meta);
  port.onMessage.addListener(async (msg) => {
    try {
      await ready;
      if (msg?.type === "hello" && Number.isFinite(Number(msg.windowId))) {
        meta.windowId = Number(msg.windowId);
      }
      await handleMessage(msg, port, meta);
    } catch (err) {
      console.error("FoxAgent: message failed", msg?.type, err);
      send(port, { type: "toast", text: err?.message || String(err), level: "error" });
    }
  });
  port.onDisconnect.addListener(() => {
    ports.delete(port);
  });
  ready.then(() => {
    send(port, { type: "ready" });
    const key = state.settings.provider;
    if (!state.models.length) {
      listModels(state.settings, key).then((models) => {
        rememberModels(key, models);
        broadcastAll({ type: "models", provider: key, models, selected: activeModel() });
      }).catch(() => {
      });
    }
  });
});
function settle(session, id, value) {
  const entry = session.pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  session.pending.delete(id);
  pendingOwners.delete(id);
  entry.resolve(value);
  if (!session.pending.size && session.busy) session.status = "working";
  emitSession(session, {
    type: "pending_resolved",
    id,
    tabId: session.tabId,
    approvals: session.pending.size
  });
}
function settleAll(session, value) {
  for (const entry of [...session.pending.values()]) {
    clearTimeout(entry.timer);
    pendingOwners.delete(entry.request.id);
    entry.resolve(entry.kind === "ask" ? typeof value === "string" ? value : "(no answer \u2014 the task stopped)" : false);
  }
  session.pending.clear();
  emitSession(session, { type: "pending_clear", tabId: session.tabId });
}
function waitFor(session, kind, req, timeoutMs, fallback) {
  return new Promise((resolve) => {
    const id = (kind === "approve" ? "ap_" : "ask_") + crypto.randomUUID();
    const request = { ...req, id, tabId: session.tabId, tabTitle: session.title };
    const entry = { kind, resolve, request, timer: null };
    entry.timer = setTimeout(() => {
      settle(session, id, fallback);
      emitSession(session, { type: kind === "approve" ? "confirm_expired" : "ask_expired", id });
    }, timeoutMs);
    session.pending.set(id, entry);
    pendingOwners.set(id, session.tabId);
    session.status = "waiting";
    emitSession(session, { type: kind === "approve" ? "confirm" : "ask", request });
  });
}
function requestApproval(session, req) {
  return waitFor(session, "approve", req, 18e4, false);
}
function requestAnswer(session, req) {
  return waitFor(session, "ask", req, 3e5, "(no answer \u2014 the user did not respond)");
}
async function startRun(session, text, origin = "chat") {
  const prompt = String(text || "").trim();
  if (!prompt) return;
  if (session.busy) {
    toast("This tab is already working. Stop it first.", "warn");
    return;
  }
  if (runningCount() >= MAX_RUNNING) {
    toast(`Two tabs are already working. Let one finish, or stop one in the tab strip.`, "warn");
    return;
  }
  let tab;
  try {
    tab = await browser.tabs.get(session.tabId);
  } catch {
    toast("That tab was closed. Open the page again.", "error");
    return;
  }
  session.busy = true;
  session.status = "working";
  session.controller = new AbortController();
  session.title = tab.title || session.title;
  session.url = tab.url || session.url;
  session.windowId = tab.windowId;
  const userItem = addTranscript(session, { type: "user", text: prompt });
  session.history.push({ role: "user", text: prompt, at: Date.now(), origin });
  emitSession(session, { type: "item", item: userItem });
  emitSession(session, { type: "busy", busy: true, status: "working" });
  try {
    await persist();
    await runAgent({
      session,
      settings: state.settings,
      emit: (message) => emitSession(session, message),
      approve: (req) => requestApproval(session, req),
      ask: (req) => requestAnswer(session, req),
      signal: session.controller.signal
    });
  } catch (err) {
    const item = addTranscript(session, {
      type: "notice",
      text: err?.message || String(err),
      level: err?.aborted ? "warn" : "error"
    });
    emitSession(session, { type: "item", item });
  } finally {
    settleAll(session);
    session.busy = false;
    session.status = "idle";
    session.controller = null;
    await persist().catch((err) => console.error("FoxAgent: could not save session", err));
    emitSession(session, { type: "busy", busy: false, status: "idle" });
    emitSession(session, { type: "notes", notes: session.notes });
  }
}
async function refreshModels(providerKey = state.settings.provider, silent = false) {
  const models = await listModels(state.settings, providerKey);
  rememberModels(providerKey, models);
  if (!silent) {
    broadcastAll({ type: "models", provider: providerKey, models, selected: activeModel() });
  }
  return models;
}
async function handleMessage(msg, port, meta) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "hello":
      if (meta.windowId == null) return;
      await pushTab(port, meta);
      {
        let tab = null;
        try {
          tab = await activeTab(meta.windowId);
        } catch {
        }
        const session = tab ? getSession(tab) : null;
        send(port, await stateMessage(tab, session));
      }
      return;
    case "getState": {
      let tab = null;
      try {
        tab = await tabForMessage(msg, meta);
      } catch {
      }
      const session = tab ? getSession(tab) : null;
      send(port, await stateMessage(tab, session));
      return;
    }
    case "send": {
      const tab = await tabForMessage(msg, meta);
      const session = getSession(tab);
      if (!activeModel()) {
        send(port, { type: "needModel" });
        return;
      }
      startRun(session, msg.text);
      return;
    }
    case "runRecipe": {
      const recipe = RECIPES.find((r) => r.id === msg.id);
      if (!recipe) {
        send(port, { type: "toast", text: "Unknown task.", level: "error" });
        return;
      }
      const tab = await tabForMessage(msg, meta);
      const session = getSession(tab);
      if (!activeModel()) {
        send(port, { type: "needModel" });
        return;
      }
      const extra = String(msg.extra || "").trim();
      startRun(session, recipe.prompt + (extra ? `

Extra context from me: ${extra}` : ""), recipe.id);
      return;
    }
    case "abort": {
      if (msg.all) {
        for (const session2 of [...sessions.values()]) {
          session2.controller?.abort();
          settleAll(session2, "(no answer \u2014 the task was stopped)");
        }
        return;
      }
      if (msg.tabId == null) return;
      const session = sessionForTabId(msg.tabId);
      if (!session) return;
      session.controller?.abort();
      settleAll(session, "(no answer \u2014 the task was stopped)");
      return;
    }
    case "approve": {
      const owner = pendingOwners.get(msg.id);
      const session = owner != null ? sessionForTabId(owner) : null;
      const entry = session?.pending.get(msg.id);
      if (!entry || entry.kind !== "approve") return;
      const hosts = entry.request.hosts || [];
      if (msg.always && hosts.length) {
        const sites = [...state.settings.trustedSites];
        for (const host of hosts) {
          const site = String(host).toLowerCase().trim();
          if (site && !sites.includes(site)) sites.push(site);
        }
        await saveSettings({ trustedSites: sites.slice(0, 200) });
        broadcastAll({ type: "settings", settings: publicSettings() });
      }
      settle(session, msg.id, Boolean(msg.allow));
      return;
    }
    case "answer": {
      const owner = pendingOwners.get(msg.id);
      const session = owner != null ? sessionForTabId(owner) : null;
      const entry = session?.pending.get(msg.id);
      if (!entry || entry.kind !== "ask") return;
      settle(session, msg.id, String(msg.text || "").trim());
      return;
    }
    case "focusTab": {
      const tab = await browser.tabs.get(Number(msg.tabId));
      await browser.tabs.update(tab.id, { active: true });
      await browser.windows.update(tab.windowId, { focused: true }).catch(() => {
      });
      scheduleTabPush(tab.windowId);
      return;
    }
    case "saveSettings": {
      const patch = cleanSettingsPatch(msg.patch);
      if (!Object.keys(patch).length) return;
      const before = state.settings.provider;
      await saveSettings(patch);
      broadcastAll({ type: "settings", settings: publicSettings() });
      if (patch.provider && patch.provider !== before) {
        const key = state.settings.provider;
        const cached = modelCache.get(key);
        if (cached) {
          state.models = cached;
          broadcastAll({ type: "models", provider: key, models: cached, selected: activeModel() });
        } else {
          state.models = [];
          refreshModels(key, true).then((models) => broadcastAll({ type: "models", provider: key, models, selected: activeModel() })).catch(() => {
          });
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
      broadcastAll({ type: "settings", settings: publicSettings() });
      send(port, { type: "toast", text: `Key saved for ${PROVIDERS[key].label}.`, level: "success" });
      return;
    }
    case "forgetKey": {
      const key = String(msg.provider || state.settings.provider);
      if (!PROVIDERS[key]) return;
      await saveSettings({ providers: { [key]: { apiKey: "" } } });
      modelCache.delete(key);
      if (key === state.settings.provider) state.models = [];
      broadcastAll({ type: "settings", settings: publicSettings() });
      broadcastAll({ type: "models", provider: key, models: [], selected: activeModel() });
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
      broadcastAll({ type: "settings", settings: publicSettings() });
      const cached = modelCache.get(key);
      if (cached) {
        state.models = cached;
        broadcastAll({ type: "models", provider: key, models: cached, selected: activeModel() });
      } else {
        state.models = [];
        broadcastAll({ type: "models", provider: key, models: [], selected: activeModel() });
        refreshModels(key, true).then((models) => broadcastAll({ type: "models", provider: key, models, selected: activeModel() })).catch(() => {
        });
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
      const patch = cleanSettingsPatch(msg.patch);
      const draft = msg.patch?.providers?.[target];
      if (draft && typeof draft === "object") {
        const entry = {};
        const baseUrl = String(draft.baseUrl || "").trim();
        if (/^https?:\/\//i.test(baseUrl)) entry.baseUrl = baseUrl;
        if (typeof draft.apiKey === "string" && draft.apiKey.trim()) {
          entry.apiKey = draft.apiKey.trim().slice(0, 4096);
        }
        if (Object.keys(entry).length) patch.providers = { [target]: entry };
      }
      if (Object.keys(patch).length) {
        await saveSettings(patch);
        broadcastAll({ type: "settings", settings: publicSettings() });
      }
      try {
        const models = await refreshModels(target, true);
        send(port, {
          type: "models",
          provider: target,
          models,
          selected: target === state.settings.provider ? activeModel() : state.settings.providers[target]?.model || ""
        });
        if (!models.length) send(port, { type: "toast", text: "The server answered but listed no models. Load a model first.", level: "warn" });
      } catch (err) {
        send(port, { type: "modelsError", provider: target, text: err?.message || String(err) });
      }
      return;
    }
    case "reset": {
      const tab = await tabForMessage(msg, meta);
      const session = getSession(tab);
      if (session.busy) {
        send(port, { type: "toast", text: "Stop this tab's task before starting a new conversation.", level: "warn" });
        return;
      }
      resetSession(session);
      await persist();
      emitSession(session, { type: "reset", transcript: [], tabId: session.tabId });
      broadcastSessions();
      return;
    }
    case "clearNotes": {
      const tab = await tabForMessage(msg, meta);
      const session = getSession(tab);
      clearNotes(session);
      await persist();
      emitSession(session, { type: "notes", notes: [], tabId: session.tabId });
      return;
    }
    case "clearLog":
      await clearLog();
      broadcastAll({ type: "log", log: [] });
      return;
    case "exportLog": {
      const blob = new Blob([state.log.map((e) => JSON.stringify(e)).join("\n")], { type: "application/x-ndjson" });
      const url = URL.createObjectURL(blob);
      try {
        await browser.downloads.download({
          url,
          filename: `FoxAgent/logs/foxagent-log-${(new Date()).toISOString().slice(0, 10)}.jsonl`,
          saveAs: false,
          conflictAction: "uniquify"
        });
        send(port, { type: "toast", text: "Activity log exported to Downloads/FoxAgent/logs.", level: "success" });
      } catch (err) {
        send(port, { type: "toast", text: `Could not export log: ${err.message}`, level: "error" });
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 6e4);
      }
      return;
    }
    case "setPack": {
      const id = String(msg.id || "");
      const known = await loadCatalog();
      if (!known.some((p) => p.id === id)) {
        send(port, { type: "toast", text: "Unknown pack.", level: "error" });
        return;
      }
      const enabled = new Set(state.settings.packs || []);
      if (msg.enabled) enabled.add(id);
      else enabled.delete(id);
      await saveSettings({ packs: [...enabled] });
      broadcastAll({ type: "settings", settings: publicSettings() });
      broadcastAll({ type: "packs", packs: await packList([...enabled]) });
      send(port, {
        type: "toast",
        text: msg.enabled ? `Installed ${id}.` : `Removed ${id}.`,
        level: "success"
      });
      return;
    }
    case "checkPacks": {
      try {
        const data = await checkRemotePacks();
        send(port, { type: "packsRemote", data });
        send(port, {
          type: "toast",
          text: data.newPacks.length ? `${data.newPacks.length} new pack(s) in the repository. A FoxAgent update installs them.` : "Pack catalog is current.",
          level: data.newPacks.length ? "info" : "success"
        });
      } catch (err) {
        send(port, { type: "toast", text: err?.message || String(err), level: "error" });
      }
      return;
    }
    case "getPackDesc": {
      try {
        const text = await packDescription(String(msg.id || ""));
        send(port, { type: "packDesc", id: msg.id, text });
      } catch (err) {
        send(port, { type: "packDesc", id: msg.id, text: err?.message || String(err) });
      }
      return;
    }
    case "checkUpdate": {
      try {
        const update = await checkUpdate({ force: Boolean(msg.force) });
        send(port, { type: "updateStatus", update });
        if (visibleUpdate(update)) send(port, { type: "update", update });
        else send(port, { type: "toast", text: `FoxAgent ${update.current} is up to date.`, level: "success" });
      } catch (err) {
        send(port, { type: "updateStatus", update: null, error: err?.message || String(err) });
        send(port, { type: "toast", text: err?.message || String(err), level: "error" });
      }
      return;
    }
    case "downloadUpdate": {
      try {
        const update = await downloadUpdate();
        send(port, {
          type: "toast",
          text: `Saved ${update.filename}. Firefox installs signed add-ons only, so the release page is open for the final step.`,
          level: "success"
        });
        if (update.url) await browser.tabs.create({ url: update.url, active: true });
        send(port, { type: "updateDone", update });
      } catch (err) {
        send(port, { type: "toast", text: err?.message || String(err), level: "error" });
      }
      return;
    }
    case "dismissUpdate": {
      const version = String(msg.version || "");
      if (!version) return;
      await saveSettings({ dismissedUpdate: version });
      return;
    }
    case "openRelease": {
      const url = String(msg.url || "");
      if (/^https:\/\/github\.com\/D5-Interactive\/FoxAgent\//i.test(url)) {
        await browser.tabs.create({ url, active: true });
      }
      return;
    }
    default:
      return;
  }
}
ready.then(() => {
  const key = state.settings.provider;
  listModels(state.settings, key).then((models) => {
    rememberModels(key, models);
    broadcastAll({ type: "models", provider: key, models, selected: activeModel() });
  }).catch(() => {
  });
  if (state.settings.autoUpdate) {
    checkUpdate().then((update) => {
      const visible = visibleUpdate(update);
      if (visible) broadcastAll({ type: "update", update: visible });
    }).catch(() => {
    });
  }
});
