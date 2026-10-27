<p align="center">
  <img src="icons/fox-96.png" alt="FoxAgent" width="96" height="96">
  <h1 align="center">FoxAgent</h1>
  <p align="center"><strong>A browser agent in your Firefox sidebar.</strong> Read pages, drive the UI, and run tasks -- with a local model or your own cloud API key.</p>
</p>

<p align="center">
  <a href="https://github.com/D5-Interactive/FoxAgent/releases/latest"><img alt="Latest Release" src="https://img.shields.io/github/v/release/D5-Interactive/FoxAgent?label=release&style=flat"></a>
  <a href="https://github.com/D5-Interactive/FoxAgent/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/D5-Interactive/FoxAgent?style=flat"></a>
  <a href="https://github.com/D5-Interactive/FoxAgent/issues"><img alt="Issues" src="https://img.shields.io/github/issues/D5-Interactive/FoxAgent?style=flat"></a>
  <img alt="Firefox" src="https://img.shields.io/badge/Firefox-115%2B-orange?style=flat&logo=firefox-browser">
  <img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-blue?style=flat">
</p>

---

## Why FoxAgent?

**You are already in the browser.** FoxAgent lives in the sidebar, sees the page you are on, and acts on it -- click, type, scroll, fetch APIs, download files. No context switching, no copy-paste, no "describe what you see."

**Your model, your rules.** Run a local model (LM Studio, Ollama, vLLM, llama.cpp) and your data never leaves the machine. Or add an API key for OpenAI, Anthropic, OpenRouter, DeepSeek, Groq, Mistral, Gemini, or xAI -- keys stay in your Firefox profile, never shown in the UI.

**Built for real work.** Approve every action, dry-run first, restrict which sites can be acted on, and keep an audit log of everything. Canvas weekly digests, bulk course-material downloads, page-to-Markdown extraction, tab digests -- all included as one-click tasks.

---

## Features at a glance

| | |
|---|---|
| **Model freedom** | 5 local runtimes + 8 cloud providers behind one model picker |
| **Your keys, your profile** | API keys stored in browser.storage.local, masked in UI, used only by the background page |
| **Safety first** | Per-action approvals, dry-run mode, site allowlist, trusted sites, audit log, no password/payment automation |
| **Page to Markdown** | Clean article extraction, saved as .md files you keep |
| **Canvas recipes** | Weekly assignments, grades, course briefings, bulk material downloads -- all from your logged-in Canvas tab |
| **Task library** | Page audit, document review, tab digest, and more -- run with one click |
| **History and notes** | Conversation transcript, scratchpad, and exportable activity log |
| **Light and night UI** | Monochrome white-on-black styling with a moon toggle for the near-black variant, remembered per profile |

---

## Quick start

### 1. Install (Firefox 115+)

**Option A -- From release (recommended)**
1. Download the latest foxagent-<version>.zip from Releases
2. Extract it
3. Open about:debugging#/runtime/this-firefox
4. Load Temporary Add-on... -> select manifest.json

**Option B -- From source**
```bash
git clone https://github.com/D5-Interactive/FoxAgent.git
cd FoxAgent
# Open about:debugging -> Load Temporary Add-on... -> manifest.json
```

### 2. Pick a model

Click the **Models** tab (or the model button in the top bar).

| Provider | Type | Setup |
|---|---|---|
| LM Studio | Local | Start server, load a tool-capable model |
| Ollama | Local | ollama serve + pull a tool model (e.g. qwen2.5:7b) |
| vLLM | Local | --enable-auto-tool-choice with your parser |
| llama.cpp | Local | llama-server --jinja with a tool-capable GGUF |
| **OpenAI / GPT** | Cloud | Paste key from platform.openai.com/api-keys |
| **Anthropic / Claude** | Cloud | Paste key from console.anthropic.com/settings/keys |
| **OpenRouter** | Cloud | One key for many models (some free) |
| **DeepSeek, Groq, Mistral, Gemini, xAI** | Cloud | Add key, detect, pick model |

> **Local = private.** Page text, prompts, and tool results go only to your local server.
>
> **Cloud = your key, their terms.** Data is sent to the provider and billed to your account. FoxAgent is just the bridge.

### 3. Start working

- **Chat** -- Ask about the current page, run a task, approve actions as they come
- **Tasks** -- One-click recipes: Canvas weekly, grades, materials, page audit, tab digest...
- **Activity** -- Audit log of every tool call, approval, and result

---

## Model recommendations

| Use case | Local (7B+) | Cloud |
|---|---|---|
| General chat + tools | Qwen2.5-7B-Instruct, Llama-3.1-8B-Instruct | GPT-4o-mini, Claude Haiku 4.5, DeepSeek Chat |
| Reasoning-heavy | Qwen2.5-14B/32B, Nemotron-3-Ultra | o4-mini, Claude Sonnet 4.5, DeepSeek Reasoner |
| Speed / throughput | Llama-3.1-8B (quantized), Gemma-2-9B | Groq (Llama-3.3-70B), GPT-4.1-mini |

> Smaller local models (<=7B) often ignore native tool calls. Enable Settings -> Tool calling -> JSON fallback only if needed.

---

## Privacy and permissions

| What | Where it goes |
|---|---|
| Settings, history, notes, audit log | browser.storage.local (your Firefox profile) |
| API keys | Same profile, plain text -- protect your profile like a password manager |
| Page content and prompts | Only to the provider you select in Models |
| Cloud provider traffic | Direct from Firefox to the provider -- no FoxAgent relay |

FoxAgent requests <all_urls> to read the active tab. The site allowlist and per-action approvals are your control surface.

---

## What's in the box

```
FoxAgent/
├── manifest.json              # MV3, sidebar_action, permissions
├── icons/                     # 16/32/48/96px
├── src/
│   ├── background/
│   │   ├── main.js            # Routing, approvals, model cache, key masking
│   │   ├── agent.js           # Tool loop, compaction, protocol
│   │   ├── providers.js       # OpenAI + Anthropic adapters
│   │   ├── tools.js           # 19 tools (page.*, browser.*, task.*)
│   │   ├── prompt.js          # System prompt
│   │   ├── recipes.js         # Canvas + page tasks
│   │   └── store.js           # Settings + session persistence
│   ├── content/
│   │   └── agent.js           # Page bridge (snapshot, read, click, fetch...)
│   └── sidebar/
│       ├── sidebar.html       # Chat / Tasks / Activity / Models panels
│       ├── sidebar.js         # UI logic (no innerHTML)
│       └── sidebar.css        # Responsive, themed
└── docs/
    ├── DESIGN.md              # Architecture, safety boundaries
    └── CANVAS.md              # Canvas workflow playbook
```

---

## Development

```bash
# Lint (must stay at 0 errors / 0 warnings)
npx web-ext@8 lint

# Syntax check
for f in src/background/*.js src/sidebar/*.js src/content/*.js; do
  node --check "$f"
done

# Provider protocol tests
node /tmp/opencode/providers.test.mjs

# Build
npx web-ext@8 build --overwrite-dest
```

---

## Roadmap

- Per-site permissions (beyond the global allowlist)
- PDF text extraction
- Saved task history and re-runs
- Per-profile model settings
- Parallel tab reading
- Committed test suite for protocol and Canvas parsing

---

## License

MIT -- see LICENSE. No warranty. Use at your own risk.

---

<p align="center">
  <strong>Built for people who live in the browser.</strong><br>
  <a href="https://github.com/D5-Interactive/FoxAgent/issues">Report a bug</a> *
  <a href="https://github.com/D5-Interactive/FoxAgent/discussions">Request a feature</a> *
  <a href="https://github.com/D5-Interactive/FoxAgent/releases">Download</a>
</p>