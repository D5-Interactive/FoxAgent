/*
 * The agent loop: request a completion, run the requested tools, feed results
 * back, repeat until the model answers or the step budget runs out.
 */

import { streamChat, toolSchemas } from "./providers.js";
import { TOOLS, findTool, summarizeArgs } from "./tools.js";
import { buildSystemPrompt } from "./prompt.js";
import { activeModel, activeProvider, addLog, addTranscript } from "./store.js";
import { resolveTab, hostOf } from "./page.js";

const MAX_CALLS_PER_TURN = 6;

function clipText(s, max) {
  const v = String(s ?? "");
  return v.length > max ? v.slice(0, max) + "\n[truncated]" : v;
}

function siteMatches(host, entry) {
  if (!host || !entry) return false;
  const h = host.toLowerCase().replace(/^www\./, "");
  const e = String(entry).toLowerCase().replace(/^www\./, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return h === e || h.endsWith("." + e);
}

export function allowedBySite(host, settings) {
  const list = (settings.siteAllowlist || []).filter(Boolean);
  if (!list.length || !host) return true;
  return list.some((entry) => siteMatches(host, entry));
}

export function trustedBySite(host, settings) {
  return (settings.trustedSites || []).some((entry) => siteMatches(host, entry));
}

const URL_TOOLS = new Set(["browser.open", "browser.download", "web.fetch", "page.fetch", "page.fetchAll"]);

/*
 * Risk can depend on the arguments, not only the tool: a same-origin POST via
 * page.fetch changes data just like clicking a Save button.
 */
function callRisk(spec, args) {
  if (!spec) return "read";
  if (spec.name === "page.fetch") {
    const method = String(args?.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") return "act";
  }
  return spec.risk;
}

/*
 * Collect every host a call can touch. downloadMany can mix hosts, so each
 * file URL is checked against the allowlist instead of only the first one.
 */
async function callContext(spec, args) {
  const hosts = [];
  const add = (host) => {
    if (host && !hosts.includes(host)) hosts.push(host);
  };
  let tabUrl = "";
  if (spec.needsPage) {
    try {
      const tab = await resolveTab(args.tabId);
      tabUrl = tab.url || "";
      add(hostOf(tabUrl));
    } catch {
      /* resolveTab reports the real error when the tool runs */
    }
  }
  const addUrl = (value) => {
    if (!value) return;
    try {
      add(hostOf(new URL(String(value), tabUrl || undefined).href));
    } catch {
      /* validate later, in the tool itself */
    }
  };
  if (spec.name === "browser.downloadMany") {
    for (const file of Array.isArray(args.files) ? args.files : []) addUrl(file?.url);
  } else if (URL_TOOLS.has(spec.name)) {
    addUrl(args.url);
  } else if (spec.name === "browser.switch" || spec.name === "browser.close") {
    try {
      const tab = await browser.tabs.get(Number(args.tabId));
      add(hostOf(tab.url));
    } catch {
      /* the tool reports an unknown tab id */
    }
  }
  return {
    hosts,
    primary: hosts[0] || "",
    label: hosts.slice(0, 3).join(", ") + (hosts.length > 3 ? "…" : ""),
  };
}

/* ------------------------------------------------------------------ */
/* Compaction                                                          */
/* ------------------------------------------------------------------ */

function estimate(entry) {
  let n = (entry.text || "").length + 40;
  for (const c of entry.calls || []) n += c.name.length + JSON.stringify(c.args || {}).length + 30;
  return n;
}

function groupTurns(history) {
  const turns = [];
  let current = [];
  for (const entry of history) {
    if (entry.role === "user" && current.length) {
      turns.push(current);
      current = [];
    }
    current.push(entry);
  }
  if (current.length) turns.push(current);
  return turns;
}

function fitHistory(history, budget) {
  const turns = groupTurns(history);
  const kept = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const size = turns[i].reduce((sum, e) => sum + estimate(e), 0);
    if (kept.length && used + size > budget) break;
    kept.unshift(turns[i]);
    used += size;
  }
  const flat = kept.flat().map((e) => ({ ...e }));
  let total = flat.reduce((sum, e) => sum + estimate(e), 0);
  let clipped = false;
  if (total > budget) {
    for (const entry of flat) {
      if (total <= budget) break;
      if (entry.role !== "tool" || !entry.text) continue;
      const excess = total - budget;
      const target = Math.max(700, entry.text.length - excess - 80);
      if (target < entry.text.length) {
        total -= entry.text.length - target;
        entry.text = entry.text.slice(0, target) + "\n[truncated to fit the context window]";
        clipped = true;
      }
    }
  }
  return { history: flat, trimmed: kept.length < turns.length || clipped };
}

function toProviderMessages(state, settings, tab) {
  const system = buildSystemPrompt(state, settings, tab);
  const budget = Math.max(6000, Number(settings.contextChars || 48000) - system.length);
  const fitted = fitHistory(state.history, budget);
  const messages = [{ role: "system", content: system }];
  if (fitted.trimmed) {
    messages.push({
      role: "system",
      content: "Context note: earlier parts of this conversation were removed to fit the model's window. Use the scratchpad and ask the user if you need a detail again.",
    });
  }
  for (const entry of fitted.history) {
    if (entry.role === "user") {
      messages.push({ role: "user", content: entry.text || "" });
    } else if (entry.role === "assistant") {
      if (entry.protocol === "native" && entry.calls?.length) {
        messages.push({
          role: "assistant",
          content: entry.text || "",
          tool_calls: entry.calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
          })),
        });
      } else {
        messages.push({ role: "assistant", content: entry.text || "" });
      }
    } else if (entry.role === "tool") {
      if (entry.protocol === "native" && entry.callId) {
        messages.push({ role: "tool", tool_call_id: entry.callId, content: entry.text || "(no output)" });
      } else {
        messages.push({
          role: "user",
          content: `TOOL RESULT (${entry.name || "tool"}):\n${entry.text || "(no output)"}`,
        });
      }
    }
  }
  return messages;
}

/* ------------------------------------------------------------------ */
/* JSON fallback tool protocol                                         */
/* ------------------------------------------------------------------ */

function tryParseJson(value) {
  if (typeof value !== "string") return value;
  const t = value.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function collectCalls(value, out, depth = 0) {
  if (depth > 4 || out.length >= MAX_CALLS_PER_TURN) return;
  if (Array.isArray(value)) {
    for (const item of value) collectCalls(item, out, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  const nested = value.tools || value.tool_calls || value.calls;
  if (Array.isArray(nested)) {
    for (const item of nested) collectCalls(item, out, depth + 1);
    return;
  }
  const name = value.tool || value.tool_name || value.name || value.function?.name;
  if (!name || typeof name !== "string") return;
  const known = findTool(name);
  const explicit = Boolean(value.tool || value.tool_name || value.function?.name);
  if (!known && !explicit) return;
  let args = value.args ?? value.arguments ?? value.parameters ?? value.input ?? value.function?.arguments ?? {};
  if (typeof args === "string") args = tryParseJson(args) || {};
  if (!args || typeof args !== "object") args = {};
  out.push({
    id: "json_" + Math.random().toString(36).slice(2, 10),
    name: known?.name || name,
    args,
    rawArgs: JSON.stringify(args),
  });
}

export function parseTextCalls(text) {
  const original = String(text || "");
  const calls = [];
  let stripped = original;

  const fence = /```(?:json|tool|tool_call|tool_calls|tool-call)?[^\S\n]*\n?([\s\S]*?)```/gi;
  stripped = stripped.replace(fence, (match, body) => {
    const parsed = tryParseJson(body);
    if (!parsed) return match;
    const found = [];
    collectCalls(parsed, found);
    if (!found.length) return match;
    calls.push(...found);
    return "";
  });

  if (!calls.length) {
    const tagged = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
    stripped = stripped.replace(tagged, (match, body) => {
      const parsed = tryParseJson(body);
      if (!parsed) return match;
      const found = [];
      collectCalls(parsed, found);
      if (!found.length) return match;
      calls.push(...found);
      return "";
    });
  }

  if (!calls.length) {
    const bare = tryParseJson(stripped);
    if (bare) {
      const found = [];
      collectCalls(bare, found);
      if (found.length) {
        calls.push(...found);
        stripped = "";
      }
    }
  }

  return { calls: calls.slice(0, MAX_CALLS_PER_TURN), text: stripped.replace(/\n{3,}/g, "\n\n").trim() };
}

/* ------------------------------------------------------------------ */
/* Turn                                                                */
/* ------------------------------------------------------------------ */

function notice(state, emit, text, level = "info") {
  const item = addTranscript({ type: "notice", text, level });
  emit({ type: "item", item });
}

async function executeCall(call, ctx) {
  const { state, settings, signal, emit, approve, ask } = ctx;
  const started = performance.now();
  const spec = findTool(call.name);
  const args = call.args && typeof call.args === "object" ? call.args : {};
  const risk = callRisk(spec, args);

  const emitStart = () => emit({
    type: "tool_start",
    call: { id: call.id, name: spec?.name || call.name, risk, summary: summarizeArgs(args) },
  });

  if (!spec) {
    emitStart();
    const text = `Unknown tool "${call.name}". Available tools: ${TOOLS.map((t) => t.name).join(", ")}.`;
    const ms = Math.round(performance.now() - started);
    emit({ type: "tool_end", id: call.id, name: call.name, ok: false, text, ms });
    addLog({ tool: call.name, args, ok: false, ms, risk: "read", host: "" });
    return { ok: false, text, ms, name: call.name };
  }

  if (signal.aborted) {
    return { ok: false, text: "Stopped by the user.", ms: 0, name: spec.name, aborted: true };
  }

  const context = await callContext(spec, args);
  const host = context.primary;
  const blockedHosts = context.hosts.filter((h) => !allowedBySite(h, settings));

  if (blockedHosts.length) {
    emitStart();
    const text = `Blocked by your site allowlist: ${blockedHosts.join(", ")} ${blockedHosts.length === 1 ? "is" : "are"} not on the list. Add ${blockedHosts.length === 1 ? "it" : "them"} in Settings to allow actions there.`;
    const ms = Math.round(performance.now() - started);
    emit({ type: "tool_end", id: call.id, name: spec.name, ok: false, text, ms });
    addLog({ tool: spec.name, args, ok: false, ms, risk, host: context.label, blocked: true });
    return { ok: false, text, ms, name: spec.name };
  }

  if (settings.dryRun && risk !== "read") {
    emitStart();
    const ms = Math.round(performance.now() - started);
    const text = `DRY RUN: ${spec.name} was not executed. No changes were made. Args: ${summarizeArgs(args) || "(none)"}`;
    emit({ type: "tool_end", id: call.id, name: spec.name, ok: true, text, ms, dryRun: true });
    addLog({ tool: spec.name, args, ok: true, ms, risk, host: context.label, dryRun: true });
    return { ok: true, text, ms, name: spec.name, dryRun: true };
  }

  const policy = settings.approval?.[risk] || "auto";
  const trusted = context.hosts.length > 0 && context.hosts.every((h) => trustedBySite(h, settings));
  const needsApproval = policy === "confirm" && !trusted;
  if (needsApproval) {
    emitStart();
    const allowed = await approve({
      id: call.id,
      tool: spec.name,
      risk,
      host: context.label,
      hosts: context.hosts,
      args,
      summary: summarizeArgs(args),
    });
    if (!allowed) {
      const ms = Math.round(performance.now() - started);
      const text = "The user denied this action. Do not retry it; explain what you would have done and ask how to proceed.";
      emit({ type: "tool_end", id: call.id, name: spec.name, ok: false, text, ms, denied: true });
      addLog({ tool: spec.name, args, ok: false, ms, risk, host: context.label, denied: true });
      return { ok: false, text, ms, name: spec.name };
    }
  } else {
    emitStart();
  }

  const toolCtx = {
    settings,
    state,
    emit,
    approve,
    ask,
    signal,
    notes: state.notes,
    activeTab: null,
  };

  try {
    const raw = await spec.run(args, toolCtx);
    const ms = Math.round(performance.now() - started);
    const text = clipText(typeof raw === "string" ? raw : JSON.stringify(raw, null, 1), 26000);
    emit({
      type: "tool_end",
      id: call.id,
      name: spec.name,
      ok: true,
      text,
      ms,
      card: { tool: spec.name, args, host },
    });
    addLog({ tool: spec.name, args, ok: true, ms, risk, host });
    return { ok: true, text, ms, name: spec.name, card: { tool: spec.name, args, host } };
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    const text = `ERROR from ${spec.name}: ${err?.message || err}`;
    emit({ type: "tool_end", id: call.id, name: spec.name, ok: false, text, ms });
    addLog({ tool: spec.name, args, ok: false, ms, risk, host, error: String(err?.message || err) });
    return { ok: false, text, ms, name: spec.name };
  }
}

export async function runAgent({ state, settings, emit, approve, ask, signal }) {
  const provider = activeProvider();
  const model = activeModel();
  if (!model) throw new Error("No model selected. Open Models and pick one.");

  const maxSteps = Math.max(1, Math.min(80, Number(settings.maxSteps) || 32));
  const useNative = settings.toolMode !== "json";
  let steps = 0;
  let lastText = "";

  while (steps < maxSteps) {
    if (signal.aborted) break;

    let tab = null;
    try { tab = await resolveTab(); } catch {}

    emit({ type: "phase", phase: "thinking", step: steps + 1, maxSteps });
    emit({ type: "assistant_start" });

    let response;
    try {
      response = await streamChat({
        provider,
        model,
        messages: toProviderMessages(state, settings, tab),
        tools: useNative ? toolSchemas(TOOLS) : undefined,
        temperature: settings.temperature,
        signal,
        onDelta: (t) => emit({ type: "delta", text: t }),
      });
    } catch (err) {
      if (err?.aborted) {
        notice(state, emit, "Stopped.", "warn");
        break;
      }
      throw err;
    }

    let text = response.text || "";
    let calls = response.calls || [];
    let protocol = "native";

    if (!calls.length && settings.toolMode !== "native") {
      const parsed = parseTextCalls(text);
      if (parsed.calls.length) {
        calls = parsed.calls;
        text = parsed.text;
        protocol = "json";
      }
    }

    const assistantEntry = {
      role: "assistant",
      text,
      calls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      protocol,
      at: Date.now(),
    };
    state.history.push(assistantEntry);

    if (text) {
      const item = addTranscript({ type: "assistant", text });
      emit({ type: "assistant_end", text: item.text, item });
      lastText = text;
    } else {
      emit({ type: "assistant_end", text: "" });
    }

    if (!calls.length) {
      if (response.finishReason === "length") {
        notice(state, emit, "The model hit its output limit mid-answer. Ask it to continue, or raise the model's max tokens.", "warn");
      }
      if (!text) notice(state, emit, "The model returned an empty reply. Try again, or pick a different model.", "warn");
      break;
    }

    for (const call of calls) {
      let result;
      if (signal.aborted) {
        // Keep native tool-call history valid: every requested call needs a result,
        // even when the user stops before it runs.
        result = {
          ok: false,
          text: "Not executed: the user stopped the task.",
          ms: 0,
          name: findTool(call.name)?.name || call.name,
          aborted: true,
        };
      } else {
        result = await executeCall(call, { state, settings, emit, approve, ask, signal });
      }
      const toolEntry = {
        role: "tool",
        callId: call.id,
        name: result.name,
        text: result.text,
        ok: result.ok,
        protocol,
        at: Date.now(),
      };
      state.history.push(toolEntry);
      if (result.aborted) continue;
      const item = addTranscript({
        type: "tool",
        name: result.name,
        args: call.args,
        text: result.text,
        ok: result.ok,
        ms: result.ms,
        dryRun: Boolean(result.dryRun),
        risk: callRisk(findTool(result.name), call.args),
      });
      emit({ type: "item", item });
    }

    steps += 1;
    if (signal.aborted) break;
  }

  if (steps >= maxSteps) {
    notice(state, emit, `Step limit reached (${maxSteps}). Progress is in the scratchpad; send "continue" to keep going, or raise the limit in Settings.`, "warn");
  }
  return { steps, text: lastText };
}
