import { activeProvider, activeModel, PROVIDERS } from "./store.js";
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
  return new Error(`${labelOf(provider)} returned ${res.status} ${res.statusText}.${hint}
${clean}`.trim());
}
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
async function streamRequest(opts) {
  const provider = opts.provider;
  const controller = new AbortController();
  let timedOut = false;
  const limitMs = opts.timeoutMs || 18e4;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limitMs);
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
    if (timedOut) throw new Error(`The model did not finish within ${Math.round(limitMs / 1e3)}s. Try a smaller model or shorter task.`);
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
      max_tokens: Math.max(256, Math.min(32e3, Number(opts.maxTokens) || 4096)),
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
  const payload = {
    model,
    messages: opts.messages,
    temperature: Number.isFinite(opts.temperature) ? opts.temperature : 0.2,
    stream: true
  };
  if (opts.tools?.length) {
    payload.tools = opts.tools;
    payload.tool_choice = "auto";
  }
  return streamRequest({
    provider,
    kind,
    path: "/chat/completions",
    payload,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    onDelta: opts.onDelta,
    finalize: finishOpenAi
  });
}
function toolSchemas(specs) {
  return specs.map((spec) => ({
    type: "function",
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters || { type: "object", properties: {} }
    }
  }));
}
export {
  listModels,
  providerKind,
  streamChat,
  toAnthropicMessages,
  toolSchemas
};
