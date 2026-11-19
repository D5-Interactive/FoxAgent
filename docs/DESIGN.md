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
- Run repeatable jobs, including site workflows and bulk material downloads.
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
│ Chat / Chats / Tasks    │◄────────►│ main.js   routing, sessions, updates │
│ / Packs / Models        │ messages │ sessions.js  one run per tab         │
│ settings form           │          │ agent.js  loop, compaction, protocol  │
│ safe Markdown renderer  │          │ tools.js  core tools and risk levels  │
└─────────────────────────┘          │ packs.js  catalog, modules, prompts  │
                                     │ updates.js  GitHub release check     │
                                     │ providers.js  OpenAI + Anthropic     │
                                     │ prompt.js / recipes.js / store.js    │
                                     │ settings-guard.js  reply validation  │
                                     │ page.js   injection + tab messaging  │
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
for log export and `web.fetch`. Tab conversations live in `storage.session`
(cleared with the browser, so persisted tab ids stay valid) and are written after
each step. While the sidebar's port is open the event page stays alive; if the
sidebar is closed for long enough, Firefox may suspend it and a run pauses.
Switching tabs keeps the sidebar open, so work continues.

### Why two provider adapters

LM Studio, Ollama, vLLM, llama.cpp, OpenAI, OpenRouter, DeepSeek and most hosted
services expose an OpenAI-compatible `/chat/completions` and `/models`.
`providers.js` has one streaming client for that protocol: a tool-call
accumulator, one friendly-error path, and SSE plus non-streaming JSON handling.
Adding another OpenAI-compatible runtime is usually just a catalog entry in
`store.js`.

Ollama is the exception on the request path: chat goes to its native
`/api/chat` (NDJSON stream) so `num_ctx` and `keep_alive` take effect; model
listing still uses `/v1/models`. See History compaction.

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

1. Resolve the session's pinned tab for the system prompt and tools (never the
   active tab, so switching tabs cannot retarget a run).
2. Ask the model server for the model's real context window, tool and image
   support, and size (`modelinfo.js`), then plan the step's budget
   (`budget.js`): reply tokens, history characters and the per-tool clip, after
   subtracting the system prompt and tool schemas. Build provider messages from
   history within that budget.
3. Pick the tool menu for this step: core tools, enabled packs whose hosts match
   an open tab, and a shorter core list for small models.
4. Stream a completion, forwarding deltas to the sidebar.
5. If there are no native calls and the mode allows it, try the JSON fallback.
6. Record the assistant message and any prose.
7. Execute calls one at a time (at most six per turn), appending tool results.
   A repeated identical call gets a corrective note in its result.
   If the provider stops on the output limit, the loop asks for a continuation
   up to twice before ending the turn.
8. Repeat until the model answers without calls, the step limit is reached, or
   the user stops.

The step limit is user-configurable (default 32, capped at 24 for small models).
A per-turn cap of six tool calls keeps one model reply from turning into a burst
of side effects and matches what local models can reliably emit.

### Per-tab sessions

`sessions.js` keeps a `Map<tabId, session>`. Each session owns its model history,
transcript, scratchpad, busy flag, abort controller and pending prompts. Settings,
model lists and the activity log stay global.

- The sidebar resolves its window's active tab and shows that tab's session. A
  tab switch is a view swap: transcript, notes, busy state and pending prompts
  come from the background.
- A run pins `session.tabId`. Page tools with no `tabId` use the pinned tab, not
  `activeTab()`. `browser.tabs` and an explicit `tabId` still reach other tabs.
- Two runs may proceed at once (one per tab); a third is refused with a message.
  Stopping is per tab; Stop in the sidebar aborts the tab in view.
- Approvals are owned by the session that requested them. The reply carries only
  the prompt id, and trusted hosts come from the stored request, never from the
  UI reply.
- Closing a tab aborts its run and drops the session. Closing the sidebar does
  not abort anything: prompts keep their timeouts and re-render when the panel
  returns.
- Sessions are capped at 12 per browser run; the oldest idle one is evicted.

`state` and `tab` messages carry the session for the tab in view. Incremental
events carry `tabId`; the sidebar ignores events for other tabs and only updates
the session strip ("other tabs working", with an approval marker).

### Small-model profile

`modelSize` parses the model id (4b, 9b, e2b, e4b, 70b). The size the server
reports wins when there is one (Ollama's `parameter_size` makes `llama3.2` a 3B
model), and a context window under 16k selects the profile too. At 12B or less
the run switches to a compact prompt, a 24-step cap, 60-element snapshots and a 6,000
character page-read cap. The tool menu drops `page.links` and `browser.switch`,
and `page.clickText` lets the model click by visible label instead of tracking
refs. Site work is expressed as pack tools such as `canvas.todo`,
`canvas.courses`, `canvas.digest`, `canvas.assignments` and `canvas.modules`, so endpoint paths
and id shapes are code rather than prompt tokens. `canvas.digest` loops over the
active courses inside one tool call, which keeps a weekly brief to two calls.

### Packs

A pack is a directory under `packs/` with `pack.json`, `tools.js`, `desc.md` and
`icon.svg`. `packs/index.json` lists the ids that ship in this build.

`packs.js` loads the catalog with `fetch(runtime.getURL(...))`, then reads each
enabled pack's module from a static registry in `packs/registry.js`. Nothing is
fetched from the network as code, and there is no dynamic import; the Packs
panel and the `packs/` directory are the same catalog. Installing a pack adds its id to `settings.packs`, and its
tools and prompt join the next step.

Host gating follows the pinned tab only. Its host decides the pack tools, the
prompt section and the pack recipes. A Canvas tab open elsewhere does not add
Canvas tools to a Google Slides run; start the task on the Canvas tab instead.
`packs/sdk.js` gives packs the same page helpers, pagination and clipping rules
as core tools. Pack modules may export `recipes`, and the Tasks panel shows only
the recipes for the current tab.

The Packs panel's check fetches `packs/index.json` from the repository's main
branch and marks ids that this build does not include. Code from a newer pack
still arrives with a FoxAgent update.

### Updates

`updates.js` asks `api.github.com/repos/D5-Interactive/FoxAgent/releases/latest`
and caches the answer for six hours. It compares the release tag with the
manifest version, picks a zip or xpi asset, and reports the release page.

`autoUpdate` only controls whether the check runs at startup. Firefox installs
signed add-ons only, so **Update** downloads the asset to
`Downloads/FoxAgent/updates/` and opens the release page; the extension never
replaces itself. Dismissing a version stores `dismissedUpdate`, so the banner
stays away until the next release.

### History compaction

When the server reports a context window (Ollama `/api/show` and `/api/ps`, LM
Studio `/api/v0/models`, llama.cpp `/props`, vLLM `max_model_len`), the budget is
derived from it: a quarter of the window is kept for the reply (never more than
Max reply tokens), and the system prompt, tool schemas and any screenshot are
subtracted before history. If the full tool menu would crowd the conversation,
tool descriptions are shortened to their first sentence. Cloud models and
servers that report nothing keep the character budget (`contextChars`, default
96,000; capped at 48,000 for small models), as before.

Ollama is called through its native `/api/chat`, because its OpenAI-compatible
`/v1` endpoint ignores `num_ctx` and runs every model at the server default,
cutting the front of the prompt. FoxAgent requests `num_ctx` from the Local
context setting (default 16,384, never above the model's trained window) and
`keep_alive` of 30 minutes. A proxy that only serves `/v1` is detected by a 404
and used as before.

`fitHistory` groups history into user turns and keeps the newest turns that
fit. If the newest turn is still too large, old tool output is clipped first;
then whole early steps (an assistant call with its results, so call ids stay
paired) are dropped, keeping the request and the latest step. A system note
tells the model what was removed. The scratchpad (`task.note`) is the durable
memory that survives compaction and page loads. It is sent as the last message
rather than inside the system prompt, and the prompt carries the date without a
clock time, so the prompt prefix stays byte-identical between steps and local
servers can reuse their prompt cache.

If the server rejects a request as too long, the run learns the limit (parsed
from the error, or 60% of the current guess) and retries the step. If it
rejects native tools in Auto mode, the run switches to the JSON protocol for
that model and replays earlier native calls as JSON text.

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

- `snapshot`: heading outline plus visible interactive elements, ranked so
  on-screen buttons and fields survive a small element cap. It walks open shadow
  roots and same-origin iframe documents, and marks offscreen controls. Each
  element gets a stable `e12` ref stored in a `Map`. Refs are per tab and go
  stale after navigation or DOM replacement; the tool returns a clear error and
  the agent is told to snapshot again.
- `read`: choose a main-content root (`main`, `article`, role=main, common class
  names) by a score that subtracts navigation/form/link noise, then walk the DOM
  into Markdown. Builds text nodes directly; no HTML string is produced. Code
  fences are protected, whitespace is tidied outside them, tables are capped,
  and small tracking images are skipped.
- `links`: absolute links with an optional regex filter.
- `query`: find controls by CSS selector, visible text or ARIA role, with refs,
  labels, values and rectangles.
- `click` / `clickText` / `clickAt` / `type` / `select` / `scroll`: act on a ref,
  a visible label for `clickText` (with exact, role and nth options), or a
  viewport point from the last screenshot for `clickAt`. Password
  fields are refused. `type` uses the native value setter so React/Vue inputs see
  the change, then dispatches `input` and `change`.
- `fill`: fill several fields in one call by ref, label, placeholder or name,
  optionally submitting the form.
- `press`: dispatch Enter, Tab, Escape or an arrow key, and submit the enclosing
  form on Enter.
- `waitFor`: wait for text to appear or disappear, or for a selector.
- `fetch`: same-origin (or CORS-permitted) `fetch` with `credentials: "include"`,
  a 45 s timeout, and a body cap. It strips `host`, `origin`, `cookie` and
  `content-length` headers. Returns status, `Link`, rate-limit headers, parsed
  JSON when possible, and a text fallback.

All cross-realm checks use tag names and the element's own window, so the same
code works inside iframes. The bridge never uses `eval`, `Function`, or
`innerHTML`. It ignores messages whose sender is not this extension.

### Vision

`page.screenshot` captures the tab with `browser.tabs.captureTab`, which works
for a pinned background tab as well as the visible one. The data URL is kept on
the session, not in the transcript. The next request that can carry images
attaches it as one user message with a text note, then clears it so every later
step is not charged for the same picture.

Vision support is decided by `vision.js`: the `vision` setting is `auto`, `on`
or `off`, and `auto` recognizes common vision families in the model id. The
screenshot tool is only offered when images can be sent. OpenAI-compatible
providers receive an `image_url` part; `toAnthropicMessages` converts the same
part into an Anthropic base64 image block.

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

The menu is not always the full registry. `toolsFor` returns an ordered list for
the step: core tools plus enabled packs whose hosts match an open tab, and a
slightly shorter core list for small models. `suggestTools` proposes the closest names when a model
invents one, which turns a dead end into a one-line repair.

### Approvals and questions

`main.js` keeps prompts on the session that asked for them. Each entry has a
timeout (3 minutes for approvals, 5 minutes for questions) and resolves a promise
the agent is awaiting. The sidebar renders an inline card for the tab in view and
a "needs you" chip for any other tab. A denial resolves `false`; a question
resolves a string.

Prompts are settled on:

- user stop (per tab, or all),
- tab close,
- the end of that session's turn,
- prompt expiry.

A closed sidebar deliberately does **not** settle prompts: the run belongs to the
tab, and the prompt is re-sent with the session when the panel reconnects. The
`answer` handler checks that the id belongs to a question, and `approve` checks
that it belongs to an approval, so a message cannot resolve the wrong kind. The
approval id is a random UUID, and the hosts added by "Always here" come from the
pending request, not from the sidebar message.

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
scroll container so a wide table cannot blow out the panel width.

Key UI state:

- `app.settings`, transcript, log, notes, models, tab, busy.
- `app.tabId` / `app.sessions`: the tab in view and a summary of every tab with
  work or history. The Chats panel lists them all, with Open and Clear actions.
- `app.recipes`: the core recipes plus the recipes of packs matching this tab.
- `app.modelsByProvider`: cached model ids per provider, so the Models panel can
  switch between providers without refetching.
- `app.modelsProvider`: the provider currently open in the Models panel. It is
  only made active by **Use this model**.
- `app.pending`: ids of visible approval/question cards.
- `app.streaming`: the live assistant bubble.
- `app.usage`: the last step's token use for the tab in view, from a `usage`
  event. The context meter beside Send shows it against the model's window
  and turns amber at 75% and red at 90%. Counts come from the server when it
  sends them (`stream_options.include_usage` for OpenAI, LM Studio, vLLM and
  llama.cpp; Ollama's eval counts; Anthropic usage) and are marked as estimates
  otherwise.
- `app.modelInfo`: what the server reported about the model in use (window,
  tools, vision, size, compact profile), shown as tags in Models and in the model
  button tooltip.
- `app.sent`: messages sent from this sidebar, recalled with Up and Down in an
  empty composer. Kept in memory only.

Provider, base URL, API key and model controls live only in the Models panel.
Chat onboarding is a short pointer to it, and Settings shows the active model
with a **Change model** button. Selecting a provider card edits a draft; the
active provider and model change together on **Use this model**. Model lists are
cached per provider and cleared when a key is forgotten.

Every tab switch swaps in that tab's transcript, notes, busy state and prompts.
The session strip under the tabs lists other tabs that are working, waiting for
an answer, or holding an earlier conversation; clicking one focuses its tab.

Busy state disables Send and the new-conversation button for the tab in view and
shows Stop. It no longer blocks the entire browser: another tab can start its own
run. The composer stays usable for typing, and starting a second run in the same
tab is refused until that turn ends.

Assistant replies have a Copy button (Markdown source). A failed run ends with
an error notice offering **Retry**, which runs again from the existing history
without a new user message; step-limit and output-limit notices offer
**Continue**. Only the newest notice keeps its button. Esc stops the running task
in the tab in view.

Streaming is rendered as plain text while it arrives. Inline `<think>` blocks
are hidden while they stream and the status line reads "thinking". The final assistant item
is re-rendered as Markdown when `assistant_end` arrives, which avoids parsing
half-written code fences on every token.

## Storage

`store.js` owns defaults and global persistence:

- `settings`: active provider and per-provider URL/key/model, temperature, step
  limit, max reply tokens, tool mode, vision mode, context and page budgets,
  approval policy,
  trusted sites, allowlist, dry run, installed packs, auto-update preference and
  dismissed update version.
- `log`: audit entries.
- `updateCache`: the last GitHub release check, kept in `storage.local` for six
  hours.

`sessions.js` owns conversations:

- `foxagent.sessions` in `browser.storage.session`: per-tab history, transcript
  and scratchpad. Session storage is cleared with the browser, which keeps
  persisted tab ids meaningful, and is capped at 10 MB by Firefox.
- In memory: busy flag, abort controller and pending prompts (never persisted).

Caps: 240 entries per session transcript/history, 12 sessions, 400 log entries,
6,000 characters of scratchpad per tab. `mergeSettings` deep-merges patches so
changing one approval level does not wipe the others. `structuredClone` prevents
callers from mutating defaults. New provider entries are generated from the
catalog, so existing profiles gain cloud providers on load.

`publicSettings()` is the only boundary between stored settings and the sidebar.
It replaces every provider's `apiKey` with `hasKey` plus a masked `keyMask`, and
exposes provider metadata (label, URL, hint, cloud flag, key page). Key writes
use explicit `saveKey`/`forgetKey` messages; ordinary settings patches never
carry keys back to the UI. Incoming settings patches are filtered by
`settings-guard.js`: unknown keys, `providers`, and out-of-range numbers are
dropped, so display code cannot write a key or a server URL through the general
settings path.

## Security notes

- All page-derived strings are rendered with DOM text nodes; there is no
  `innerHTML` in the extension pages.
- Only this extension's sidebar page may connect to the background port; other
  ports named `sidebar` are ignored.
- The content bridge ignores messages without the `__foxagent: true` marker and
  from a foreign sender id.
- The sidebar may change only known settings. Provider credentials and base URLs
  travel through dedicated messages, and approval replies cannot add hosts to the
  trust list: hosts come from the request that was shown.
- `page.fetch` refuses non-http(s), strips forbidden headers, and does not
  follow `file:` or extension URLs.
- `web.fetch` refuses loopback, RFC1918 and link-local hosts plus cloud metadata
  names, so a prompt-injected URL cannot probe the local network from the
  extension context. Local pages remain available through `page.read` in a tab,
  where the session is already the user's own.
- `files.write` and download filenames are sanitized; `..`, control characters
  and reserved punctuation are removed, and paths are capped.
- The extension never types into password fields and never reads cookies
  directly; cookies stay inside the tab's own fetch.
- The system prompt treats page content as untrusted and tells the model to
  report injection attempts.
- The audit log records blocked and denied calls, which makes a misbehaving
  prompt visible after the fact.
- Packs are part of the signed package. The remote catalog check reads JSON
  only; it never downloads code. Update downloads a release asset to Downloads
  and opens GitHub; it cannot install an extension by itself.
- API keys never enter the sidebar: it receives only `hasKey` and a masked
  suffix. Requests that need a key are made by the background page. Anthropic
  uses `x-api-key`; OpenAI-compatible providers use `Authorization: Bearer`.

Residual risks:

- `<all_urls>` means any http(s) tab can be read if the user asks or a recipe
  targets it. The allowlist is the main narrowing control.
- A model, local or cloud, can still be manipulated by page content into
  proposing a bad tool call. Approval and dry run are the real boundary, not the
  prompt.
- Two tabs can now run at once, so two approval prompts may be pending. The
  session strip marks which tab is waiting, but a prompt can still time out if
  the user never looks at that tab.
- API keys are stored unencrypted in the Firefox profile.
- A cloud provider receives prompts, page text and tool results, and bills the
  key. This is disclosed in Models and in the README.
- Download URLs are requested by Firefox with the user's cookies; a malicious
  page could try to make a file URL look like course material. The manifest and
  filename are shown in the approval summary, and the agent is told to inventory
  before downloading.

## Extension points

- Add a tool: declare it in `TOOLS` with schema, risk, and `run(args, ctx)`. It
  appears in `toolSchemas` and the prompt automatically; `toolsFor` decides when
  it is offered (site pack, small-model menu).
- Add a site pack: copy `packs/_template/`, give it an id, tools and prompt,
  add the id to `packs/index.json` and import the module in
  `packs/registry.js`. The catalog, host gating, prompt injection and Packs
  panel pick it up with no core changes.
- Add a provider: add an entry to `PROVIDERS` in `store.js` with a label, base
  URL, hint, and `cloud`/`keyUrl` metadata. The adapter needs no new code if the
  runtime is OpenAI-compatible; set `kind: "anthropic"` for a Messages API
  provider.
- Add a recipe: append to `RECIPES` with `id`, `tag`, `title`, `hint`, `prompt`.
  The Tasks tab groups by `tag`; the background accepts any known id.
- Add a page operation: add a case to the bridge `handle` switch and a tool (or
  extend an existing one) in `tools.js`.

## Testing

Current checks:

- `node --test tests/*.test.mjs` covers model sizing, tool menu, pack host
  matching and catalog files, version comparison, tool suggestions, JSON
  fallback parsing, caps and the settings guard. `context.test.mjs` covers the
  context budget, model-info parsing for each local server, the native Ollama
  adapter and its fallback, error classification, step dropping, message
  normalization, usage reporting and vision guessing.
- `uv run --with playwright python tests/page_bridge.py` loads the real bridge
  in Chromium against `tests/fixtures/page.html` and checks snapshots, shadow DOM,
  iframe fields, clickText with nth, stale refs, multi-field fill, press, waitFor
  and errors.
- `uv run --with playwright python tests/sidebar_smoke.py` loads the sidebar with
  a stubbed port and checks the six panels, the Chats list, per-tab recipes,
  pack markers, reply Copy, Retry and Continue actions, the context meter, input
  recall and the model facts in Models.
- A stubbed `browser` harness imports `main.js` and checks hello and state
  routing, per-tab reset isolation, the settings guard, pinned-tab resolution,
  pack install, the remote pack check, update download and screenshot capture.
- `node --check` on every module.
- `web-ext lint --ignore-files "tests/**"` must stay at 0 errors / 0 warnings.
  Tests are not packaged.
- Node provider checks cover Anthropic payload conversion, Anthropic SSE and
  non-streaming responses, OpenAI SSE regression, model-listing auth headers,
  missing keys and rejected keys.
- A Node harness with a stubbed `browser` API can import `main.js` and exercise
  hello/state routing, per-tab reset, the settings guard and pinned-tab
  resolution. The real extension is loaded in Firefox for UI checks.

Planned: a headless Firefox run that drives the sidebar port, and fixtures for
Markdown conversion and pack payload projection.

## Roadmap

1. Optional per-site host permissions with `permissions.request`, so the
   installation does not need `<all_urls>`.
2. PDF text extraction and OCR behind an explicit, local-only path.
3. Saved task runs and resumable downloads with a persisted manifest.
4. Model profiles per provider (temperature/tool mode remembered separately).
5. A session picker for closed tabs, and restoring a conversation by URL after a
   browser restart.
6. Better page extraction heuristics for JavaScript apps and shadow DOM.
