const CAP = 240;
const MAX_SESSIONS = 12;
const sessions = new Map();
function makeSession(tab) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title || "",
    url: tab.url || "",
    history: [],
    transcript: [],
    notes: [],
    busy: false,
    status: "idle",
    controller: null,
    pending: new Map(),
    lastAt: Date.now()
  };
}
function evictOldest() {
  let victim = null;
  for (const session of sessions.values()) {
    if (session.busy || session.pending.size) continue;
    if (!victim || session.lastAt < victim.lastAt) victim = session;
  }
  if (victim) sessions.delete(victim.tabId);
}
function getSession(tab) {
  if (!tab || tab.id == null) throw new Error("This tab cannot hold a conversation.");
  let session = sessions.get(tab.id);
  if (!session) {
    if (sessions.size >= MAX_SESSIONS) evictOldest();
    session = makeSession(tab);
    sessions.set(tab.id, session);
  }
  session.title = tab.title || session.title;
  session.url = tab.url || session.url;
  session.windowId = tab.windowId;
  return session;
}
function sessionForTabId(tabId) {
  return sessions.get(Number(tabId)) || null;
}
function dropSession(tabId) {
  const session = sessions.get(Number(tabId));
  if (!session) return null;
  if (session.controller) session.controller.abort();
  for (const entry of session.pending.values()) {
    clearTimeout(entry.timer);
    entry.resolve(entry.kind === "ask" ? "(no answer \u2014 the tab closed)" : false);
  }
  session.pending.clear();
  sessions.delete(session.tabId);
  return session;
}
function runningCount() {
  let n = 0;
  for (const session of sessions.values()) if (session.busy) n += 1;
  return n;
}
function addTranscript(session, item) {
  const withId = {
    id: "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    at: Date.now(),
    ...item
  };
  session.transcript.push(withId);
  if (session.transcript.length > CAP) session.transcript = session.transcript.slice(-CAP);
  session.lastAt = Date.now();
  return withId;
}
function addNote(session, text) {
  const t = String(text || "").trim();
  if (!t) return 0;
  session.notes.push(t);
  let total = session.notes.join("\n").length;
  while (total > 6e3 && session.notes.length > 1) {
    total -= session.notes.shift().length + 1;
  }
  return total;
}
function clearNotes(session) {
  session.notes = [];
}
function resetSession(session) {
  session.history = [];
  session.transcript = [];
  session.notes = [];
}
function summarize(session) {
  return {
    tabId: session.tabId,
    windowId: session.windowId,
    title: session.title,
    url: session.url,
    busy: session.busy,
    status: session.status,
    approvals: session.pending.size,
    messages: session.transcript.length
  };
}
function allSummaries() {
  return [...sessions.values()].filter((s) => s.busy || s.pending.size || s.transcript.length).map(summarize);
}
function toDto(session) {
  return {
    tabId: session.tabId,
    title: session.title,
    url: session.url,
    busy: session.busy,
    status: session.status,
    transcript: session.transcript,
    notes: session.notes,
    pending: [...session.pending.values()].map((entry) => entry.request)
  };
}
const STORE_KEY = "foxagent.sessions";
function area() {
  return browser.storage.session || browser.storage.local;
}
function serializable(session) {
  return {
    tabId: session.tabId,
    windowId: session.windowId,
    title: session.title,
    url: session.url,
    history: session.history.slice(-CAP),
    transcript: session.transcript.slice(-CAP),
    notes: session.notes.slice(-40)
  };
}
async function saveSessions() {
  const rows = [...sessions.values()].filter((s) => s.transcript.length || s.history.length || s.notes.length).map(serializable);
  try {
    await area().set({ [STORE_KEY]: rows });
  } catch (err) {
    console.warn("FoxAgent: could not save tab sessions", err);
  }
}
async function loadSessions() {
  let rows = [];
  try {
    const stored = await area().get(STORE_KEY);
    rows = Array.isArray(stored?.[STORE_KEY]) ? stored[STORE_KEY] : [];
  } catch {
    return;
  }
  if (!rows.length) return;
  const open = new Set((await browser.tabs.query({})).map((t) => t.id));
  for (const row of rows) {
    if (!open.has(row.tabId) || sessions.has(row.tabId)) continue;
    const session = makeSession({ id: row.tabId, windowId: row.windowId || 0, title: row.title, url: row.url });
    session.history = Array.isArray(row.history) ? row.history.slice(-CAP) : [];
    session.transcript = Array.isArray(row.transcript) ? row.transcript.slice(-CAP) : [];
    session.notes = Array.isArray(row.notes) ? row.notes : [];
    sessions.set(session.tabId, session);
  }
}
export {
  addNote,
  addTranscript,
  allSummaries,
  clearNotes,
  dropSession,
  getSession,
  loadSessions,
  resetSession,
  runningCount,
  saveSessions,
  sessionForTabId,
  sessions,
  summarize,
  toDto
};
