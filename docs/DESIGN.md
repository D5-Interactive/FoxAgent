# FoxAgent design

This document describes how the extension is put together, why the pieces are
split the way they are, and where the safety boundaries sit. It is meant for
someone changing the code, not for end users. Installation and usage are in
[../README.md](../README.md).

## Goals and non-goals

Goals:

- A browser agent that runs on a local model server by default, with optional
  cloud API providers.
- Read real, logged-in pages and act on them through stable element refs.
- Turn pages and documents into Markdown the user can keep.
- Run repeatable jobs, especially a Canvas weekly workflow and bulk material
  downloads.
- Keep the user in control: approvals, dry run, allowlists, audit log, abort.

Non-goals for 0.1:

- Cloud sync, accounts, telemetry, or a FoxAgent relay.
- Parsing PDFs, images or office formats.
- Automating passwords, payments, sign-ups, submissions or destructive changes.
- Chromium support.
- A general scripting API for third-party extensions.

## Runtime shape

Firefox MV3 extension with three contexts:

```
sidebar (src/sidebar)                background event page (src/background)
┌─────────────────────────┐  port    ┌──────────────────────────────────────┐
│ Chat / Tasks / Activity │◄────────►│ main.js   routing, approvals, models │
│ / Models                │ messages │ agent.js  loop, compaction, protocol  │
│ settings form           │          │ tools.js  19 tools + risk levels      │
│ safe Markdown renderer  │          │ providers.js  OpenAI + Anthropic      │
└─────────────────────────┘          │ prompt.js / recipes.js / store.js     │
                                     │ page.js   injection + tab messaging   │
                                     └───────────────┬──────────────────────┘
                                                     │ tabs.sendMessage
                                     ┌───────────────▼──────────────────────┐
                                     │ content bridge (src/content/agent.js)│
                                     │ runs in the page origin on demand    │
                                     │ snapshot refs, DOM → Markdown, fetch │
                                     └──────────────────────────────────────┘
```

The background page is an event page, not a service worker: Firefox MV3 still
allows DOM APIs there, and `Blob`, `URL.createObjectURL` and `DOMParser` are used
for log export and `web.fetch`. State lives in memory while the sidebar port is
open and is persisted to `browser.storage.local` after each turn.

### Why two provider adapters

LM Studio, Ollama, vLLM, llama.cpp, OpenAI, OpenRouter, DeepSeek and most hosted
services expose an OpenAI-compatible `/chat/completions` and `/models`.
`providers.js` has one streaming client for that protocol: a tool-call
accumulator, one friendly-error path, and SSE plus non-streaming JSON handling.
Adding another OpenAI-compatible runtime is usually just a catalog entry in
`store.js`.

Anthropic's Messages API is different enough to need a dedicated adapter in the
same file: `POST /messages`, `x-api-key` and `anthropic-version` headers, a
required `max_tokens`, `input_schema` tools, `tool_use`/`tool_result` content
blocks, and named SSE events (`content_block_delta`, `message_delta`). The agent
still speaks one internal message format; `toAnthropicMessages` converts it on
the way out.

`streamChat` selects the adapter from `provider.kind` (or the provider key), sends
either `/chat/completions` or `/messages`, and normalizes both back to
`{ text, calls, finishReason, usage }`. SSE frames are split on a blank line,
`data:` lines are parsed independently, and one malformed frame does not kill the
turn. Tool calls are accumulated by `index` because servers may split a single
call across many deltas. Anthropic's `stop_reason` is mapped to the internal
values (`tool_use` → `tool_calls`, `max_tokens` → `length`).

### Agent loop

`runAgent` in `agent.js`:

1. Resolve the active tab for the system prompt.
2. Build provider messages from history, applying a character budget.
3. Stream a completion, forwarding deltas to the sidebar.
4. If there are no native calls and the mode allows it, try the JSON fallback.
5. Record the assistant message and any prose.
6. Execute calls one at a time (at most six per turn), appending tool results.
7. Repeat until the model answers without calls, the step limit is reached, or
   the user stops.

The step limit is user-configurable (default 32). A per-turn cap of six tool
calls keeps one model reply from turning into a burst of side effects and matches
what local models can reliably emit.

### History compaction

`fitHistory` groups history into user turns and keeps the newest turns that fit
the character budget (`contextChars`, default 48,000). If a single turn is still
too large, tool output is clipped first, preserving the newest text. A system
note tells the model that earlier context was removed. The scratchpad
(`task.note`) is the durable memory that survives compaction and page loads, and
is re-injected into the system prompt every step.

### Native calls and the JSON fallback

Weak local models often ignore the `tools` parameter. Three modes exist:

- `native`: send `tools` and only accept native calls.
- `json`: do not send tools; parse fenced JSON or `<tool_call>` blocks.
- `auto` (default): send tools; if the reply has no native calls, attempt the
  JSON parser anyway.

`parseTextCalls` accepts a single object, a list under `tools`/`tool_calls`, or a
tagged block. It requires an explicit tool-ish key (`tool`, `tool_name`,
`function.name`) for unknown names, so a random JSON object in prose is not
mistaken for a call. Arguments may be an object or a JSON string. Parsed calls
are recorded with `protocol: "json"` so the next request replays them as plain
tool-result user messages instead of native `tool` roles.

### Page bridge

`page.js` injects `src/content/agent.js` on demand with
`browser.scripting.executeScript`, then pings it. The bridge is an IIFE with a
guard so two injections cannot register twice. It is not a declared content
script: this keeps startup cheap and avoids running on every page until needed.

The bridge exposes one message listener and these operations:

- `snapshot`: heading outline plus visible interactive elements. Each element
  gets a stable `e12` ref stored in a `Map`. Refs are per tab and go stale after
  navigation or DOM replacement; the tool returns a clear error and the agent is
  told to snapshot again.
- `read`: choose a main-content root (`main`, `article`, role=main, common class
  names) by a score that subtracts navigation/form/link noise, then walk the DOM
  into Markdown. Builds text nodes directly; no HTML string is produced. Code
  fences are protected, whitespace is tidied outside them, tables are capped,
  and small tracking images are skipped.
- `links`: absolute links with an optional regex filter.
- `click` / `type` / `select` / `scroll`: act on a ref. Password fields are
  refused. `type` uses the native value setter so React/Vue inputs see the
  change, then dispatches `input` and `change`.
- `fetch`: same-origin (or CORS-permitted) `fetch` with `credentials: "include"`,
  a 45 s timeout, and a body cap. It strips `host`, `origin`, `cookie` and
  `content-length` headers. Returns status, `Link`, rate-limit headers, parsed
  JSON when possible, and a text fallback.

The bridge never uses `eval`, `Function`, or `innerHTML`.

### Tool registry and risk

`tools.js` declares every capability with a JSON schema, a risk level and a
function. Risk is the contract for approvals:

| Risk | Meaning | Default policy |
| --- | --- | --- |
| `read` | Read page/network or scratchpad; no side effects | auto |
| `act` | Change the page or browser state | confirm |
| `write` | Write to disk or download | confirm |

Two refinements happen in `agent.js`:

- `page.fetch` with a method other than GET/HEAD is treated as `act`, because a
  POST/PUT/PATCH/DELETE can change server state.
- `browser.downloadMany` collects every file host and requires the whole batch
  to pass the allowlist. If a user chooses “Always here”, all hosts in the batch
  are added to trusted sites.

Risk also affects dry run and logging. A dry-run call returns a description to
the model and is never executed.

### Approvals and questions

`main.js` keeps a `pending` map of unresolved prompts. Each entry has a timeout
(3 minutes for approvals, 5 minutes for questions) and resolves a promise the
agent is awaiting. The sidebar renders an inline card. A denial resolves `false`;
a question resolves a string.

The same map is settled on:

- user stop,
- sidebar disconnect,
- the end of every turn,
- prompt expiry.

This prevents a closed sidebar from leaving a promise pending forever. The
`answer` handler checks that the id belongs to a question, and `approve` checks
that it belongs to an approval, so a message cannot resolve the wrong kind.

### Site policy

`allowedBySite` and `trustedBySite` both normalize `www.` and match a host or any
subdomain. An empty allowlist means “any host, with per-action approval”. A
non-empty allowlist blocks the call before approval. Trusted sites skip the
approval prompt for that host but never skip the allowlist.

`contextHosts`/`callContext` gather hosts from the tab, the URL argument, every
file in a batch, or the target tab for `browser.switch`/`browser.close`. For
`page.fetch`, relative URLs resolve against the tab's URL so the check sees the
real target.

## Sidebar

The sidebar owns no agent logic. It receives a full state message on connect and
incremental messages afterwards: deltas, transcript items, tool status, tab
updates and busy state. The Markdown renderer builds DOM nodes with
`textContent`; links are restricted to `http(s)` and `mailto`. Tables get a
scroll container so a wide Canvas table cannot blow out the panel width.

Key UI state:

- `app.settings`, transcript, log, notes, models, tab, busy.
- `app.modelsByProvider`: cached model ids per provider, so the Models panel can
  switch between providers without refetching.
- `app.modelsProvider`: the provider currently open in the Models panel. It is
  only made active by **Use this model**.
- `app.pending`: ids of visible approval/question cards.
- `app.streaming`: the live assistant bubble.

Provider, base URL, API key and model controls live only in the Models panel.
Chat onboarding is a short pointer to it, and Settings shows the active model
with a **Change model** button. Selecting a provider card edits a draft; the
active provider and model change together on **Use this model**. Model lists are
cached per provider and cleared when a key is forgotten.

Busy state disables Send and the new-conversation button, shows Stop, and blocks
`send`/`runRecipe` in the background as well. The composer stays usable for
typing, but a second request is refused until the turn ends.

Streaming is rendered as plain text while it arrives. The final assistant item
is re-rendered as Markdown when `assistant_end` arrives, which avoids parsing
half-written code fences on every token.

## Storage

`store.js` owns defaults and persistence:

- `settings`: active provider and per-provider URL/key/model, temperature, step
  limit, tool mode, context and page budgets, approval policy, trusted sites,
  allowlist, dry run.
- `session`: model history, transcript, scratchpad.
- `log`: audit entries.

Caps: 240 session entries, 400 log entries, 6,000 characters of scratchpad.
`mergeSettings` deep-merges patches so changing one approval level does not wipe
the others. `structuredClone` prevents callers from mutating defaults. New
provider entries are generated from the catalog, so existing profiles gain cloud
providers on load.

`publicSettings()` is the only boundary between stored settings and the sidebar.
It replaces every provider's `apiKey` with `hasKey` plus a masked `keyMask`, and
exposes provider metadata (label, URL, hint, cloud flag, key page). Key writes
use explicit `saveKey`/`forgetKey` messages; ordinary settings patches never
carry keys back to the UI.

## Security notes

- All page-derived strings are rendered with DOM text nodes; there is no
  `innerHTML` in the extension pages.
- The content bridge ignores messages without the `__foxagent: true` marker.
- `page.fetch` refuses non-http(s), strips forbidden headers, and does not
  follow `file:` or extension URLs.
- `files.write` and download filenames are sanitized; `..`, control characters
  and reserved punctuation are removed, and paths are capped.
- The extension never types into password fields and never reads cookies
  directly; cookies stay inside the tab's own fetch.
- The system prompt treats page content as untrusted and tells the model to
  report injection attempts.
- The audit log records blocked and denied calls, which makes a misbehaving
  prompt visible after the fact.
- API keys never enter the sidebar: it receives only `hasKey` and a masked
  suffix. Requests that need a key are made by the background page. Anthropic
  uses `x-api-key`; OpenAI-compatible providers use `Authorization: Bearer`.

Residual risks:

- `<all_urls>` means any http(s) tab can be read if the user asks or a recipe
  targets it. The allowlist is the main narrowing control.
- A model, local or cloud, can still be manipulated by page content into
  proposing a bad tool call. Approval and dry run are the real boundary, not the
  prompt.
- API keys are stored unencrypted in the Firefox profile.
- A cloud provider receives prompts, page text and tool results, and bills the
  key. This is disclosed in Models and in the README.
- Download URLs are requested by Firefox with the user's cookies; a malicious
  page could try to make a file URL look like course material. The manifest and
  filename are shown in the approval summary, and the agent is told to inventory
  before downloading.

## Extension points

- Add a tool: declare it in `TOOLS` with schema, risk, and `run(args, ctx)`. It
  automatically appears in `toolSchemas`, the JSON fallback, and the prompt's
  tool list if you update that text.
- Add a provider: add an entry to `PROVIDERS` in `store.js` with a label, base
  URL, hint, and `cloud`/`keyUrl` metadata. The adapter needs no new code if the
  runtime is OpenAI-compatible; set `kind: "anthropic"` for a Messages API
  provider.
- Add a recipe: append to `RECIPES` with `id`, `tag`, `title`, `hint`, `prompt`.
  The Tasks tab groups by `tag`; the background accepts any known id.
- Add a page operation: add a case to the bridge `handle` switch and a tool (or
  extend an existing one) in `tools.js`.

## Testing

There is no browser test runner yet. Current checks:

- `node --check` on every module.
- `web-ext lint` must stay at 0 errors / 0 warnings.
- Node provider checks cover Anthropic payload conversion, Anthropic SSE and
  non-streaming responses, OpenAI SSE regression, model-listing auth headers,
  missing keys and rejected keys.
- A Node smoke test can import `agent.js` for `parseTextCalls`, `allowedBySite`
  and `trustedBySite`; the demo in `README.md` shows the idea.
- Manual UI check with a mocked port against a local static server; the real
  extension requires loading it in Firefox because `browser.*` is not available
  in a normal page.

Planned: a small Vitest/Node suite for protocol parsing, host policy, Markdown
conversion and Canvas payload projection, plus a headless Firefox run when the
environment allows a second profile.

## Roadmap

1. Optional per-site host permissions with `permissions.request`, so the
   installation does not need `<all_urls>`.
2. PDF text extraction and OCR behind an explicit, local-only path.
3. Saved task runs and resumable downloads with a persisted manifest.
4. Model profiles per provider (temperature/tool mode remembered separately).
5. Parallel reading of several tabs with a single synthesis step.
6. Better page extraction heuristics for JavaScript apps and shadow DOM.
