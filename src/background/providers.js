import { activeProvider, activeModel, PROVIDERS } from "./store.js";
import { serverRoot } from "./modelinfo.js";
function join(base, path) {
  return String(base || "").replace(/\/+$/, "") + path;
}
function providerKind(provider) {
  if (provider?.kind) return provider.kind;
  if (provider?.key === "anthropic" || provider?.id === "anthropic") return "anthropic";
  return "openai";
}
function headers(provider, { json = false } = {}) {
  const h = {};
  if (json) h["Content-Type"] = "application/json";
  const key = String(provider?.apiKey || "").trim();
  if (providerKind(provider) === "anthropic") {
    if (key) h["x-api-key"] = key;
    h["anthropic-version"] = "2023-06-01";
    h["anthropic-dangerous-direct-browser-access"] = "true";
  } else if (key) {
    h.Authorization = `Bearer ${key}`;
  }
  return h;
}
function labelOf(provider) {
  return provider?.label || PROVIDERS[provider?.key]?.label || "the model server";
}
function friendlyNetworkError(err, provider) {
  const msg = String(err?.message || err);
  if (/Failed to fetch|NetworkError|Connection refused|Load failed|Network request failed/i.test(msg)) {
    if (provider?.cloud) {
      return new Error(
        `Can't reach ${labelOf(provider)}. Check your connection and that Firefox is allowed to contact ${provider.baseUrl}.`
      );
    }
    return new Error(
      `Can't reach ${labelOf(provider)} at ${provider.baseUrl}. ` + `Is it running and reachable from Firefox? ${provider.hint || ""}`.trim()
    );
  }
  if (/abort/i.test(msg)) {
    const e = new Error("Stopped.");
    e.aborted = true;
    return e;
  }
  return err instanceof Error ? err : new Error(msg);
}
function httpError(provider, res, body) {
  const clean = String(body || "").replace(/\s+/g, " ").slice(0, 900);
  let hint = "";
  if (res.status === 401 || res.status === 403) {
    hint = provider.cloud ? ` The API key was rejected. Open Models, save a valid key for ${labelOf(provider)}, and try again.` : ` The server rejected the request. If it requires an API key, add one in Models.`;
  } else if (res.status === 404) {
    hint = providerKind(provider) === "anthropic" ? " Check the base URL (https://api.anthropic.com/v1) and the model id." : " Check that the base URL ends in /v1 and that the model name is loaded.";
  } else if (res.status === 429) {
    hint = " Rate limit or quota reached. Wait a moment, or check your plan and usage with this provider.";
  } else if (/insufficient|quota|credit|billing/i.test(clean)) {
    hint = " This key may be out of credit or its billing is not set up.";
  } else if (res.status === 400 && /tool/i.test(clean)) {
    hint = " This model may not support tools. Try JSON tool mode in Settings, or pick a tool-capable model.";
  }
  const err = new Error(`${labelOf(provider)} returned ${res.status} ${res.statusText}.${hint}
${clean}`.trim());
  err.status = res.status;
  err.body = clean;
  err.toolsUnsupported = [400, 422, 500].includes(res.status) && /tool/i.test(clean) && !CONTEXT_OVERFLOW.test(clean);
  err.contextOverflow = CONTEXT_OVERFLOW.test(clean);
  const limit = clean.match(/maximum context length is (\d+)/i) || clean.match(/n_ctx(?:_slot)?\s*[=:]\s*(\d+)/i) || clean.match(/context (?:size|length|window)(?: of)?\s*(?:is\s*)?\(?(\d{3,})/i);
  if (limit) err.contextLimit = Number(limit[1]);
  return err;
}
const CONTEXT_OVERFLOW = /maximum context length|exceeds? the (?:available )?context|context (?:length|size|window) (?:exceeded|is too small|overflow)|too many tokens|prompt is too long|n_ctx|context overflow/i;
async function listModels(settings = null, providerKey = null) {
  const key = providerKey || (settings ? settings.provider : activeProvider().key);
  const provider = { ...PROVIDERS[key], key, ...settings?.providers?.[key] || {} };
  if (!provider.baseUrl) throw new Error(`No base URL configured for ${labelOf(provider)}.`);
  if (provider.cloud && !provider.apiKey) {
    throw new Error(`Add your ${labelOf(provider)} API key in Models first.`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12e3);
  try {
    const res = await fetch(join(provider.baseUrl, "/models"), {
      headers: headers(provider),
      signal: controller.signal
    });
    if (!res.ok) throw httpError(provider, res, await res.text());
    const data = await res.json();
    const ids = [];
    for (const item of data?.data || data?.models || []) {
      const id = item?.id || item?.name || item?.model;
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids.sort((a, b) => a.localeCompare(b));
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`${labelOf(provider)} did not answer within 12 seconds. Check the URL and try again.`);
    }
    throw friendlyNetworkError(err, provider);
  } finally {
    clearTimeout(timer);
  }
}
function normalizeToolCalls(rawCalls) {
  return rawCalls.map((call, i) => {
    const fn = call.function || {};
    let args = fn.arguments;
    if (typeof args === "string") {
      try {
        args = args.trim() ? JSON.parse(args) : {};
      } catch {
        args = {};
      }
    }
    return {
      id: call.id || `call_${Date.now().toString(36)}_${i}`,
      name: String(fn.name || call.name || "").trim(),
      args: args && typeof args === "object" ? args : {},
      rawArgs: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(args || {})
    };
  }).filter((c) => c.name);
}
function readOpenAi(json, acc, onDelta) {
  if (json?.error) {
    throw new Error(json.error.message || json.error.type || "The provider returned an error.");
  }
  // With stream_options.include_usage the last chunk has usage and no choices.
  if (json?.usage) acc.usage = json.usage;
  const choice = json?.choices?.[0];
  if (!choice) return;
  const delta = choice.delta || choice.message || {};
  if (typeof delta.content === "string" && delta.content) {
    acc.text += delta.content;
    if (onDelta) onDelta(delta.content);
  }
  const calls = delta.tool_calls || choice.message?.tool_calls;
  if (Array.isArray(calls)) {
    for (const tc of calls) {
      const idx = Number.isInteger(tc.index) ? tc.index : acc.calls.length;
      let entry = acc.calls.find((c) => c.index === idx);
      if (!entry) {
        entry = { index: idx, id: "", name: "", argsText: "" };
        acc.calls.push(entry);
      }
      if (tc.id) entry.id = tc.id;
      const fn = tc.function || {};
      if (fn.name) entry.name += fn.name;
      if (typeof fn.arguments === "string") entry.argsText += fn.arguments;
      else if (fn.arguments && typeof fn.arguments === "object") entry.argsText += JSON.stringify(fn.arguments);
    }
  }
  if (choice.finish_reason) acc.finishReason = choice.finish_reason;
  if (json.usage) acc.usage = json.usage;
}
function finishOpenAi(acc, json) {
  return {
    text: acc.text.trim(),
    calls: normalizeToolCalls(
      acc.calls.sort((a, b) => a.index - b.index).map((c) => ({ id: c.id, function: { name: c.name, arguments: c.argsText } }))
    ),
    finishReason: acc.finishReason || json?.choices?.[0]?.finish_reason || "",
    usage: acc.usage || json?.usage || null
  };
}
function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : part?.text || "").join("");
  }
  return "";
}
function parseArgs(value) {
  let args = value;
  if (typeof args === "string") {
    try {
      args = args.trim() ? JSON.parse(args) : {};
    } catch {
      args = {};
    }
  }
  return args && typeof args === "object" ? args : {};
}
function anthropicBlocks(content) {
  if (!Array.isArray(content)) return contentText(content) || "(empty)";
  const blocks = [];
  for (const part of content) {
    if (!part) continue;
    if (typeof part === "string") {
      if (part) blocks.push({ type: "text", text: part });
    } else if (part.type === "text" && part.text) {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      const match = String(url || "").match(/^data:([^;]+);base64,([\s\S]+)$/);
      if (match) blocks.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
    }
  }
  return blocks.length ? blocks : "(empty)";
}
function toAnthropicMessages(messages) {
  const system = [];
  const out = [];
  for (const message of messages || []) {
    if (!message || !message.role) continue;
    if (message.role === "system") {
      const text = contentText(message.content);
      if (text) system.push(text);
      continue;
    }
    if (message.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: message.tool_call_id || message.callId || "",
        content: String(message.content ?? "(no output)")
      };
      const last2 = out[out.length - 1];
      const onlyResults = last2 && last2.role === "user" && Array.isArray(last2.content) && last2.content.every((part) => part.type === "tool_result");
      if (onlyResults) last2.content.push(block);
      else out.push({ role: "user", content: [block] });
      continue;
    }
    if (message.role === "assistant") {
      const blocks = [];
      const text = contentText(message.content);
      if (text) blocks.push({ type: "text", text });
      for (const call of message.tool_calls || []) {
        const fn = call.function || call;
        const name = String(fn.name || "").trim();
        if (!name) continue;
        blocks.push({
          type: "tool_use",
          id: call.id || `toolu_${Date.now().toString(36)}_${blocks.length}`,
          name,
          input: parseArgs(fn.arguments ?? fn.args ?? {})
        });
      }
      if (!blocks.length) blocks.push({ type: "text", text: "(no content)" });
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    const content = anthropicBlocks(message.content);
    const last = out[out.length - 1];
    if (last && last.role === "user") {
      if (typeof content === "string") {
        if (typeof last.content === "string") last.content += "\n\n" + content;
        else last.content.push({ type: "text", text: content });
      } else if (typeof last.content === "string") {
        last.content = [{ type: "text", text: last.content }, ...content];
      } else {
        last.content.push(...content);
      }
    } else {
      out.push({ role: "user", content });
    }
  }
  return {
    system: system.filter(Boolean).join("\n\n"),
    messages: out.length ? out : [{ role: "user", content: "(empty)" }]
  };
}
function anthropicTools(tools) {
  return (tools || []).map((tool) => {
    const fn = tool.function || tool;
    if (!fn?.name) return null;
    return {
      name: fn.name,
      description: fn.description || "",
      input_schema: fn.parameters || fn.input_schema || { type: "object", properties: {} }
    };
  }).filter(Boolean);
}
function mapStopReason(reason) {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
    default:
      return reason ? "stop" : "";
  }
}
function readAnthropic(json, acc, onDelta) {
  switch (json?.type) {
    case "message_start":
      if (json.message?.usage) acc.usage = { ...json.message.usage };
      if (json.message?.stop_reason) acc.finishReason = mapStopReason(json.message.stop_reason);
      break;
    case "content_block_start": {
      const block = json.content_block || {};
      const index = Number.isInteger(json.index) ? json.index : acc.calls.length;
      if (block.type === "tool_use") {
        acc.calls.push({
          index,
          id: block.id || "",
          name: block.name || "",
          argsText: block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : ""
        });
      } else if (block.type === "text" && block.text) {
        acc.text += block.text;
        if (onDelta) onDelta(block.text);
      }
      break;
    }
    case "content_block_delta": {
      const delta = json.delta || {};
      if (delta.type === "text_delta" && delta.text) {
        acc.text += delta.text;
        if (onDelta) onDelta(delta.text);
      } else if (delta.type === "input_json_delta") {
        const entry = acc.calls.find((c) => c.index === json.index);
        if (entry) entry.argsText += delta.partial_json || "";
      }
      break;
    }
    case "message_delta":
      if (json.delta?.stop_reason) acc.finishReason = mapStopReason(json.delta.stop_reason);
      if (json.usage) acc.usage = { ...acc.usage || {}, ...json.usage };
      break;
    case "error":
      throw new Error(json.error?.message || "The provider returned an error.");
    default:
      break;
  }
}
function finishAnthropic(acc) {
  return {
    text: acc.text.trim(),
    calls: normalizeToolCalls(
      acc.calls.sort((a, b) => a.index - b.index).map((c) => ({ id: c.id, function: { name: c.name, arguments: c.argsText } }))
    ),
    finishReason: acc.finishReason || "",
    usage: acc.usage || null
  };
}
function readAnthropicJson(json, acc, onDelta) {
  if (json?.type === "error" || json?.error) {
    throw new Error(json.error?.message || "The provider returned an error.");
  }
  for (const [index, block] of (json?.content || []).entries()) {
    if (block.type === "text" && block.text) {
      acc.text += block.text;
      if (onDelta) onDelta(block.text);
    } else if (block.type === "tool_use") {
      acc.calls.push({
        index,
        id: block.id || "",
        name: block.name || "",
        argsText: JSON.stringify(block.input || {})
      });
    }
  }
  acc.finishReason = mapStopReason(json?.stop_reason);
  if (json?.usage) acc.usage = json.usage;
}
// Strict chat templates (Gemma, Mistral, some Llama GGUFs under llama.cpp
// --jinja) reject a second system message or two user turns in a row. The agent
// produces both: a context note after the system prompt, JSON-mode tool results
// sent as user turns, and a screenshot turn. Merge them; servers that accept
// the original shape read the merged one the same way.
function partsOf(content) {
  if (Array.isArray(content)) return content;
  return [{ type: "text", text: String(content ?? "") }];
}
function normalizeMessages(messages) {
  const out = [];
  const systems = [];
  for (const message of messages || []) {
    if (!message || !message.role) continue;
    if (message.role === "system") {
      const text = contentText(message.content);
      if (text) systems.push(text);
      continue;
    }
    const last = out[out.length - 1];
    if (message.role === "user" && last && last.role === "user") {
      if (typeof last.content === "string" && typeof message.content === "string") {
        last.content = last.content + "\n\n" + message.content;
      } else {
        last.content = [...partsOf(last.content), ...partsOf(message.content)];
      }
      continue;
    }
    out.push({ ...message });
  }
  if (systems.length) out.unshift({ role: "system", content: systems.join("\n\n") });
  return out;
}
// Some local models print their reasoning inline. It must not reach the
// history (it eats the window) or the JSON tool parser.
function stripThinking(text) {
  return String(text || "")
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, (m) => (/<think>/i.test(m) ? m : ""))
    .replace(/<(think|thinking|reasoning)>[\s\S]*$/i, "")
    .trim();
}
// Ollama's native /api/chat is the only Ollama endpoint that honours num_ctx.
// The OpenAI-compatible /v1 route silently runs every model at the server
// default window, which truncates FoxAgent's prompt from the front.
function toOllamaMessages(messages) {
  const names = new Map();
  const out = [];
  for (const message of normalizeMessages(messages)) {
    if (message.role === "assistant") {
      const entry = { role: "assistant", content: contentText(message.content) };
      if (message.tool_calls?.length) {
        entry.tool_calls = message.tool_calls.map((call) => {
          const fn = call.function || call;
          if (call.id) names.set(call.id, fn.name);
          return { function: { name: fn.name, arguments: parseArgs(fn.arguments) } };
        });
      }
      out.push(entry);
    } else if (message.role === "tool") {
      const entry = { role: "tool", content: String(message.content ?? "(no output)") };
      const name = names.get(message.tool_call_id);
      if (name) entry.tool_name = name;
      out.push(entry);
    } else {
      const entry = { role: message.role, content: contentText(message.content) };
      if (Array.isArray(message.content)) {
        const images = [];
        for (const part of message.content) {
          if (part?.type !== "image_url") continue;
          const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
          const match = String(url || "").match(/^data:[^;]+;base64,([\s\S]+)$/);
          if (match) images.push(match[1]);
        }
        if (images.length) entry.images = images;
      }
      out.push(entry);
    }
  }
  return out;
}
function readOllama(json, acc, onDelta) {
  if (json?.error) throw new Error(String(json.error));
  const message = json?.message || {};
  if (typeof message.content === "string" && message.content) {
    acc.text += message.content;
    if (onDelta) onDelta(message.content);
  }
  for (const call of message.tool_calls || []) {
    const fn = call.function || {};
    acc.calls.push({
      index: acc.calls.length,
      id: call.id || "",
      name: fn.name || "",
      argsText: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {})
    });
  }
  if (json?.done) {
    acc.finishReason = json.done_reason === "length" ? "length" : acc.calls.length ? "tool_calls" : "stop";
    acc.usage = { prompt_tokens: json.prompt_eval_count || 0, completion_tokens: json.eval_count || 0 };
  }
}
async function readNdjson(res, acc, opts, onChunk) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = (line) => {
    const t = line.trim();
    if (!t) return;
    let json;
    try {
      json = JSON.parse(t);
    } catch {
      return;
    }
    readOllama(json, acc, opts.onDelta);
  };
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    onChunk();
    buffer += decoder.decode(chunk.value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      handle(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  }
  handle(buffer);
  return opts.finalize(acc, null);
}
const ollamaNativeOff = new Set();
async function streamRequest(opts) {
  const provider = opts.provider;
  const controller = new AbortController();
  let timedOut = "";
  // A local server may spend minutes loading weights and processing a long
  // prompt before the first token, then stream steadily. Time the wait for
  // the first byte and the gaps between chunks, not the whole reply.
  const local = !provider.cloud;
  const firstMs = opts.timeoutMs || (local ? 6e5 : 18e4);
  const idleMs = opts.idleMs || (local ? 18e4 : 9e4);
  let timer = null;
  const arm = (ms, why) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = why;
      controller.abort();
    }, ms);
  };
  arm(firstMs, "first");
  const onAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  const acc = { text: "", calls: [], finishReason: "", usage: null };
  try {
    const res = await fetch(join(provider.baseUrl, opts.path), {
      method: "POST",
      headers: headers(provider, { json: true }),
      body: JSON.stringify(opts.payload),
      signal: controller.signal
    });
    if (!res.ok) {
      throw httpError(provider, res, await res.text().catch(() => ""));
    }
    const contentType = res.headers.get("content-type") || "";
    if (opts.kind === "ollama") {
      return await readNdjson(res, acc, opts, () => arm(idleMs, "idle"));
    }
    if (!res.body || /application\/json/i.test(contentType)) {
      const json = await res.json();
      if (opts.kind === "anthropic") readAnthropicJson(json, acc, opts.onDelta);
      else readOpenAi(json, acc, opts.onDelta);
      return opts.finalize(acc, json);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      arm(idleMs, "idle");
      buffer += decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of block.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") {
            done = true;
            continue;
          }
          try {
            const json = JSON.parse(data);
            if (opts.kind === "anthropic") readAnthropic(json, acc, opts.onDelta);
            else readOpenAi(json, acc, opts.onDelta);
          } catch (err) {
            if (!(err instanceof SyntaxError)) throw err;
          }
        }
      }
    }
    return opts.finalize(acc, null);
  } catch (err) {
    if (timedOut === "first") {
      throw new Error(`${labelOf(provider)} sent nothing for ${Math.round(firstMs / 1e3)}s. ` + (local ? "The model may still be loading or the prompt is very long for this machine. Try a smaller model or a smaller context." : "Try again, or pick a faster model."));
    }
    if (timedOut === "idle") {
      throw new Error(`${labelOf(provider)} stopped streaming for ${Math.round(idleMs / 1e3)}s mid-reply. The server may have run out of memory or crashed.`);
    }
    throw friendlyNetworkError(err, provider);
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  }
}
async function streamChat(opts) {
  const provider = opts.provider || activeProvider();
  const model = opts.model || activeModel();
  const kind = providerKind(provider);
  if (!model) throw new Error("No model selected. Open Models and pick one (or run Detect models).");
  if (!provider.baseUrl) throw new Error("No server URL configured. Open Models and set the base URL.");
  if (provider.cloud && !provider.apiKey) {
    throw new Error(`No API key saved for ${labelOf(provider)}. Open Models and save your key.`);
  }
  if (kind === "anthropic") {
    const converted = toAnthropicMessages(opts.messages);
    const payload2 = {
      model,
      max_tokens: Math.max(256, Math.min(32e3, Number(opts.maxTokens) || 8192)),
      messages: converted.messages,
      temperature: Math.min(1, Math.max(0, Number.isFinite(opts.temperature) ? opts.temperature : 0.2)),
      stream: true
    };
    if (converted.system) payload2.system = converted.system;
    if (opts.tools?.length) {
      payload2.tools = anthropicTools(opts.tools);
      payload2.tool_choice = { type: "auto" };
    }
    return streamRequest({
      provider,
      kind,
      path: "/messages",
      payload: payload2,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      onDelta: opts.onDelta,
      finalize: finishAnthropic
    });
  }
  const nativeKey = `${provider.baseUrl}|${model}`;
  if (kind === "openai" && provider.key === "ollama" && !ollamaNativeOff.has(nativeKey)) {
    const payload3 = {
      model,
      messages: toOllamaMessages(opts.messages),
      stream: true,
      keep_alive: opts.keepAlive || "30m",
      options: {
        temperature: Number.isFinite(opts.temperature) ? opts.temperature : 0.2
      }
    };
    if (opts.numCtx) payload3.options.num_ctx = Math.floor(opts.numCtx);
    if (Number(opts.maxTokens)) payload3.options.num_predict = Math.floor(Number(opts.maxTokens));
    if (opts.tools?.length) payload3.tools = opts.tools;
    try {
      return await streamRequest({
        provider: { ...provider, baseUrl: serverRoot(provider.baseUrl) },
        kind: "ollama",
        path: "/api/chat",
        payload: payload3,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        idleMs: opts.idleMs,
        onDelta: opts.onDelta,
        finalize: finishOpenAi
      });
    } catch (err) {
      // A proxy in front of Ollama may only expose /v1. Fall back once and
      // remember, so the user still gets answers (at the server's window).
      // Ollama itself answers 404 for an unknown model; that is not a proxy.
      if (err?.status !== 404 && err?.status !== 405) throw err;
      if (/model\b.*\bnot found|pull/i.test(err.body || "")) throw err;
      ollamaNativeOff.add(nativeKey);
    }
  }
  const payload = {
    model,
    messages: normalizeMessages(opts.messages),
    temperature: Number.isFinite(opts.temperature) ? opts.temperature : 0.2,
    stream: true
  };
  const cap = Number(opts.maxTokens) || 0;
  if (cap) {
    if (/(^|\/)o[134]/i.test(model)) payload.max_completion_tokens = cap;
    else payload.max_tokens = cap;
  }
  if (opts.tools?.length) {
    payload.tools = opts.tools;
    payload.tool_choice = "auto";
  }
  // Ask for token counts in the stream where the server is known to accept
  // the field; others may reject unknown keys.
  if (["openai", "lmstudio", "vllm", "llamacpp"].includes(provider.key)) payload.stream_options = { include_usage: true };
  return streamRequest({
    provider,
    kind,
    path: "/chat/completions",
    payload,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    idleMs: opts.idleMs,
    onDelta: opts.onDelta,
    finalize: finishOpenAi
  });
}
function firstSentence(text, max) {
  const t = String(text || "").trim();
  const m = t.match(/^[\s\S]*?[.!?](?=\s|$)/);
  const s = (m ? m[0] : t).trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}
function compactSchema(node) {
  if (Array.isArray(node)) return node.map(compactSchema);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "description" && typeof value === "string") out[key] = firstSentence(value, 80);
    else if (key === "examples") continue;
    else out[key] = compactSchema(value);
  }
  return out;
}
// compact: first-sentence descriptions, for windows where the full tool menu
// would crowd out the conversation. Names, types and required fields stay.
function toolSchemas(specs, { compact = false } = {}) {
  return specs.map((spec) => ({
    type: "function",
    function: {
      name: spec.name,
      description: compact ? firstSentence(spec.description, 140) : spec.description,
      parameters: compact ? compactSchema(spec.parameters || { type: "object", properties: {} }) : spec.parameters || { type: "object", properties: {} }
    }
  }));
}
export {
  listModels,
  normalizeMessages,
  providerKind,
  stripThinking,
  streamChat,
  toAnthropicMessages,
  toOllamaMessages,
  toolSchemas
};
