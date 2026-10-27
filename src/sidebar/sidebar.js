/*
 * Sidebar UI. Owns no agent logic: it renders state from the background page,
 * sends user intents, and shows approval prompts.
 */

const $ = (id) => document.getElementById(id);

/* Theme: monochrome light by default, near-black night mode. */
const THEME_KEY = "foxagent.theme";

function applyTheme(mode) {
  const dark = mode === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const btn = $("themeBtn");
  if (!btn) return;
  btn.textContent = dark ? "\u2600" : "\u263E";
  btn.title = dark ? "Light mode" : "Night mode";
  btn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to night mode");
  btn.setAttribute("aria-pressed", String(dark));
}

try {
  applyTheme(localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light");
} catch {
  applyTheme("light");
}

const app = {
  settings: null,
  transcript: [],
  log: [],
  notes: [],
  models: [],
  modelsByProvider: {},
  modelsProvider: null,
  busy: false,
  tab: null,
  panel: "chat",
  pending: new Map(),
  streaming: null,
  scrollQueued: false,
};

let port = null;
let reconnectTimer = null;

/* ------------------------------------------------------------------ */
/* Connection                                                          */
/* ------------------------------------------------------------------ */

function send(message) {
  if (!port) return;
  try { port.postMessage(message); } catch { /* disconnected */ }
}

function connect() {
  clearTimeout(reconnectTimer);
  try {
    port = browser.runtime.connect({ name: "sidebar" });
  } catch {
    scheduleReconnect();
    return;
  }
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    setConn("error", "offline");
    setBusy(false);
    scheduleReconnect();
  });
  send({ type: "getState" });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connect();
    if (port) {
      setConn("connecting", "reconnecting");
      send({ type: "getState" });
    }
  }, 900);
}

function setConn(state, label) {
  const el = $("conn");
  el.dataset.state = state;
  $("connLabel").textContent = label || state;
}

/* ------------------------------------------------------------------ */
/* Markdown — built as DOM nodes, never as HTML strings                */
/* ------------------------------------------------------------------ */

function mk(tag, text) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  return node;
}

function inlineNodes(text) {
  const frag = document.createDocumentFragment();
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\))/g;
  let last = 0;
  let match;

  while ((match = re.exec(text))) {
    if (match.index > last) frag.append(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      frag.append(mk("code", token.slice(1, -1)));
    } else if (token.startsWith("**") || token.startsWith("__")) {
      frag.append(mk("strong", token.slice(2, -2)));
    } else if (token.startsWith("~~")) {
      frag.append(mk("del", token.slice(2, -2)));
    } else if (token.startsWith("*")) {
      frag.append(mk("em", token.slice(1, -1)));
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = link?.[2] || "";
      if (link && /^(https?:\/\/|mailto:)/i.test(href)) {
        const a = mk("a", link[1]);
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        frag.append(a);
      } else {
        frag.append(link ? link[1] : token);
      }
    }
    last = re.lastIndex;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

function isBlockStart(line) {
  return /^```|^#{1,6}\s|^>\s?|^\s*([-*+]|\d+\.)\s+|^\s*(---+|\*\*\*+)\s*$|^\|/.test(line);
}

function renderMarkdown(src) {
  const lines = String(src || "").replace(/\r\n/g, "\n").split("\n");
  const frag = document.createDocumentFragment();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (/^```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++;
      const pre = mk("pre");
      pre.append(mk("code", code.join("\n")));
      frag.append(pre);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const h = mk("h" + Math.min(3, heading[1].length));
      h.append(inlineNodes(heading[2]));
      frag.append(h);
      i++;
      continue;
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      frag.append(mk("hr"));
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      const quote = mk("blockquote");
      quote.append(renderMarkdown(quoted.join("\n")));
      frag.append(quote);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const list = mk(ordered ? "ol" : "ul");
      const bullet = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/;
      const items = [];
      while (i < lines.length) {
        if (bullet.test(lines[i])) {
          items.push(lines[i].replace(bullet, ""));
          i++;
        } else if (/^\s{2,}\S/.test(lines[i]) && items.length) {
          items[items.length - 1] += " " + lines[i].trim();
          i++;
        } else break;
      }
      for (const item of items) {
        const li = mk("li");
        li.append(inlineNodes(item));
        list.append(li);
      }
      frag.append(list);
      continue;
    }

    if (/^\|/.test(line) && i + 1 < lines.length && /^\|?[\s:|-]+\|/.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = rows.map((r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      const table = mk("table");
      const thead = mk("thead");
      const headRow = mk("tr");
      for (const cell of cells[0] || []) {
        const th = mk("th");
        th.append(inlineNodes(cell));
        headRow.append(th);
      }
      thead.append(headRow);
      const tbody = mk("tbody");
      for (const row of cells.slice(2)) {
        const tr = mk("tr");
        for (const cell of row) {
          const td = mk("td");
          td.append(inlineNodes(cell));
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(thead, tbody);
      const wrap = mk("div");
      wrap.className = "md-table";
      wrap.append(table);
      frag.append(wrap);
      continue;
    }

    const paragraph = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) {
      paragraph.push(lines[i]);
      i++;
    }
    if (!paragraph.length) { i++; continue; }
    const p = mk("p");
    paragraph.forEach((text, index) => {
      if (index) p.append(mk("br"));
      p.append(inlineNodes(text));
    });
    frag.append(p);
  }

  return frag;
}

/* ------------------------------------------------------------------ */
/* Transcript rendering                                                */
/* ------------------------------------------------------------------ */

function shortArgs(args) {
  if (!args || !Object.keys(args).length) return "";
  return Object.entries(args)
    .filter(([k]) => k !== "tabId")
    .map(([k, v]) => {
      let s;
      if (typeof v === "string") s = v;
      else if (Array.isArray(v)) s = `${v.length} item(s)`;
      else s = JSON.stringify(v);
      s = String(s).replace(/\s+/g, " ");
      return `${k}=${s.length > 60 ? s.slice(0, 60) + "…" : s}`;
    })
    .join(", ");
}

function itemNode(item) {
  if (item.type === "user") {
    const row = document.createElement("div");
    row.className = "msg user";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = item.text || "";
    row.append(bubble);
    return row;
  }

  if (item.type === "assistant") {
    const row = document.createElement("div");
    row.className = "msg assistant";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.append(renderMarkdown(item.text || ""));
    row.append(bubble);
    return row;
  }

  if (item.type === "notice") {
    const div = document.createElement("div");
    div.className = "notice";
    div.dataset.level = item.level || "info";
    div.textContent = item.text || "";
    return div;
  }

  if (item.type === "tool") {
    const details = document.createElement("details");
    details.className = "tool";
    details.dataset.ok = item.ok ? "true" : "false";
    if (item.dryRun) details.dataset.dry = "true";

    const summary = document.createElement("summary");
    const dot = document.createElement("i");
    dot.className = "dot";
    const name = document.createElement("span");
    name.className = "tname";
    name.textContent = item.name || "tool";
    const args = document.createElement("span");
    args.className = "targs";
    args.textContent = shortArgs(item.args);
    const ms = document.createElement("span");
    ms.className = "tms";
    ms.textContent = item.ms != null ? `${item.ms} ms` : "";
    summary.append(dot, name, args, ms);

    const body = document.createElement("div");
    body.className = "tool-body";
    if (item.args && Object.keys(item.args).length) {
      const label = document.createElement("div");
      label.className = "tool-label";
      label.textContent = "Arguments";
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(item.args, null, 1).slice(0, 4000);
      body.append(label, pre);
    }
    const label2 = document.createElement("div");
    label2.className = "tool-label";
    label2.textContent = item.ok ? "Result" : "Error";
    const pre2 = document.createElement("pre");
    pre2.textContent = String(item.text || "").slice(0, 6000) || "(empty)";
    body.append(label2, pre2);

    details.append(summary, body);
    return details;
  }

  const div = document.createElement("div");
  div.className = "notice";
  div.textContent = item.text || "";
  return div;
}

function renderTranscript(forceScroll = false) {
  const holder = $("transcript");
  holder.replaceChildren(...app.transcript.map(itemNode));
  if (forceScroll) scrollBottom(true);
}

function appendTranscript(item) {
  if (!item || !item.id) return;
  if (app.transcript.some((x) => x.id === item.id)) return;
  app.transcript.push(item);
  $("transcript").append(itemNode(item));
  scrollBottom(false);
}

function isNearBottom() {
  const el = $("chatScroll");
  return el.scrollHeight - el.scrollTop - el.clientHeight < 150;
}

function scrollBottom(force = false) {
  if (!force && !isNearBottom()) return;
  if (app.scrollQueued) return;
  app.scrollQueued = true;
  requestAnimationFrame(() => {
    app.scrollQueued = false;
    const el = $("chatScroll");
    el.scrollTop = el.scrollHeight;
  });
}

/* ------------------------------------------------------------------ */
/* Streaming                                                           */
/* ------------------------------------------------------------------ */

function streamingBubble() {
  const holder = $("streaming");
  holder.hidden = false;
  return holder.querySelector(".bubble");
}

function startStreaming() {
  const bubble = streamingBubble();
  bubble.textContent = "";
  app.streaming = bubble;
  scrollBottom(true);
}

function onDelta(text) {
  const bubble = app.streaming || streamingBubble();
  app.streaming = bubble;
  bubble.textContent += text;
  scrollBottom(false);
  setStatus("writing…", true);
}

function endStreaming(msg) {
  $("streaming").hidden = true;
  const bubble = $("streaming").querySelector(".bubble");
  bubble.textContent = "";
  app.streaming = null;
  if (msg?.item) appendTranscript(msg.item);
  else if (msg?.text) {
    const item = { id: "local_" + Date.now(), type: "assistant", text: msg.text };
    app.transcript.push(item);
    $("transcript").append(itemNode(item));
  }
}

/* ------------------------------------------------------------------ */
/* Status, busy state                                                  */
/* ------------------------------------------------------------------ */

function setStatus(text, active = false) {
  const el = $("status");
  el.textContent = text || "";
  el.dataset.active = active ? "true" : "false";
}

function setBusy(busy) {
  app.busy = busy;
  $("sendBtn").disabled = busy;
  $("stopBtn").hidden = !busy;
  $("input").placeholder = busy ? "Working… stop to intervene" : "Ask about this page, or run a task…";
  if (busy) {
    setConn("busy", "working");
    if (!app.streaming) setStatus("starting…", true);
  } else {
    setConn("connected", "connected");
    setStatus("", false);
    $("streaming").hidden = true;
  }
}

/* ------------------------------------------------------------------ */
/* Approvals and questions                                             */
/* ------------------------------------------------------------------ */

function clearPendingUi(id) {
  const node = document.querySelector(`[data-pending="${CSS.escape(id)}"]`);
  if (node) node.remove();
  app.pending.delete(id);
}

function approvalCard(req) {
  app.pending.set(req.id, req);
  const card = document.createElement("div");
  card.className = "card approval";
  card.dataset.pending = req.id;

  const head = document.createElement("div");
  head.className = "approval-head";
  const risk = document.createElement("span");
  risk.className = "risk";
  risk.dataset.risk = req.risk || "act";
  risk.textContent = req.risk || "act";
  const name = document.createElement("b");
  name.textContent = req.tool || "action";
  head.append(risk, name);

  if (req.host) {
    const host = document.createElement("span");
    host.className = "host";
    host.textContent = req.host;
    head.append(host);
  }

  const summary = document.createElement("div");
  summary.className = "approval-summary";
  summary.textContent = req.summary || "(no arguments)";

  const row = document.createElement("div");
  row.className = "row";

  const allow = document.createElement("button");
  allow.className = "btn primary sm";
  allow.textContent = "Allow once";
  allow.addEventListener("click", () => {
    const always = card.querySelector(".always input")?.checked;
    send({ type: "approve", id: req.id, allow: true, host: req.host, hosts: req.hosts, always });
    clearPendingUi(req.id);
    setStatus("approved", false);
  });

  const deny = document.createElement("button");
  deny.className = "btn ghost sm";
  deny.textContent = "Deny";
  deny.addEventListener("click", () => {
    send({ type: "approve", id: req.id, allow: false });
    clearPendingUi(req.id);
    setStatus("denied", false);
  });

  row.append(allow, deny);

  if (req.host && req.risk !== "read") {
    const always = document.createElement("label");
    always.className = "always";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    always.append(cb, document.createTextNode("Always here"));
    row.append(always);
  }

  card.append(head, summary, row);
  $("pending").append(card);
  scrollBottom(true);
}

function askCard(req) {
  app.pending.set(req.id, req);
  const card = document.createElement("div");
  card.className = "card approval";
  card.dataset.pending = req.id;

  const head = document.createElement("div");
  head.className = "approval-head";
  const badge = document.createElement("span");
  badge.className = "risk";
  badge.textContent = "question";
  const name = document.createElement("b");
  name.textContent = "FoxAgent needs input";
  head.append(badge, name);

  const question = document.createElement("div");
  question.className = "ask-question";
  question.textContent = req.question || "";

  card.append(head, question);

  const options = Array.isArray(req.options) ? req.options.filter(Boolean) : [];
  if (options.length) {
    const grid = document.createElement("div");
    grid.className = "ask-options";
    for (const option of options.slice(0, 6)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = option;
      btn.addEventListener("click", () => {
        send({ type: "answer", id: req.id, text: option });
        clearPendingUi(req.id);
        setStatus("answered", false);
      });
      grid.append(btn);
    }
    card.append(grid);
  }

  const form = document.createElement("form");
  form.className = "ask-form";
  const input = document.createElement("input");
  input.className = "input";
  input.placeholder = "Type an answer…";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "btn primary sm";
  submit.textContent = "Answer";
  form.append(input, submit);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    send({ type: "answer", id: req.id, text: value });
    clearPendingUi(req.id);
    setStatus("answered", false);
  });

  card.append(form);
  $("pending").append(card);
  scrollBottom(true);
  setTimeout(() => input.focus(), 40);
}

/* ------------------------------------------------------------------ */
/* Page chip, model button, welcome                                    */
/* ------------------------------------------------------------------ */

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function renderTab() {
  const chip = $("pageChip");
  const label = chip.querySelector("span");
  const tab = app.tab;
  const usable = tab && /^https?:/i.test(tab.url || "");
  chip.dataset.live = usable ? "true" : "false";
  if (!tab) {
    label.textContent = "No page";
    chip.title = "No active tab";
    return;
  }
  if (!usable) {
    label.textContent = "Firefox page — not controllable";
    chip.title = tab.url || "";
    return;
  }
  const host = hostOf(tab.url);
  const title = (tab.title || "").trim();
  label.textContent = title ? (title.length > 42 ? title.slice(0, 42) + "…" : title) : host;
  chip.title = `${tab.title || ""}\n${tab.url || ""}`.trim();
}

function currentModel() {
  if (!app.settings) return "";
  return app.settings.providers?.[app.settings.provider]?.model || "";
}

function providerMeta(key) {
  return app.settings?.providerKeys?.[key] || {};
}

function providerLabel(key) {
  return providerMeta(key).label || key || "";
}

function providerModels(key) {
  if (Array.isArray(app.modelsByProvider[key])) return app.modelsByProvider[key];
  if (key === app.settings?.provider) return app.models || [];
  return [];
}

function renderModelButton() {
  const model = currentModel();
  const btn = $("modelBtn");
  btn.textContent = model || "Choose model";
  btn.dataset.empty = model ? "false" : "true";
  btn.title = model
    ? `${model}\n${providerLabel(app.settings.provider)} — click to change`
    : "Choose a local server or cloud model";
}

function renderWelcome() {
  const show = !currentModel();
  $("welcome").hidden = !show;
  if (!show) return;
  const key = app.settings?.provider;
  const meta = providerMeta(key);
  const stored = app.settings?.providers?.[key] || {};
  let text = "No model yet. Local servers and cloud providers are both in Models.";
  if (meta.cloud && !stored.hasKey) {
    text = `${meta.label || "This cloud provider"} needs an API key. Add one in Models.`;
  } else if (meta.cloud) {
    text = `${meta.label || "Cloud provider"} key saved. Detect its models, then pick one.`;
  }
  $("welcomeModelState").textContent = text;
}

function renderModelChips(container, models, selected, onPick) {
  container.replaceChildren();
  for (const model of models.slice(0, 20)) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "model-chip";
    chip.textContent = model;
    chip.title = model;
    chip.setAttribute("aria-pressed", model === selected ? "true" : "false");
    chip.addEventListener("click", () => onPick(model));
    container.append(chip);
  }
}

function markModelChips(container, selected) {
  container.querySelectorAll(".model-chip").forEach((chip) => {
    chip.setAttribute("aria-pressed", chip.textContent === selected ? "true" : "false");
  });
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

function providerKeys() {
  return Object.keys(app.settings?.providerKeys || {});
}

function selectedProvider() {
  return app.modelsProvider || app.settings?.provider || providerKeys()[0] || "";
}

function setDetectStatus(text, level = "") {
  const el = $("modelDetectStatus");
  el.textContent = text || "";
  el.dataset.level = level;
}

function renderModelCurrent() {
  const box = $("modelCurrent");
  box.replaceChildren();
  if (!app.settings) return;
  const key = app.settings.provider;
  const meta = providerMeta(key);
  const stored = app.settings.providers?.[key] || {};
  box.dataset.empty = stored.model ? "false" : "true";

  const top = document.createElement("div");
  top.className = "model-current-top";
  const label = mk("span", "In use");
  label.className = "model-current-label";
  const tag = mk("span", meta.cloud ? "cloud" : "local");
  tag.className = "tag";
  tag.dataset.tone = meta.cloud ? "warn" : "ok";
  top.append(label, tag);

  const model = mk("div", stored.model || "No model selected");
  model.className = "model-current-model";
  const line = mk("div", `${meta.label || key || "No provider"} · ${meta.cloud ? "cloud" : "local"}`);
  line.className = "model-current-provider";
  box.append(top, model, line);
}

function providerCard(key, meta) {
  const stored = app.settings?.providers?.[key] || {};
  const card = document.createElement("button");
  card.type = "button";
  card.className = "provider-card";
  card.dataset.provider = key;
  card.setAttribute("aria-pressed", key === selectedProvider() ? "true" : "false");

  const head = document.createElement("span");
  head.className = "provider-card-head";
  const name = document.createElement("b");
  name.textContent = meta.label || key;
  head.append(name);
  if (key === app.settings?.provider) {
    const active = document.createElement("span");
    active.className = "tag";
    active.textContent = "active";
    head.append(active);
  }

  const line = document.createElement("span");
  line.className = "provider-card-line";
  if (stored.model) line.textContent = stored.model;
  else if (meta.cloud) line.textContent = stored.hasKey ? "Key saved · pick a model" : "Add an API key";
  else line.textContent = "No model selected";

  card.append(head, line);
  card.addEventListener("click", () => selectProvider(key));
  return card;
}

function renderProviderGrid() {
  const local = $("localProviders");
  const cloud = $("cloudProviders");
  local.replaceChildren();
  cloud.replaceChildren();
  for (const key of providerKeys()) {
    const meta = providerMeta(key);
    (meta.cloud ? cloud : local).append(providerCard(key, meta));
  }
}

function renderDetectedModels(models, selected) {
  const list = $("modelListOptions");
  list.replaceChildren();
  for (const model of models) {
    const opt = document.createElement("option");
    opt.value = model;
    list.append(opt);
  }
  renderModelChips($("modelChips"), models, selected, (model) => {
    $("modelId").value = model;
    markModelChips($("modelChips"), model);
    renderModelSaveState();
  });
}

function renderModelSaveState() {
  const key = selectedProvider();
  const meta = providerMeta(key);
  const stored = app.settings?.providers?.[key] || {};
  const model = $("modelId").value.trim();
  const el = $("modelSaveState");
  el.dataset.level = "";
  if (!model) el.textContent = "Pick or type a model first.";
  else if (meta.cloud && !stored.hasKey) el.textContent = "Save an API key before using this model.";
  else if (key === app.settings?.provider && model === stored.model) el.textContent = "In use.";
  else el.textContent = "Click Use this model to switch.";
}

function renderModelsPanel(force = false) {
  if (!app.settings) return;
  const keys = providerKeys();
  if (!app.modelsProvider || !keys.includes(app.modelsProvider)) {
    app.modelsProvider = app.settings.provider || keys[0] || "";
  }
  const key = app.modelsProvider;
  const meta = providerMeta(key);
  const stored = app.settings.providers?.[key] || {};

  renderProviderGrid();
  renderModelCurrent();

  $("modelConfigTitle").textContent = meta.label || "Configure";
  if (force) {
    $("modelBaseUrl").value = stored.baseUrl || meta.baseUrl || "";
    $("modelId").value = stored.model || "";
  }
  $("modelProviderHint").textContent = meta.hint || "";
  $("keyState").textContent = stored.hasKey
    ? `saved ${stored.keyMask || ""}`.trim()
    : (meta.cloud ? "required" : "optional");
  $("keyHint").textContent = meta.cloud
    ? "Stored in this Firefox profile. The sidebar only ever sees a mask; requests to this provider use the saved key."
    : "Local servers usually need no key. If yours does, save it here.";

  const link = $("keyLink");
  link.hidden = !meta.keyUrl;
  if (meta.keyUrl) link.href = meta.keyUrl;

  $("modelApiKey").placeholder = stored.hasKey
    ? `Saved ${stored.keyMask || ""} — paste a new key to replace`.trim()
    : (meta.cloud ? "Paste your API key" : "Optional for local servers");
  $("forgetKeyBtn").hidden = !stored.hasKey;
  $("saveKeyBtn").disabled = false;
  $("cloudNotice").hidden = !meta.cloud;
  if (meta.cloud) $("cloudName").textContent = meta.label || key;

  const models = providerModels(key);
  renderDetectedModels(models, $("modelId").value.trim() || stored.model || "");
  if (!models.length && !$("modelDetectStatus").textContent.startsWith("Asking")) {
    setDetectStatus(meta.cloud && !stored.hasKey
      ? "Save a key, then Detect models."
      : "Detect models to load model ids, or type one.");
  }
  renderModelSaveState();
}

function selectProvider(key) {
  app.modelsProvider = key;
  $("modelApiKey").value = "";
  setDetectStatus("", "");
  renderModelsPanel(true);
}

function detectModels() {
  const key = selectedProvider();
  const meta = providerMeta(key);
  const url = $("modelBaseUrl").value.trim();
  if (!/^https?:\/\//i.test(url)) {
    setDetectStatus("Enter a full http:// or https:// URL.", "error");
    return;
  }
  const typedKey = $("modelApiKey").value.trim();
  if (meta.cloud && !typedKey && !app.settings?.providers?.[key]?.hasKey) {
    setDetectStatus(`Save your ${meta.label || "provider"} API key first.`, "error");
    $("modelApiKey").focus();
    return;
  }
  setDetectStatus("Asking for models…", "");
  $("detectModelsBtn").disabled = true;
  $("modelSaveState").textContent = "";
  send({
    type: "refreshModels",
    provider: key,
    patch: {
      providers: {
        [key]: { baseUrl: url, ...(typedKey ? { apiKey: typedKey } : {}) },
      },
    },
  });
  if (typedKey) {
    $("modelApiKey").value = "";
  }
  setTimeout(() => { $("detectModelsBtn").disabled = false; }, 13000);
}

function saveKey() {
  const key = selectedProvider();
  const value = $("modelApiKey").value.trim();
  if (!value) {
    setDetectStatus("Paste an API key first.", "error");
    return;
  }
  send({ type: "saveKey", provider: key, apiKey: value });
  $("modelApiKey").value = "";
}

function forgetKey() {
  const key = selectedProvider();
  const meta = providerMeta(key);
  if (!confirm(`Forget the ${meta.label || key} API key?`)) return;
  send({ type: "forgetKey", provider: key });
}

function useCurrentModel() {
  const key = selectedProvider();
  const meta = providerMeta(key);
  const stored = app.settings?.providers?.[key] || {};
  const model = $("modelId").value.trim();
  const baseUrl = $("modelBaseUrl").value.trim();
  if (!/^https?:\/\//i.test(baseUrl)) {
    setDetectStatus("Enter a full http:// or https:// base URL.", "error");
    $("modelBaseUrl").focus();
    return;
  }
  if (!model) {
    setDetectStatus("Pick or type a model id first.", "error");
    $("modelId").focus();
    return;
  }
  if (meta.cloud && !stored.hasKey) {
    setDetectStatus(`Save your ${meta.label || "provider"} API key first.`, "error");
    $("modelApiKey").focus();
    return;
  }
  send({ type: "useModel", provider: key, model, baseUrl });
  if (app.settings) {
    app.settings.provider = key;
    app.settings.providers[key] = { ...stored, model, baseUrl };
  }
  renderModelButton();
  renderModelCurrent();
  renderProviderGrid();
  renderModelSaveState();
  showPanel("chat");
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

const TAG_GLYPH = { Canvas: "▦", Page: "¶", Docs: "≡" };

function renderRecipes(recipes) {
  const holder = $("recipeGroups");
  holder.replaceChildren();
  const groups = new Map();
  for (const recipe of recipes) {
    if (!groups.has(recipe.tag)) groups.set(recipe.tag, []);
    groups.get(recipe.tag).push(recipe);
  }
  for (const [tag, items] of groups) {
    const group = document.createElement("div");
    group.className = "recipe-group";
    const title = document.createElement("div");
    title.className = "recipe-group-title";
    title.textContent = tag;
    group.append(title);

    for (const recipe of items) {
      const card = document.createElement("div");
      card.className = "recipe-card";

      const icon = document.createElement("div");
      icon.className = "recipe-icon";
      icon.textContent = TAG_GLYPH[tag] || "◆";

      const main = document.createElement("div");
      main.className = "recipe-main";
      const heading = document.createElement("div");
      heading.className = "recipe-title";
      heading.append(document.createTextNode(recipe.title));
      const tagEl = document.createElement("span");
      tagEl.className = "tag";
      tagEl.textContent = recipe.tag;
      heading.append(tagEl);
      const hint = document.createElement("div");
      hint.className = "recipe-hint";
      hint.textContent = recipe.hint;
      main.append(heading, hint);

      const run = document.createElement("button");
      run.type = "button";
      run.className = "btn ghost sm recipe-run";
      run.textContent = "Run";
      run.addEventListener("click", () => runRecipe(recipe.id));

      card.append(icon, main, run);
      group.append(card);
    }
    holder.append(group);
  }
}

function runRecipe(id) {
  if (app.busy) {
    showPanel("chat");
    showToast("Stop the current task before starting another.", "warn");
    return;
  }
  if (!currentModel()) {
    showPanel("models");
    showToast("Pick a model first.", "warn");
    return;
  }
  showPanel("chat");
  send({ type: "runRecipe", id });
}

/* ------------------------------------------------------------------ */
/* Activity                                                            */
/* ------------------------------------------------------------------ */

function renderLog() {
  const holder = $("logList");
  holder.replaceChildren();
  if (!app.log.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No tool calls yet. Run a task to see the trail.";
    holder.append(empty);
    return;
  }
  const entries = [...app.log].reverse().slice(0, 120);
  for (const entry of entries) {
    const details = document.createElement("details");
    details.className = "log-row";

    const summary = document.createElement("summary");
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const dot = document.createElement("i");
    dot.className = "dot";
    if (!entry.ok) dot.style.background = "var(--bad)";
    else if (entry.denied || entry.blocked) dot.style.background = "var(--warn)";
    const tool = document.createElement("span");
    tool.className = "log-tool";
    tool.textContent = entry.tool || "tool";
    const host = document.createElement("span");
    host.className = "log-host";
    host.textContent = entry.host || "";
    const ms = document.createElement("span");
    ms.className = "log-ms";
    ms.textContent = entry.ms != null ? `${entry.ms}ms` : "";
    summary.append(time, dot, tool, host, ms);

    const body = document.createElement("div");
    body.className = "log-body";
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify({ args: entry.args, error: entry.error, denied: entry.denied, blocked: entry.blocked }, null, 1);
    body.append(pre);

    details.append(summary, body);
    holder.append(details);
  }
}

function renderNotes() {
  $("notesView").textContent = app.notes.length ? app.notes.join("\n") : "(empty)";
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function fillSettings() {
  const s = app.settings;
  if (!s) return;

  $("setTemp").value = s.temperature;
  $("setSteps").value = s.maxSteps;
  $("setToolMode").value = s.toolMode;
  $("setContext").value = s.contextChars;
  $("setPageChars").value = s.maxPageChars;
  $("setDryRun").checked = Boolean(s.dryRun);
  $("setRead").value = s.approval?.read || "auto";
  $("setAct").value = s.approval?.act || "confirm";
  $("setWrite").value = s.approval?.write || "confirm";
  $("setAllowlist").value = (s.siteAllowlist || []).join("\n");

  renderSettingsSummary();
  renderTrusted();
}

function renderSettingsSummary() {
  const holder = $("settingsModelSummary");
  holder.replaceChildren();
  if (!app.settings) return;
  const key = app.settings.provider;
  const meta = providerMeta(key);
  const stored = app.settings.providers?.[key] || {};
  holder.dataset.empty = stored.model ? "false" : "true";

  const model = mk("div", stored.model || "No model selected");
  model.className = "model-summary-model";
  const line = mk("div", `${meta.label || key || "No provider"} · ${meta.cloud ? "cloud" : "local"}`);
  line.className = "model-summary-meta";
  holder.append(model, line);

  if (meta.cloud && !stored.hasKey) {
    const warn = mk("div", "No API key saved for this provider.");
    warn.className = "model-summary-warn";
    holder.append(warn);
  }
}

function renderTrusted() {
  const holder = $("trustedList");
  holder.replaceChildren();
  const sites = app.settings?.trustedSites || [];
  if (!sites.length) {
    const none = document.createElement("span");
    none.className = "field-hint";
    none.textContent = "None. Approve an action with “Always here” to add one.";
    holder.append(none);
    return;
  }
  for (const site of sites) {
    const chip = document.createElement("span");
    chip.className = "trusted-chip";
    chip.append(document.createTextNode(site));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = `Stop trusting ${site}`;
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      const next = (app.settings.trustedSites || []).filter((s) => s !== site);
      send({ type: "saveSettings", patch: { trustedSites: next } });
      app.settings.trustedSites = next;
      renderTrusted();
    });
    chip.append(remove);
    holder.append(chip);
  }
}

function parseHosts(value) {
  return String(value || "")
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);
}

function saveSettingsForm(event) {
  event?.preventDefault();
  if (!app.settings) return;
  const allowlist = parseHosts($("setAllowlist").value);
  const patch = {
    temperature: Number($("setTemp").value) || 0,
    maxSteps: Math.max(1, Math.min(80, Number($("setSteps").value) || 32)),
    toolMode: $("setToolMode").value,
    contextChars: Math.max(8000, Number($("setContext").value) || 48000),
    maxPageChars: Math.max(2000, Number($("setPageChars").value) || 12000),
    dryRun: $("setDryRun").checked,
    approval: {
      read: $("setRead").value,
      act: $("setAct").value,
      write: $("setWrite").value,
    },
    siteAllowlist: allowlist,
  };
  send({ type: "saveSettings", patch });
  app.settings = { ...app.settings, ...patch };
  renderSettingsSummary();
  showToast("Settings saved.", "success");
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

function showToast(text, level = "info") {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.dataset.level = level;
  toast.textContent = text;
  $("toasts").append(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(3px)";
    setTimeout(() => toast.remove(), 200);
  }, level === "error" ? 7000 : 3800);
}

/* ------------------------------------------------------------------ */
/* Panels                                                              */
/* ------------------------------------------------------------------ */

function showPanel(name) {
  app.panel = name;
  for (const candidate of ["chat", "tasks", "activity", "models", "settings"]) {
    $(`panel-${candidate}`).hidden = candidate !== name;
  }
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.setAttribute("aria-selected", tab.dataset.panel === name ? "true" : "false");
  });
  if (name === "models") renderModelsPanel(true);
  if (name === "settings") fillSettings();
  if (name === "chat") {
    setTimeout(() => $("input").focus(), 30);
    scrollBottom(true);
  }
  if (name === "activity") renderLog();
  if (name === "tasks" && !app.settings) send({ type: "getState" });
}

/* ------------------------------------------------------------------ */
/* Background messages                                                 */
/* ------------------------------------------------------------------ */

function applyState(msg) {
  app.settings = msg.settings;
  app.transcript = Array.isArray(msg.transcript) ? msg.transcript : [];
  app.log = Array.isArray(msg.log) ? msg.log : [];
  app.notes = Array.isArray(msg.notes) ? msg.notes : [];
  app.models = Array.isArray(msg.models) ? msg.models : [];
  app.modelsByProvider = msg.modelsByProvider && typeof msg.modelsByProvider === "object"
    ? msg.modelsByProvider
    : {};
  if (!app.modelsProvider) app.modelsProvider = msg.provider || app.settings?.provider || null;

  setConn("connected", "connected");
  renderTranscript(true);
  renderModelButton();
  renderWelcome();
  renderSettingsSummary();
  renderRecipes(msg.recipes || []);
  renderLog();
  renderNotes();
  setBusy(Boolean(msg.busy));
  if (app.panel === "settings") fillSettings();
  if (app.panel === "models") renderModelsPanel(true);
  if (app.panel === "chat" && !currentModel()) $("welcome").hidden = false;
}

function onMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "state":
      applyState(msg);
      break;

    case "item":
      if (msg.item) appendTranscript(msg.item);
      break;

    case "assistant_start":
      startStreaming();
      break;

    case "delta":
      if (msg.text) onDelta(msg.text);
      break;

    case "assistant_end":
      endStreaming(msg);
      break;

    case "phase":
      setStatus(msg.step ? `step ${msg.step}/${msg.maxSteps} · thinking` : "thinking", true);
      break;

    case "tool_start": {
      const call = msg.call || {};
      setStatus(`${call.name}${call.summary ? " · " + call.summary : ""}`, true);
      break;
    }

    case "tool_end": {
      setStatus(msg.name ? `${msg.name} ${msg.ok ? "finished" : "failed"}` : "tool finished", false);
      break;
    }

    case "confirm":
      showPanel("chat");
      setStatus("waiting for your approval", true);
      approvalCard(msg.request);
      break;

    case "ask":
      showPanel("chat");
      setStatus("waiting for your answer", true);
      askCard(msg.request);
      break;

    case "confirm_expired":
    case "ask_expired":
      clearPendingUi(msg.id);
      showToast("That prompt expired. The agent was told you did not respond.", "warn");
      break;

    case "pending_clear":
      $("pending").replaceChildren();
      app.pending.clear();
      break;

    case "models": {
      const key = msg.provider || app.settings?.provider;
      const models = Array.isArray(msg.models) ? msg.models : [];
      if (key) app.modelsByProvider[key] = models;
      if (key === app.settings?.provider) app.models = models;
      $("detectModelsBtn").disabled = false;
      if (app.panel === "models" && key === selectedProvider()) {
        const selected = $("modelId").value.trim() || app.settings?.providers?.[key]?.model || "";
        renderDetectedModels(models, selected);
        if (models.length) {
          setDetectStatus(`${models.length} model${models.length === 1 ? "" : "s"} found. Pick one below or type its id.`, "ok");
        } else {
          setDetectStatus("No models listed. Is a model loaded?", "error");
        }
      }
      renderProviderGrid();
      renderModelCurrent();
      renderModelButton();
      break;
    }

    case "modelsError": {
      const key = msg.provider || selectedProvider();
      const text = msg.text || "Could not reach the provider.";
      $("detectModelsBtn").disabled = false;
      if (app.panel === "models" && key === selectedProvider()) setDetectStatus(text, "error");
      showToast(text, "error");
      break;
    }

    case "settings":
      app.settings = msg.settings;
      renderModelButton();
      renderWelcome();
      renderSettingsSummary();
      if (app.panel === "models") renderModelsPanel(false);
      if (app.panel === "settings") fillSettings();
      $("dryRun").checked = Boolean(app.settings.dryRun);
      break;

    case "tab":
      app.tab = msg.tab;
      renderTab();
      break;

    case "busy":
      setBusy(Boolean(msg.busy));
      if (!msg.busy) setStatus("", false);
      break;

    case "notes":
      app.notes = msg.notes || [];
      renderNotes();
      break;

    case "log":
      app.log = msg.log || [];
      renderLog();
      break;

    case "reset":
      app.transcript = [];
      app.streaming = null;
      $("pending").replaceChildren();
      app.pending.clear();
      renderTranscript(true);
      showToast("New conversation.", "success");
      break;

    case "toast":
      showToast(msg.text, msg.level);
      break;

    case "needModel":
      app.modelsProvider = app.settings?.provider || null;
      showPanel("models");
      showToast("Choose a model before sending.", "warn");
      if (!$("modelId").value.trim()) $("modelId").focus();
      break;

    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

function initEvents() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showPanel(tab.dataset.panel));
  });

  $("settingsBtn").addEventListener("click", () => showPanel("settings"));
  $("themeBtn").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
    applyTheme(next);
  });
  $("modelBtn").addEventListener("click", () => {
    app.modelsProvider = app.settings?.provider || null;
    showPanel("models");
    if (!$("modelId").value.trim()) $("modelId").focus();
  });
  $("newChatBtn").addEventListener("click", () => {
    if (app.busy) {
      showToast("Stop the current task before starting a new conversation.", "warn");
      return;
    }
    if (app.transcript.length && !confirm("Start a new conversation? The current transcript is cleared.")) return;
    showPanel("chat");
    send({ type: "reset" });
  });
  $("backToChat").addEventListener("click", () => showPanel("chat"));
  $("welcomeTasks").addEventListener("click", () => showPanel("tasks"));
  $("welcomeModels").addEventListener("click", () => {
    app.modelsProvider = app.settings?.provider || null;
    showPanel("models");
  });
  $("modelsBack").addEventListener("click", () => showPanel("chat"));
  $("settingsChangeModel").addEventListener("click", () => {
    app.modelsProvider = app.settings?.provider || null;
    showPanel("models");
  });

  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    if (app.busy) return;
    const text = $("input").value.trim();
    if (!text) return;
    if (!currentModel()) {
      app.modelsProvider = app.settings?.provider || null;
      showPanel("models");
      showToast("Pick a model first.", "warn");
      return;
    }
    send({ type: "send", text });
    $("input").value = "";
    resizeInput();
    setStatus("sending…", true);
  });

  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });
  $("input").addEventListener("input", resizeInput);

  $("stopBtn").addEventListener("click", () => {
    send({ type: "abort" });
    setStatus("stopping…", true);
  });

  $("dryRun").addEventListener("change", () => {
    const dryRun = $("dryRun").checked;
    send({ type: "saveSettings", patch: { dryRun } });
    if (app.settings) app.settings.dryRun = dryRun;
    $("setDryRun").checked = dryRun;
    showToast(dryRun ? "Dry run on: actions are described, not performed." : "Dry run off.", dryRun ? "warn" : "info");
  });

  $("detectModelsBtn").addEventListener("click", detectModels);
  $("saveKeyBtn").addEventListener("click", saveKey);
  $("forgetKeyBtn").addEventListener("click", forgetKey);
  $("useModelBtn").addEventListener("click", useCurrentModel);
  $("modelId").addEventListener("input", () => {
    markModelChips($("modelChips"), $("modelId").value.trim());
    renderModelSaveState();
  });
  $("modelApiKey").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveKey(); }
  });

  $("settingsForm").addEventListener("submit", saveSettingsForm);
  $("saveTop").addEventListener("click", () => saveSettingsForm());

  $("resetChat").addEventListener("click", () => {
    if (app.busy) {
      showToast("Stop the current task before resetting the conversation.", "warn");
      return;
    }
    if (!confirm("Clear the transcript and the model's conversation history?")) return;
    send({ type: "reset" });
    showPanel("chat");
  });

  $("clearNotes").addEventListener("click", () => send({ type: "clearNotes" }));
  $("clearLog").addEventListener("click", () => send({ type: "clearLog" }));
  $("exportLog").addEventListener("click", () => send({ type: "exportLog" }));

  window.addEventListener("beforeunload", () => {
    try { port?.disconnect(); } catch {}
  });
}

function resizeInput() {
  const input = $("input");
  input.style.height = "auto";
  input.style.height = Math.min(150, Math.max(36, input.scrollHeight)) + "px";
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

initEvents();
setConn("connecting", "connecting");
renderNotes();
connect();
resizeInput();
