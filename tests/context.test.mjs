import test from "node:test";
import assert from "node:assert/strict";
import { planBudget } from "../src/background/budget.js";
import { readOllamaShow, readLmStudio, readLlamaCpp, readOpenAiModels, ollamaNumCtx, parseParams, serverRoot } from "../src/background/modelinfo.js";
import { normalizeMessages, toOllamaMessages, stripThinking, streamChat } from "../src/background/providers.js";
import { fitHistory, toProviderMessages } from "../src/background/agent.js";
import { buildSystemPrompt } from "../src/background/prompt.js";
import { DEFAULT_SETTINGS } from "../src/background/store.js";
import { cleanSettingsPatch } from "../src/background/settings-guard.js";

const settings = structuredClone(DEFAULT_SETTINGS);

function ndjsonResponse(lines, status = 200) {
  const enc = new TextEncoder();
  const chunks = lines.map((l) => enc.encode(JSON.stringify(l) + "\n"));
  return {
    ok: status < 400,
    status,
    statusText: status < 400 ? "OK" : "Error",
    headers: { get: () => "application/x-ndjson" },
    body: { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) },
    text: async () => ""
  };
}
function errorResponse(status, body) {
  return { ok: false, status, statusText: "Error", headers: { get: () => "application/json" }, text: async () => body };
}

test("unknown window keeps the character budget exactly as before", () => {
  const plan = planBudget({ settings, systemChars: 5e3, schemaChars: 13e3 });
  assert.equal(plan.windowTokens, null);
  assert.equal(plan.maxTokens, 8192);
  assert.equal(plan.historyChars, 96e3 - 5e3);
  assert.equal(plan.toolClip, 26e3);
});

test("a 4k local window counts schemas, shrinks the reply and flags overflow", () => {
  const plan = planBudget({ windowTokens: 4096, settings, small: true, systemChars: 2259, schemaChars: 12431 });
  assert.equal(plan.maxTokens, 1024);
  assert.ok(plan.overflow, "4k cannot hold the small prompt plus full tool schemas");
  assert.ok(plan.historyChars <= 1500);
  assert.ok(plan.toolClip <= 1500);
});

test("a 32k window leaves the configured reply and a bounded history", () => {
  const plan = planBudget({ windowTokens: 32768, settings, systemChars: 5e3, schemaChars: 13e3 });
  assert.equal(plan.maxTokens, 8192);
  const expected = Math.floor((32768 - 8192 - 96) * 3.2) - 18e3;
  assert.equal(plan.historyChars, expected);
  assert.ok(!plan.overflow);
  const withImage = planBudget({ windowTokens: 32768, settings, systemChars: 5e3, schemaChars: 13e3, image: true });
  assert.ok(withImage.historyChars < plan.historyChars);
});

test("Ollama show/ps answers become model facts", () => {
  const show = {
    model_info: { "qwen3.context_length": 40960, "general.architecture": "qwen3" },
    parameters: "temperature 0.6\nnum_ctx 8192",
    capabilities: ["completion", "tools", "thinking"],
    details: { parameter_size: "8.2B" }
  };
  const info = readOllamaShow(show, { models: [] }, "qwen3:8b");
  assert.equal(info.trainedWindow, 40960);
  assert.equal(info.contextWindow, 8192);
  assert.equal(info.tools, true);
  assert.equal(info.vision, false);
  assert.equal(info.paramsB, 8.2);
  const loaded = readOllamaShow(show, { models: [{ name: "qwen3:8b", context_length: 16384 }] }, "qwen3:8b");
  assert.equal(loaded.contextWindow, 16384);
  assert.equal(ollamaNumCtx(info, { localContextTokens: 65536 }), 40960, "never above the trained window");
  assert.equal(ollamaNumCtx(info, { localContextTokens: 1000 }), 2048, "never below 2048");
  assert.equal(parseParams("567M"), 0.57);
});

test("LM Studio, llama.cpp and vLLM report their windows", () => {
  const notLoaded = readLmStudio({ id: "m", type: "vlm", state: "not-loaded", max_context_length: 131072, capabilities: ["tool_use"] });
  assert.equal(notLoaded.contextWindow, 4096);
  assert.equal(notLoaded.guessed, true);
  assert.equal(notLoaded.vision, true);
  assert.equal(notLoaded.tools, true);
  const loaded = readLmStudio({ id: "m", type: "llm", state: "loaded", max_context_length: 131072, loaded_context_length: 32768 });
  assert.equal(loaded.contextWindow, 32768);
  assert.equal(loaded.guessed, false);
  assert.equal(readLlamaCpp({ default_generation_settings: { n_ctx: 8192 } }).contextWindow, 8192);
  assert.equal(readOpenAiModels({ data: [{ id: "q", max_model_len: 32768 }] }, "q").contextWindow, 32768);
  assert.equal(serverRoot("http://localhost:11434/v1/"), "http://localhost:11434");
});

test("strict templates get one system message and alternating turns", () => {
  const out = normalizeMessages([
    { role: "system", content: "A" },
    { role: "system", content: "B" },
    { role: "user", content: "task" },
    { role: "assistant", content: "```json {}```" },
    { role: "user", content: "TOOL RESULT (x): 1" },
    { role: "user", content: "TOOL RESULT (y): 2" },
    { role: "user", content: [{ type: "text", text: "shot" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] }
  ]);
  assert.deepEqual(out.map((m) => m.role), ["system", "user", "assistant", "user"]);
  assert.equal(out[0].content, "A\n\nB");
  assert.ok(Array.isArray(out[3].content));
  assert.equal(out[3].content.filter((p) => p.type === "image_url").length, 1);
});

test("Ollama native messages carry object arguments, tool names and images", () => {
  const out = toOllamaMessages([
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "page.read", arguments: "{\"maxChars\":100}" } }] },
    { role: "tool", tool_call_id: "c1", content: "text" },
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] }
  ]);
  assert.deepEqual(out[2].tool_calls[0].function.arguments, { maxChars: 100 });
  assert.equal(out[3].tool_name, "page.read");
  assert.deepEqual(out[4].images, ["QUJD"]);
});

test("inline reasoning is removed before history and tool parsing", () => {
  assert.equal(stripThinking("<think>plan {\"tool\":\"x\"}</think>Answer"), "Answer");
  assert.equal(stripThinking("half a thought</think>\nAnswer"), "Answer");
  assert.equal(stripThinking("Answer <think>never closed"), "Answer");
  assert.equal(stripThinking("Plain answer"), "Plain answer");
});

test("Ollama goes through /api/chat with num_ctx and keep_alive, and parses tool calls", async () => {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), body: JSON.parse(opts.body) });
    return ndjsonResponse([
      { message: { role: "assistant", content: "Reading." }, done: false },
      { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "page.read", arguments: { maxChars: 500 } } }] }, done: false },
      { message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 900, eval_count: 20 }
    ]);
  };
  try {
    const res = await streamChat({
      provider: { key: "ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "", model: "qwen3:8b" },
      model: "qwen3:8b",
      messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "page.read", parameters: { type: "object", properties: {} } } }],
      maxTokens: 1024,
      numCtx: 16384
    });
    assert.equal(seen[0].url, "http://127.0.0.1:11434/api/chat");
    assert.equal(seen[0].body.options.num_ctx, 16384);
    assert.equal(seen[0].body.options.num_predict, 1024);
    assert.equal(seen[0].body.keep_alive, "30m");
    assert.equal(res.text, "Reading.");
    assert.equal(res.calls[0].name, "page.read");
    assert.deepEqual(res.calls[0].args, { maxChars: 500 });
    assert.equal(res.usage.prompt_tokens, 900);
  } finally {
    globalThis.fetch = real;
  }
});

test("a proxy without /api/chat falls back to /v1; an unknown model does not", async () => {
  const real = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).endsWith("/api/chat")) return errorResponse(404, "404 page not found");
    return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }) };
  };
  try {
    const provider = { key: "ollama", baseUrl: "http://proxy.local:9/v1", apiKey: "", model: "m" };
    const res = await streamChat({ provider, model: "m", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.text, "ok");
    assert.deepEqual(urls, ["http://proxy.local:9/api/chat", "http://proxy.local:9/v1/chat/completions"]);
    globalThis.fetch = async () => errorResponse(404, "{\"error\":\"model 'nope' not found, try pulling it first\"}");
    await assert.rejects(streamChat({ provider: { ...provider, baseUrl: "http://127.0.0.1:11434/v1" }, model: "nope", messages: [{ role: "user", content: "hi" }] }), /not found/);
  } finally {
    globalThis.fetch = real;
  }
});

test("server errors are classified for tool fallback and context retry", async () => {
  const real = globalThis.fetch;
  const provider = { key: "vllm", baseUrl: "http://127.0.0.1:8000/v1", apiKey: "", model: "m" };
  try {
    globalThis.fetch = async () => errorResponse(400, "\"auto\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set");
    const tools = await streamChat({ provider, model: "m", messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    assert.equal(tools.toolsUnsupported, true);
    assert.equal(tools.contextOverflow, false);
    globalThis.fetch = async () => errorResponse(400, "This model's maximum context length is 8192 tokens. However, you requested 20000 tokens.");
    const overflow = await streamChat({ provider, model: "m", messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    assert.equal(overflow.contextOverflow, true);
    assert.equal(overflow.toolsUnsupported, false);
    assert.equal(overflow.contextLimit, 8192);
  } finally {
    globalThis.fetch = real;
  }
});

test("a long single task drops early steps in pairs and keeps the newest", () => {
  const history = [{ role: "user", text: "do the long thing" }];
  for (let i = 0; i < 20; i++) {
    history.push({ role: "assistant", text: "", calls: [{ id: "c" + i, name: "page.read", args: {} }], protocol: "native" });
    history.push({ role: "tool", callId: "c" + i, name: "page.read", text: "x".repeat(3000), protocol: "native" });
  }
  const fitted = fitHistory(history, 6000);
  assert.ok(fitted.trimmed);
  assert.ok(fitted.droppedSteps > 0);
  assert.equal(fitted.history[0].role, "user");
  assert.equal(fitted.history.at(-1).callId, "c19");
  const ids = new Set(fitted.history.filter((e) => e.role === "assistant").flatMap((e) => e.calls.map((c) => c.id)));
  for (const e of fitted.history.filter((e) => e.role === "tool")) assert.ok(ids.has(e.callId), "every result keeps its call");
  const size = fitted.history.reduce((n, e) => n + (e.text || "").length, 0);
  assert.ok(size < 9000);
});

test("scratchpad rides at the end; the system prompt stays stable", () => {
  const session = { notes: ["step 1 done"], history: [{ role: "user", text: "go" }], lastImage: null };
  const tab = { id: 1, title: "t", url: "https://example.com" };
  const system = buildSystemPrompt(session, settings, tab, { tools: [], small: false, packs: [] });
  assert.ok(!system.includes("step 1 done"));
  assert.ok(!/\d{1,2}:\d{2}/.test(system), "no clock time in the prompt prefix");
  const messages = toProviderMessages(session, settings, tab, [], false, [], false, { system, historyChars: 10000 });
  assert.equal(messages[0].content, system);
  assert.match(messages.at(-1).content, /step 1 done/);
});

test("after a JSON fallback, native history is replayed as text", () => {
  const session = {
    notes: [],
    history: [
      { role: "user", text: "go" },
      { role: "assistant", text: "", calls: [{ id: "c1", name: "page.read", args: { maxChars: 10 } }], protocol: "native" },
      { role: "tool", callId: "c1", name: "page.read", text: "hello", protocol: "native" }
    ]
  };
  const messages = toProviderMessages(session, settings, null, [], false, [], false, { system: "s", historyChars: 10000, native: false });
  assert.ok(!messages.some((m) => m.role === "tool" || m.tool_calls));
  assert.match(messages[2].content, /"tool":"page.read"/);
  assert.match(messages[3].content, /TOOL RESULT \(page.read\)/);
});

test("local context setting is clamped", () => {
  assert.equal(cleanSettingsPatch({ localContextTokens: 500 }).localContextTokens, 2048);
  assert.equal(cleanSettingsPatch({ localContextTokens: 1e7 }).localContextTokens, 262144);
  assert.equal(cleanSettingsPatch({ localContextTokens: 32768 }).localContextTokens, 32768);
});

test("usage arrives from the final stream chunk, and only where the field is safe", async () => {
  const real = globalThis.fetch;
  const bodies = [];
  const enc = new TextEncoder();
  globalThis.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    const events = [
      { choices: [{ delta: { content: "hi" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 1234, completion_tokens: 5 } }
    ];
    const chunks = [...events.map((e) => enc.encode("data: " + JSON.stringify(e) + "\n\n")), enc.encode("data: [DONE]\n\n")];
    return { ok: true, status: 200, headers: { get: () => "text/event-stream" }, body: { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) } };
  };
  try {
    const res = await streamChat({ provider: { key: "lmstudio", baseUrl: "http://127.0.0.1:1/v1" }, model: "m", messages: [{ role: "user", content: "x" }] });
    assert.equal(res.usage.prompt_tokens, 1234);
    assert.deepEqual(bodies[0].stream_options, { include_usage: true });
    await streamChat({ provider: { key: "mistral", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", cloud: true }, model: "m", messages: [{ role: "user", content: "x" }] });
    assert.equal(bodies[1].stream_options, undefined);
  } finally {
    globalThis.fetch = real;
  }
});

test("model description for the Models panel follows run rules", async () => {
  const { describeModel } = await import("../src/background/agent.js");
  const cloud = await describeModel({ key: "openai", cloud: true, baseUrl: "https://api.openai.com/v1" }, "gpt-4o", { ...settings });
  assert.equal(cloud.window, null);
  assert.equal(cloud.cloud, true);
  assert.equal(cloud.vision, true);
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).endsWith("/api/show")
      ? { model_info: { "gemma3.context_length": 131072 }, capabilities: ["completion", "vision"], details: { parameter_size: "4.3B" } }
      : { models: [] })
  });
  try {
    const local = await describeModel({ key: "ollama", baseUrl: "http://127.0.0.1:11434/v1" }, "gemma3:4b", { ...settings, localContextTokens: 8192 }, { refresh: true });
    assert.equal(local.window, 8192);
    assert.equal(local.tools, false);
    assert.equal(local.vision, true);
    assert.equal(local.small, true);
  } finally {
    globalThis.fetch = real;
  }
});

test("vision guess skips text-only members of multimodal families", async () => {
  const { supportsVision } = await import("../src/background/vision.js");
  assert.equal(supportsVision("llama3.2:3b"), false);
  assert.equal(supportsVision("llama3.2-vision:11b"), true);
  assert.equal(supportsVision("gemma3:1b"), false);
  assert.equal(supportsVision("gemma3:12b"), true);
  assert.equal(supportsVision("google/gemma-3-270m"), false);
});
