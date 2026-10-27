# FoxAgent

A local-first browser agent that lives in the Firefox sidebar. FoxAgent reads the
page you are on, turns it into Markdown, operates interfaces, calls a site's own
JSON API with your logged-in session, and runs longer jobs such as a Canvas
weekly digest or a bulk course-material download.

By default everything runs on your machine. There is no FoxAgent account, no
relay server, and no telemetry. Connect a local model server, or add an API key
for a cloud provider if you prefer. With a cloud provider, prompts, page text and
tool results are sent to that provider and billed to your key.

- Firefox 115+ (desktop), Manifest V3
- Sidebar UI with Chat / Tasks / Activity / Models
- Local servers and cloud APIs behind one model picker
- Native tool calling with a JSON fallback for smaller local models
- Page reading to Markdown, snapshot refs, click/type/select, same-origin fetch
- Approval gates, dry run, host allowlist, trusted sites, audit log
- Canvas recipes for weekly work, grades, course briefings and materials

## Install

### Temporary (development)

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on…**.
3. Select this repository's `manifest.json`.
4. Open the sidebar with the toolbar button, `Ctrl+Shift+F`, or
   **View → Sidebar → FoxAgent**.

The add-on is removed when Firefox closes. Reload it from the same page after
changing source files.

### Packaged

```bash
npx --yes web-ext@8 lint --output text
npx --yes web-ext@8 build --overwrite-dest
```

The zip is written to `web-ext-artifacts/`. A normal Firefox release requires a
signature from addons.mozilla.org; Firefox Developer Edition and Nightly can load
an unsigned package when `xpinstall.signatures.required` is set to `false` in
`about:config`.

If Firefox is installed as a snap, `web-ext run` may not be able to start a
second profile. Loading the temporary add-on through `about:debugging` always
works.

## Connect a model

Open the **Models** tab (or click the model button in the top bar). Pick a
provider, check the base URL, then use **Detect** to list its models and
**Use this model** to make it active. The Models panel is the only place where
provider, URL, API key and model are set; chat and Settings stay out of the way.

### Local servers

| Provider | Default base URL | Notes |
| --- | --- | --- |
| LM Studio | `http://localhost:1234/v1` | Start the local server and load a tool-capable model. |
| Ollama | `http://localhost:11434/v1` | Uses Ollama's OpenAI-compatible endpoint. |
| vLLM | `http://localhost:8000/v1` | Start with `--enable-auto-tool-choice` and the parser for your model. |
| llama.cpp | `http://localhost:8080/v1` | Run `llama-server --jinja` with a tool-capable GGUF. |
| Custom | any | Anything exposing `POST /chat/completions` and `GET /models`. |

Local servers need no account. If yours requires a key, save it in Models; it is
sent as a bearer token.

### Cloud APIs

| Provider | Default base URL | Notes |
| --- | --- | --- |
| OpenAI · GPT | `https://api.openai.com/v1` | Create a key at `platform.openai.com/api-keys`. |
| Anthropic · Claude | `https://api.anthropic.com/v1` | Uses the Messages API; tool use is supported. |
| OpenRouter | `https://openrouter.ai/api/v1` | One key for many hosted models, including free ones. |
| DeepSeek | `https://api.deepseek.com/v1` | Chat and reasoning models. |
| Groq | `https://api.groq.com/openai/v1` | Fast hosted open models. |
| Mistral | `https://api.mistral.ai/v1` | Mistral's hosted API. |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | Gemini's OpenAI-compatible endpoint. |
| xAI · Grok | `https://api.x.ai/v1` | Grok models from xAI. |

Paste a key and press **Save key**, then **Detect**. **Forget** removes it. The
sidebar never receives the raw key back: it is shown only as a masked suffix.
Keys live in `browser.storage.local` inside this Firefox profile, in plain text,
so protect the profile as you would any saved password. A cloud provider sees the
prompts, page text and tool results used in a task and bills the key directly.

The model must be good at instructions and tool use. Models around 7B and up with
a tool-calling template work best locally; hosted models vary, so pick one that
supports tools. If a model ignores native calls, set **Tool calling → JSON
fallback only** in Settings. FoxAgent will then read a single fenced JSON block
such as:

````markdown
```json
{"tool": "page.read", "args": {"maxChars": 8000}}
```
````

If the server is on another machine, replace `localhost` with its LAN address
and make sure the server listens on all interfaces. If it is reachable from the
internet, anyone who can reach it can use your model; keep it on localhost or a
trusted network.

## Use it

Open a page and ask in the sidebar:

- “Summarize this page and list the three claims I should verify.”
- “Extract this article to Markdown and save it.”
- “Find the syllabus PDF on this site and download it.”
- “Check my open tabs and tell me what I am working on.”
- “Build my Canvas weekly digest.” (see [docs/CANVAS.md](docs/CANVAS.md))
- “Download every file in every module of my active Canvas courses.”

The **Tasks** tab has the same jobs as one-click recipes. They are ordinary
prompts, so the agent can adapt them and ask follow-up questions.

### Tools the agent can use

| Tool | What it does | Risk |
| --- | --- | --- |
| `page.read` | Main page content as Markdown | read |
| `page.snapshot` | Headings and controls with stable refs (`e12`) | read |
| `page.links` | Links with text and absolute URLs | read |
| `page.fetch` | Same-origin HTTP request with the tab's cookies | read, or act for non-GET |
| `page.fetchAll` | Paginated JSON collection via `Link: rel="next"` | read |
| `web.fetch` | Public URL without cookies or JavaScript | read |
| `browser.tabs` | List open tabs | read |
| `page.click` / `page.type` / `page.select` / `page.scroll` | Operate the page | act |
| `browser.open` / `browser.switch` / `browser.close` | Manage tabs | act |
| `browser.download` / `browser.downloadMany` | Download files into `Downloads/FoxAgent/...` | write |
| `files.write` | Save Markdown/JSON/CSV through the download system | write |
| `task.note` | Add a line to the scratchpad shown on every turn | read |
| `ui.ask` | Ask you a question in the sidebar and wait | read |

The agent is instructed to prefer a site's own API over clicking. A same-origin
`page.fetch` carries the session cookies for the tab's origin, so Canvas and
similar apps work without storing credentials in FoxAgent.

## Safety model

- **Risk levels.** Every tool is `read`, `act`, or `write`. The Settings panel
  decides whether each level runs automatically or asks first. `page.fetch`
  becomes `act` when the method is not GET/HEAD.
- **Approvals.** A prompt shows the tool, arguments and host. “Always here” adds
  the host to trusted sites. A denial is reported back to the model, which is
  told not to retry it.
- **Dry run.** The switch in the composer describes `act`/`write` calls without
  performing them.
- **Site allowlist.** When non-empty, every host involved in a call must match.
  A `browser.downloadMany` batch is checked file by file. Subdomains match their
  parent entry (`school.edu` covers `canvas.school.edu`).
- **Blocked by default.** Password fields are never typed into. The prompt
  forbids purchases, sending messages, submitting assignments, account changes,
  bypassing paywalls/CAPTCHA/DRM, and following instructions found in page
  content.
- **Prompt injection.** Page text, API responses and tool output are treated as
  data. Injected instructions are reported, not followed.
- **Audit trail.** Every tool call is logged locally with arguments, host,
  timing, and errors. The Activity tab can export it as NDJSON. The log is
  capped at 400 entries.
- **Abort.** Stop cancels the model request and settles any pending approval or
  question, so the agent never hangs waiting for a closed sidebar.

## Privacy and permissions

Settings, conversation history, scratchpad and the audit log are stored in
`browser.storage.local`, inside this Firefox profile. Nothing is synchronized.
API keys are stored there too, in plain text inside the profile. The sidebar only
receives a `hasKey` flag and a masked suffix such as `••••1a2b`; the raw key is
used by the background page when it calls that provider. Leave the key empty for
local servers that do not need one.

Cloud providers are a deliberate exception to local-only operation: FoxAgent
sends your prompts, page excerpts and tool results directly to the provider you
selected, using your key. The provider's terms and privacy policy apply, and
usage is billed to your account. Switch back to a local server at any time in
Models.

| Permission | Why |
| --- | --- |
| `tabs` | Find the active tab, list tabs, follow navigation. |
| `scripting` | Inject the page bridge on demand. |
| `storage` | Keep settings, session and log locally. |
| `downloads` | Save files and reports. |
| `activeTab` | Act on the tab the user invoked FoxAgent from. |
| `<all_urls>` host permission | Read and operate any http(s) page the user chooses. |

The broad host permission is a deliberate v0.1 tradeoff: a general browser agent
cannot know in advance which sites you will ask about, and `page.fetch` must run
in the page's origin to carry its session. The site allowlist narrows what the
agent may act on. A later release can move to optional per-site permissions and
request them when a task names a new host; see [docs/DESIGN.md](docs/DESIGN.md).

The extension itself never uploads anything on its own. Page excerpts and tool
results are sent only to the provider you configure in Models. Pointing that at a
local server keeps page data on your machine or network; choosing a cloud
provider sends it to that third party. There is no FoxAgent relay in between.

## Files and folders

Downloads default to `Downloads/FoxAgent/`:

```
FoxAgent/
  Canvas/
    Biology 101/
      Module 1 - Introduction/
        syllabus.pdf
    manifest-2026-10-27.json
  markdown/
    example.com-article-2026-10-27.md
  reports/
    canvas-weekly.md
  logs/
    foxagent-log-2026-10-27.jsonl
```

Filenames are sanitized (no `..`, control characters, or reserved punctuation),
long paths are capped, and a duplicate download is renamed by Firefox
(`conflictAction: "uniquify"`). `browser.downloadMany` accepts at most 200 files
per call; `files.write` caps content at 4 MB.

## Limits

- PDFs and Office documents are not parsed. FoxAgent can download them or open
  them in a tab for you to read, and it says so instead of inventing content.
- `web.fetch` has no cookies and no JavaScript, so it cannot read logged-in
  pages. Use a real tab for those.
- Cross-origin `page.fetch` is subject to CORS and may lack cookies.
- Canvas API access can be blocked by an institution. The fallback is UI control,
  which is slower and more fragile.
- The sidebar controls one conversation at a time. A second request is refused
  while a turn is running.
- Cloud providers can hit rate limits, quotas or billing limits. The error names
  the provider and usually points at the key or quota; FoxAgent cannot top up an
  account.
- Firefox-only. The manifest and APIs are not compatible with Chromium as-is.

## Development

```bash
# Syntax check every module (Node sees .js as CommonJS without a package.json)
for f in $(find src -name '*.js'); do cp "$f" "/tmp/$(basename "$f").mjs"; node --check "/tmp/$(basename "$f").mjs"; done

# Lint and package
npx --yes web-ext@8 lint --output text
npx --yes web-ext@8 build --overwrite-dest
```

Source layout and design notes are in [docs/DESIGN.md](docs/DESIGN.md). The Canvas
playbook, endpoints and download workflow are in [docs/CANVAS.md](docs/CANVAS.md).

## Status

Version 0.1.0. It is usable for reading, extraction, page actions and the Canvas
recipes, but treat downloads and long tasks as supervised work: keep the sidebar
open, watch the first run on a new site, and use dry run when trying a new recipe.

Roadmap: optional per-site permissions, PDF text extraction, saved task history,
profile-specific model settings, per-provider token budgets, parallel tab
reading, and a committed test suite for the protocol and Canvas parsing.
