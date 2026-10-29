import test from "node:test";
import assert from "node:assert/strict";
import { modelSize, isSmallModel, parseTextCalls, executeCall } from "../src/background/agent.js";
import { toolsFor, suggestTools, TOOLS } from "../src/background/tools.js";
import { hostMatches } from "../packs/sdk.js";
import { project } from "../src/background/rows.js";
import { tools as canvasTools } from "../packs/canvas/tools.js";
import { isNewer } from "../src/background/updates.js";
import { supportsVision } from "../src/background/vision.js";
import { toAnthropicMessages, streamChat } from "../src/background/providers.js";
import fs from "node:fs";
import { PACK_MODULES } from "../packs/registry.js";
import { addNote, addTranscript, summarize } from "../src/background/sessions.js";
import { cleanSettingsPatch } from "../src/background/settings-guard.js";
test("model size reads common local ids", () => {
  assert.equal(modelSize("qwen3.5-4b"), 4);
  assert.equal(modelSize("qwen3.5-9b"), 9);
  assert.equal(modelSize("gemma-4-e2b"), 2);
  assert.equal(modelSize("gemma-4-e4b"), 4);
  assert.equal(modelSize("llama-3.1:70b"), 70);
  assert.equal(modelSize("gpt-4o-mini"), 0);
});
test("small profile only for <=12b ids", () => {
  assert.equal(isSmallModel("qwen3.5-4b"), true);
  assert.equal(isSmallModel("gemma-4-e2b"), true);
  assert.equal(isSmallModel("qwen3.5-32b"), false);
  assert.equal(isSmallModel("claude-sonnet"), false);
});
test("small models get a shorter tool menu", () => {
  const full = toolsFor({});
  const small = toolsFor({ small: true });
  assert.ok(small.length < full.length);
  assert.ok(!small.some((t) => t.name === "page.links"));
  assert.ok(small.some((t) => t.name === "page.clickText"));
  assert.ok(small.some((t) => t.name === "page.fill"));
  assert.ok(small.some((t) => t.name === "page.wait"));
});
test("screenshot is only offered to vision models", () => {
  assert.ok(!toolsFor({ vision: false }).some((t) => t.name === "page.screenshot"));
  assert.ok(toolsFor({ vision: true }).some((t) => t.name === "page.screenshot"));
});
test("canvas tools live in the pack, not the core registry", () => {
  assert.ok(!toolsFor({}).some((t) => t.name.startsWith("canvas.")));
  assert.deepEqual(canvasTools.map((t) => t.name), [
    "canvas.todo",
    "canvas.courses",
    "canvas.assignments",
    "canvas.modules",
    "canvas.digest"
  ]);
  assert.ok(canvasTools.every((t) => t.risk === "read"));
});
test("canvas.digest merges courses and upcoming assignments in one call", async () => {
  const courses = [
    { id: 1, name: "Biology", computed_current_score: 91, computed_current_grade: "A-" },
    { id: 2, name: "History", computed_current_score: 84, computed_current_grade: "B" },
  ];
  const assignments = {
    1: [
      { id: 11, name: "Lab", due_at: "2026-11-02T10:00:00Z", points_possible: 10 },
      { id: 12, name: "Essay", due_at: "2026-11-01T10:00:00Z", points_possible: 20 },
    ],
    2: [{ id: 21, name: "Reading", due_at: "2026-11-03T10:00:00Z", points_possible: 5 }],
  };
  globalThis.browser = {
    tabs: {
      get: async (id) => ({ id, url: "https://canvas.instructure.com/", title: "Canvas" }),
      sendMessage: async (id, msg) => {
        if (msg.op === "ping") return { ok: true };
        const url = msg.args.url;
        const json = url.includes("/assignments")
          ? assignments[Number(url.match(/courses\/(\d+)/)[1])]
          : courses;
        return { ok: true, result: { url, status: 200, ok: true, contentType: "application/json", link: "", rate: {}, json, text: "", chars: 0 } };
      },
    },
  };
  try {
    const digest = canvasTools.find((t) => t.name === "canvas.digest");
    const out = await digest.run({}, { session: { tabId: 1 }, settings: {} });
    assert.match(out, /Biology: 91/);
    assert.match(out, /History: 84/);
    assert.match(out, /UPCOMING \(3\)/);
    assert.ok(out.indexOf("Essay") < out.indexOf("Lab"));
  } finally {
    delete globalThis.browser;
  }
});

test("pack host patterns match subdomains and wildcards", () => {
  assert.equal(hostMatches("canvas.instructure.com", ["*.instructure.com"]), true);
  assert.equal(hostMatches("canvas.my-university.edu", ["canvas.*"]), true);
  assert.equal(hostMatches("example.com", ["*.instructure.com"]), false);
  assert.equal(hostMatches("mail.google.com", []), true);
});
test("every catalog pack has the four required files", () => {
  const dir = new URL("../packs/", import.meta.url);
  const index = JSON.parse(fs.readFileSync(new URL("index.json", dir), "utf8"));
  assert.ok(index.packs.length >= 4);
  assert.deepEqual(Object.keys(PACK_MODULES).sort(), [...index.packs].sort());
  for (const id of index.packs) {
    for (const file of ["pack.json", "tools.js", "desc.md", "icon.svg"]) {
      assert.ok(fs.existsSync(new URL(`${id}/${file}`, dir)), `${id}/${file} is missing`);
    }
    const meta = JSON.parse(fs.readFileSync(new URL(`${id}/pack.json`, dir), "utf8"));
    assert.equal(meta.id, id);
  }
});
test("vision detection covers common families and respects the setting", () => {
  assert.equal(supportsVision("qwen/qwen3-vl-4b"), true);
  assert.equal(supportsVision("google/gemma-4-e2b"), true);
  assert.equal(supportsVision("gpt-4o"), true);
  assert.equal(supportsVision("qwen3.5-9b-coder"), false);
  assert.equal(supportsVision("qwen3.5-9b", "on"), true);
  assert.equal(supportsVision("gpt-4o", "off"), false);
});
test("screenshots become Anthropic image blocks", () => {
  const converted = toAnthropicMessages([
    { role: "system", content: "sys" },
    {
      role: "user",
      content: [
        { type: "text", text: "Look at this" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } }
      ]
    }
  ]);
  assert.equal(converted.messages.length, 1);
  assert.equal(converted.messages[0].content[0].type, "text");
  assert.equal(converted.messages[0].content[1].type, "image");
  assert.equal(converted.messages[0].content[1].source.media_type, "image/jpeg");
  assert.equal(converted.messages[0].content[1].source.data, "QUJD");
});
test("version comparison notices newer releases only", () => {
  assert.equal(isNewer("0.3.1", "0.3.0"), true);
  assert.equal(isNewer("0.4", "0.3.9"), true);
  assert.equal(isNewer("v0.3.0", "0.3.0"), false);
  assert.equal(isNewer("0.2.9", "0.3.0"), false);
});
test("unknown tool names get close suggestions", () => {
  assert.ok(suggestTools("page.clik").includes("page.click"));
});
test("JSON fallback parses a single call and keeps prose", () => {
  const parsed = parseTextCalls('Looking now.\n```json\n{"tool":"page.read","args":{"maxChars":1000}}\n```');
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].name, "page.read");
  assert.equal(parsed.calls[0].args.maxChars, 1e3);
  assert.equal(parsed.text, "Looking now.");
});
test("JSON fallback parses several tools", () => {
  const parsed = parseTextCalls('{"tools":[{"tool":"page.read","args":{}},{"tool":"page.snapshot","args":{}}]}');
  assert.deepEqual(parsed.calls.map((c) => c.name), ["page.read", "page.snapshot"]);
});
test("project keeps requested dot paths for page.fetch", () => {
  const rows = [{ id: 1, assignment: { name: "Essay", due_at: "2026-01-01" }, extra: true }];
  assert.deepEqual(project(rows, ["id", "assignment.name"]), [{ id: 1, name: "Essay" }]);
});

test("web.fetch refuses non-http and local addresses before any request", async () => {
  const tool = TOOLS.find((t) => t.name === "web.fetch");
  await assert.rejects(() => tool.run({ url: "ftp://example.com/x" }), /must start with/);
  await assert.rejects(() => tool.run({ url: "http://localhost/x" }), /refuses local/);
  await assert.rejects(() => tool.run({ url: "http://169.254.169.254/latest" }), /refuses local/);
  await assert.rejects(() => tool.run({ url: "http://[fd00::1]/" }), /refuses local/);
});

test("scratchpad and transcript stay bounded", () => {
  const session = { tabId: 1, transcript: [], notes: [], lastAt: 0, pending: new Map(), busy: false, status: "idle" };
  for (let i = 0; i < 20; i++) addNote(session, "x".repeat(600));
  assert.ok(session.notes.join("\n").length <= 6e3 + 600);
  for (let i = 0; i < 300; i++) addTranscript(session, { type: "user", text: "hi" });
  assert.equal(session.transcript.length, 240);
  assert.equal(summarize(session).messages, 240);
});
test("tools from the step menu execute, including pack tools", async () => {
  const calls = [];
  const packTool = {
    name: "pack.ping",
    risk: "read",
    needsPage: false,
    async run() {
      calls.push("pack");
      return "pong";
    },
  };
  const result = await executeCall(
    { id: "c1", name: "pack.ping", args: {} },
    {
      session: { tabId: 1, notes: [], pending: new Map(), history: [], transcript: [] },
      settings: { approval: { read: "auto", act: "confirm", write: "confirm" }, trustedSites: [], siteAllowlist: [], dryRun: false },
      emit() {},
      approve: async () => true,
      ask: async () => "",
      signal: { aborted: false },
      tools: [packTool],
      small: false,
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.text, "pong");
  assert.deepEqual(calls, ["pack"]);
});

test("max reply tokens reach both provider payloads", async () => {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    const anthropic = String(url).includes("/messages");
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => anthropic
        ? { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }
        : { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
    };
  };
  try {
    await streamChat({
      provider: { key: "lmstudio", baseUrl: "http://127.0.0.1:1/v1", apiKey: "", model: "m" },
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 1234,
    });
    await streamChat({
      provider: { key: "anthropic", kind: "anthropic", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "claude" },
      model: "claude",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 1234,
    });
    await streamChat({
      provider: { key: "openrouter", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", cloud: true, model: "openai/o3-mini" },
      model: "openai/o3-mini",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 1234,
    });
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(calls[0].body.max_tokens, 1234);
  assert.equal(calls[1].body.max_tokens, 1234);
  assert.equal(calls[2].body.max_completion_tokens, 1234);
  assert.equal(calls[2].body.max_tokens, undefined);
});

test("max reply tokens are clamped in settings replies", () => {
  assert.equal(cleanSettingsPatch({ maxOutputTokens: 1 }).maxOutputTokens, 512);
  assert.equal(cleanSettingsPatch({ maxOutputTokens: 999999 }).maxOutputTokens, 32768);
});

test("settings replies cannot write provider keys or unknown fields", () => {
  const patch = cleanSettingsPatch({
    temperature: 9,
    maxSteps: 0,
    dryRun: true,
    provider: "nope",
    toolMode: "magic",
    providers: { openai: { apiKey: "sk-live" } },
    evil: 1,
    trustedSites: ["Example.com", "bad host", ""]
  });
  assert.deepEqual(patch, {
    temperature: 2,
    maxSteps: 32,
    dryRun: true,
    trustedSites: ["example.com"]
  });
});
