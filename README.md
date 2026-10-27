<p align="center">
  <img src="icons/fox-96.png" alt="FoxAgent" width="96" height="96">
  <h1 align="center">FoxAgent</h1>
  <p align="center"><strong>A browser agent in your Firefox sidebar.</strong> Read pages, drive the UI, and run tasks with a local model or your own cloud API key.</p>
</p>

<p align="center">
  <a href="https://github.com/D5-Interactive/FoxAgent/releases/latest"><img alt="Latest Release" src="https://img.shields.io/github/v/release/D5-Interactive/FoxAgent?label=release&style=flat"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-black.svg"></a>
  <a href="https://github.com/D5-Interactive/FoxAgent/issues"><img alt="Issues" src="https://img.shields.io/github/issues/D5-Interactive/FoxAgent?style=flat"></a>
  <img alt="Firefox" src="https://img.shields.io/badge/Firefox-115%2B-orange?style=flat&logo=firefox-browser">
  <img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-blue?style=flat">
</p>

---

## Why FoxAgent?

**You are already in the browser.** FoxAgent lives in the sidebar, sees the page you are on, and acts on it. It can click, type, scroll, call a site's API, and download files. No context switching and no copy-paste.

**Your model, your rules.** Run a local model server and your data stays on the machine. Or add an API key for a cloud provider. Keys stay in your Firefox profile and are never shown in the sidebar.

**Built for real work.** Approve every action, dry-run first, restrict which sites can be acted on, and keep an audit log. Every tab keeps its own conversation, so you can start a job on one page and work somewhere else while it runs.

**Extend it with packs.** Install site-specific tools and short playbooks from the Packs tab. A pack is a small directory, so adding support for a site is a pull request, not a fork.

---

## Features at a glance

| | |
|---|---|
| **Model freedom** | Local and cloud providers behind one model picker |
| **Your keys, your profile** | API keys stored in the Firefox profile, masked in the UI, used only by the background page |
| **Safety first** | Per-action approvals, dry-run mode, site allowlist, trusted sites, audit log, no password or payment automation |
| **Page to Markdown** | Clean article extraction, saved as Markdown files you keep |
| **Packs** | Site-specific tools and playbooks, installed per profile |
| **Task library** | Page audit, document review, tab digest, and more from one click |
| **History and notes** | Conversation transcript, scratchpad, and an exportable activity log |
| **One task per tab** | Each tab keeps its transcript, scratchpad and running task; a strip shows the rest |
| **Small-model tuned** | Compact prompts, smaller snapshots, click by text, multi-field fill, waiting, and pack shortcuts |
| **Precise page control** | CSS, text and role queries; shadow DOM and same-origin iframe traversal; form fill and key presses |
| **Vision** | Screenshot a tab and send the image to a vision model, then clear it so later steps are not charged for it |
| **Light and night UI** | Monochrome white-on-black styling with a moon toggle for the near-black variant |
| **Update checks** | Checks GitHub releases and offers the new package, with an option to check automatically |

---

## Quick start

### 1. Install (Firefox 115+)

**Option A: from a release**
1. Download the latest foxagent zip from Releases.
2. Extract it.
3. Open `about:debugging#/runtime/this-firefox`.
4. Choose Load Temporary Add-on and select `<release>.zip`.

**Option B: from source**
```bash
git clone https://github.com/D5-Interactive/FoxAgent.git
cd FoxAgent
# Open about:debugging, then Load Temporary Add-on, then <release>.zip
```

Firefox installs signed add-ons permanently. For an unsigned development build, load it as a temporary add-on.

### 2. Pick a model

Open the **Models** tab, or use the model button in the top bar.

| Provider | Type | Setup |
|---|---|---|
| LM Studio | Local | Start the local server and load a model that supports tool calls |
| Ollama | Local | Start the server, pull a tool-capable model, then detect |
| vLLM | Local | Enable automatic tool choice with the parser for your model |
| llama.cpp | Local | Start `llama-server` with the chat template enabled |
| OpenAI, Anthropic, OpenRouter, DeepSeek, Groq, Mistral, Gemini, xAI | Cloud | Save a key, detect models, pick one |

> **Local means private.** Page text, prompts and tool results go only to your local server.
>
> **Cloud means your key and their terms.** Data is sent to the provider and billed to your account. FoxAgent is only the bridge.

### 3. Start working

- **Chat**: ask about the current page, run a task, and approve actions as they come.
- **Tabs**: each tab keeps its own conversation and task. A strip under the tabs shows work still running elsewhere.
- **Packs**: install the site tools you need, such as a site API or a careful UI playbook.
- **Tasks**: one-click recipes for audits, digests and downloads.
- **Activity**: the audit log of every tool call, approval and result.

---

## Packs

Packs add tools and guidance for one site or family of sites. They ship with the extension, so installing a pack enables it for your profile. Nothing is downloaded or evaluated at runtime.

- **Canvas LMS** adds read-only course, assignment, score and module tools.
- **Gmail** and **Outlook** add careful mail playbooks: search, read, find attachments, draft and ask before sending.
- **Google Drive** adds a browse and download playbook with no delete or share actions.

The Packs tab lists what is in the build, with an icon, version, description and a Details view. **Check for new** compares the list with the `packs/` directory in this repository and marks packs that a newer release adds.

### Write a pack

Copy `packs/_template/` to `packs/<your-id>/`, then edit `pack.json`, `tools.js`, `desc.md` and `icon.svg`. Add the id to `packs/index.json`. The full format, rules and contribution notes are in [`packs/README.md`](packs/README.md).

---

## Updates

FoxAgent asks the GitHub releases page for the latest version. When a newer release exists, a banner shows the version and two actions:

- **Update** downloads the release package to `Downloads/FoxAgent/updates/` and opens the release page.
- **Close** dismisses that version.

The banner also has a checkbox to check for new releases automatically at startup. Settings has the same option plus a **Check now** button.

Firefox installs signed add-ons only, so FoxAgent cannot replace itself. Update prepares the package and opens the release page for the final step.

---

## Model guidance

| Need | Local | Cloud |
|---|---|---|
| General browsing and tool calls | A tool-capable 7B to 14B model | Any current tool-capable chat model |
| Long tasks and reasoning | A larger local model, or a reasoning model | A reasoning model from your provider |
| Fast, small machine | A 2B to 4B model with the compact profile | A small hosted model |

Smaller models get the compact prompt, a shorter step limit, smaller page reads and snapshots, click by text, and pack shortcuts. If a model ignores native tool calls, set **Tool calling** to JSON fallback in Settings.

Vision models can receive a screenshot of the tab. Set **Vision** to auto, on or off in Settings. Auto recognizes common vision families in the model id.

---

## Privacy and permissions

| What | Where it goes |
|---|---|
| Settings, tab conversations, notes, audit log | `browser.storage.local` and `browser.storage.session` in your Firefox profile |
| API keys | The same profile, unencrypted. Protect it like a password manager |
| Page content and prompts | Only to the provider you select in Models |
| Update check | GitHub receives a request for the latest release metadata |
| Pack catalog check | GitHub receives a request for `packs/index.json` |
| Cloud provider traffic | Direct from Firefox to the provider. There is no FoxAgent relay |

FoxAgent requests `<all_urls>` to read the active tab. The site allowlist and per-action approvals are the control surface.

---

## What's in the box

```
FoxAgent/
├── .github/workflows/
│   └── release.yml            # Version bump to GitHub release
├── manifest.json              # MV3, sidebar_action, permissions
├── icons/                     # 16, 32, 48 and 96 px
├── packs/                     # Site packs, catalog, SDK and template
│   ├── index.json
│   ├── canvas/                # Tools, playbook and long description
│   ├── gmail/
│   ├── outlook/
│   ├── gdrive/
│   └── _template/
├── tests/
│   ├── logic.test.mjs         # node --test checks for pure logic
│   ├── page_bridge.py         # real DOM checks with Playwright
│   └── fixtures/page.html
├── src/
│   ├── background/
│   │   ├── main.js            # Ports, per-tab routing, approvals, updates
│   │   ├── sessions.js        # One conversation per tab
│   │   ├── packs.js           # Pack catalog, modules and prompts
│   │   ├── updates.js         # GitHub release check and download
│   │   ├── agent.js           # Tool loop, compaction, small-model profile
│   │   ├── providers.js       # OpenAI and Anthropic adapters
│   │   ├── tools.js           # Core tools: read, snapshot, click, fill, wait, screenshot
│   │   ├── rows.js            # Paginated JSON helpers shared with packs
│   │   ├── hosts.js           # Host pattern matching for packs
│   │   ├── prompt.js          # Full and compact system prompts
│   │   ├── vision.js          # Model id to image support
│   │   ├── settings-guard.js  # Whitelist for sidebar settings replies
│   │   ├── recipes.js         # One-click tasks
│   │   └── store.js           # Settings and log persistence
│   ├── content/
│   │   └── agent.js           # Page bridge: snapshot, read, click, fetch
│   └── sidebar/
│       ├── sidebar.html       # Chat, Tasks, Packs, Activity, Models
│       ├── sidebar.js         # UI logic, no innerHTML
│       └── sidebar.css        # Responsive, themed
└── docs/
    └── DESIGN.md              # Architecture and safety boundaries
```

---

## Releases

Version bumps are released by CI. Change `version` in `manifest.json`, commit and push to `main`. The workflow in `.github/workflows/release.yml` checks that the version increased, runs the syntax, logic and lint checks, builds the package, creates the `v<version>` tag and publishes a GitHub release with the zip attached. Running the workflow manually from the Actions tab releases the current version. Existing tags are skipped, so a re-run is safe.

---

## Development

```bash
# Lint (must stay at 0 errors and 0 warnings)
npx web-ext@8 lint --ignore-files "tests/**" --ignore-files ".github/**" --ignore-files ".opencode/**"

# Syntax check
for f in src/background/*.js src/sidebar/*.js src/content/*.js packs/*.js packs/*/*.js; do
  node --check "$f"
done

# Logic tests
node --test tests/logic.test.mjs

# Page bridge tests (Playwright)
uv run --with playwright python tests/page_bridge.py

# Build
npx web-ext@8 build --overwrite-dest --ignore-files "tests/**" --ignore-files ".github/**" --ignore-files ".opencode/**"
```

---

## Roadmap

- Per-site permissions instead of a global allowlist
- PDF text extraction
- Saved task history and re-runs
- Per-profile model settings
- More packs, with a community index
- A headless browser test for the sidebar

---

## License

MIT. See [LICENSE](LICENSE). No warranty. Use at your own risk.

---

<p align="center">
  <strong>Built for people who live in the browser.</strong><br>
  <a href="https://github.com/D5-Interactive/FoxAgent/issues">Report a bug</a> *
  <a href="https://github.com/D5-Interactive/FoxAgent/discussions">Request a feature</a> *
  <a href="https://github.com/D5-Interactive/FoxAgent/releases">Download</a>
</p>
