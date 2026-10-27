/*
 * Tool registry. Every capability the model can use is declared here with its
 * JSON schema, a risk level, and a plain function. Risk drives user approval:
 *   read  - reads the page / network, no side effects
 *   act   - changes the page or browser state
 *   write - writes files to disk or downloads from the network
 */

import { callPage, resolveTab, waitForLoad } from "./page.js";
import { addNote } from "./store.js";

const MAX_TOOL_CHARS = 24000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clip(value, max = MAX_TOOL_CHARS) {
  const s = String(value ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n[truncated: ${s.length - max} more characters. Narrow the request (pick, selector, filter) if you need the rest.]`;
}

function json(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 1);
}

function safeFilename(name, fallback = "FoxAgent/download") {
  const parts = String(name || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim())
    .filter((p) => p && p !== "." && p !== "..");
  const out = parts.join("/").slice(0, 220);
  return out || fallback;
}

function nextLink(header) {
  if (!header) return "";
  for (const part of String(header).split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (m) return m[1];
  }
  return "";
}

function getPath(obj, path) {
  return String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function project(value, paths) {
  if (!paths?.length) return value;
  const one = (o) => {
    if (!o || typeof o !== "object") return o;
    const out = {};
    for (const p of paths) {
      const v = getPath(o, p);
      if (v !== undefined) out[String(p).split(".").pop()] = v;
    }
    return out;
  };
  return Array.isArray(value) ? value.map(one) : one(value);
}

function packRows(rows, pick, maxChars) {
  const lines = [];
  let used = 0;
  let omitted = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = pick?.length ? project(rows[i], pick) : rows[i];
    let line;
    try { line = JSON.stringify(row); } catch { line = String(row); }
    if (used + line.length + 1 > maxChars) { omitted = rows.length - i; break; }
    lines.push(line);
    used += line.length + 1;
  }
  return { text: lines.join("\n"), count: lines.length, omitted };
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname + u.search;
  } catch {
    return url;
  }
}

function formatRate(rate) {
  if (!rate) return "";
  const bits = [];
  if (rate.remaining != null) bits.push(`rate remaining: ${rate.remaining}`);
  if (rate.reset != null) bits.push(`reset: ${rate.reset}`);
  if (rate.retryAfter != null) bits.push(`retry after: ${rate.retryAfter}s`);
  return bits.length ? ` (${bits.join(", ")})` : "";
}

async function pageFor(args, ctx) {
  const tab = await resolveTab(args.tabId);
  ctx.activeTab = tab;
  return tab;
}

function requireHttp(url, what = "URL") {
  let u;
  try { u = new URL(String(url)); } catch { throw new Error(`${what} is not a valid URL: ${url}`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`${what} must start with http:// or https://`);
  return u;
}

export const TOOLS = [
  {
    name: "page.read",
    description:
      "Read the visible main content of a tab and return it as Markdown. Use this to understand an article, Canvas page, documentation, or document. Falls back to the whole body when no article container is found. Prefer this over snapshot when you need text, not controls.",
    risk: "read",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "integer", description: "Tab id from browser.tabs. Omit for the active tab." },
        selector: { type: "string", description: "Optional CSS selector to read only that subtree." },
        maxChars: { type: "integer", description: "Character cap, 1000-60000. Default from settings." },
      },
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      const res = await callPage(tab, "read", {
        selector: args.selector,
        maxChars: args.maxChars ?? ctx.settings.maxPageChars,
      });
      if (!res.markdown) {
        return `The page has no readable text in the main container (it may be a JavaScript app or a PDF).\nURL: ${res.url}\nTry page.snapshot to see the controls, or scroll and read again.`;
      }
      return clip(
        `TITLE: ${res.title}\nURL: ${res.url}\nWORDS: ${res.words}${res.truncated ? " (truncated)" : ""}\n\n${res.markdown}`
      );
    },
  },
  {
    name: "page.snapshot",
    description:
      "Outline a tab: headings plus every clickable or editable element with a stable ref (e12). Use the refs with page.click, page.type and page.select. Always snapshot before interacting, and again after the page changes.",
    risk: "read",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        maxElements: { type: "integer", description: "20-400, default 200." },
      },
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      const res = await callPage(tab, "snapshot", { maxElements: args.maxElements });
      const parts = [
        `TITLE: ${res.title}`,
        `URL: ${res.url}`,
        res.outline.length ? `PAGE OUTLINE:\n${res.outline.join("\n")}` : "",
        res.elements.length
          ? `INTERACTIVE ELEMENTS (${res.elements.length} of ${res.total}):\n${res.elements.join("\n")}`
          : "No interactive elements found. The page may still be loading.",
      ];
      return clip(parts.filter(Boolean).join("\n\n"));
    },
  },
  {
    name: "page.links",
    description: "List the links on a tab (text + absolute URL). Useful for finding materials, citations, or pages to check. Optional case-insensitive regex filter.",
    risk: "read",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        filter: { type: "string", description: "Regex matched against URL and link text, e.g. \"pdf|syllabus\"." },
        limit: { type: "integer", description: "5-500, default 200." },
      },
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      let res;
      try {
        res = await callPage(tab, "links", { filter: args.filter, limit: args.limit });
      } catch (e) {
        if (/Invalid regular expression/i.test(e.message)) throw new Error(`Bad filter regex: ${args.filter}`);
        throw e;
      }
      if (!res.links.length) return `No links matched on ${res.url}.`;
      return clip(`LINKS on ${res.url} (${res.links.length}):\n` + res.links.map((l) => `- ${l.text || "(no text)"} — ${l.href}`).join("\n"));
    },
  },
  {
    name: "page.click",
    description: "Click an element by its ref from the latest page.snapshot. Use this for navigation, opening menus, expanding sections, and submitting buttons. After clicking, snapshot again to see what changed.",
    risk: "act",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref such as e12." },
        tabId: { type: "integer" },
      },
      required: ["ref"],
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      const before = tab.url;
      const beforeIds = new Set((await browser.tabs.query({})).map((t) => t.id));
      const res = await callPage(tab, "click", { ref: args.ref });
      await sleep(900);
      const after = await browser.tabs.get(tab.id).catch(() => tab);
      const navigated = after.url !== before;
      const opened = (await browser.tabs.query({}))
        .filter((t) => !beforeIds.has(t.id) && t.openerTabId === tab.id)
        .slice(0, 3);
      const parts = [`Clicked ${res.ref} ${JSON.stringify(res.label)}.`];
      if (navigated) parts.push(`The page navigated to ${after.url}. Snapshot or read again before the next action.`);
      if (opened.length) {
        const list = opened.map((t) => `[${t.id}] ${t.title || ""} — ${t.url || ""}`).join("; ");
        parts.push(`The click opened a new tab: ${list}. Use that tabId with page tools; do not assume the old page changed.`);
      }
      if (!navigated && !opened.length) parts.push("If the page changed, take a new snapshot before using refs.");
      return parts.join("\n");
    },
  },
  {
    name: "page.type",
    description: "Type into a text field, textarea or contenteditable element by ref. Replaces the content by default. Set submit=true to press Enter or submit the form. Never works on password fields.",
    risk: "act",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean", description: "Submit the form or press Enter after typing." },
        clear: { type: "boolean", description: "false appends instead of replacing." },
        tabId: { type: "integer" },
      },
      required: ["ref", "text"],
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      const res = await callPage(tab, "type", {
        ref: args.ref,
        text: args.text,
        submit: Boolean(args.submit),
        clear: args.clear !== false,
      });
      await sleep(args.submit ? 800 : 150);
      return `Typed ${res.valueLength} characters into ${args.ref}${res.submitted ? " and submitted" : ""}. ${res.submitted ? "Snapshot again to check the result." : ""}`.trim();
    },
  },
  {
    name: "page.select",
    description: "Choose an option in a <select> dropdown by ref. Accepts the option value or its visible label.",
    risk: "act",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string" },
        value: { type: "string" },
        tabId: { type: "integer" },
      },
      required: ["ref", "value"],
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      const res = await callPage(tab, "select", { ref: args.ref, value: args.value });
      return `Selected ${JSON.stringify(res.label)} (value ${JSON.stringify(res.value)}) in ${args.ref}.`;
    },
  },
  {
    name: "page.scroll",
    description: "Scroll a tab up or down, or bring an element into view. Use on infinite-scroll lists before reading or snapshotting again.",
    risk: "read",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["down", "up"] },
        amount: { type: "integer", description: "Pixels, 100-5000, default 700." },
        ref: { type: "string", description: "Scroll this element into view instead." },
        tabId: { type: "integer" },
      },
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      const res = await callPage(tab, "scroll", args);
      await sleep(400);
      return args.ref
        ? `Scrolled ${args.ref} into view.`
        : `Scrolled ${res.scrolledBy > 0 ? "down" : "up"} to y=${res.y} of ${res.height}.`;
    },
  },
  {
    name: "page.fetch",
    description:
      "Make an HTTP request from inside a tab, using that site's cookies and session (same-origin). This is the fastest way to read a site's own JSON API, e.g. Canvas /api/v1. Returns status, Link header, rate-limit headers and the body. Use pick to keep only the fields you need.",
    risk: "read",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute path or URL, resolved against the tab." },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "Default GET." },
        body: { type: "string", description: "Raw body for POST/PUT/PATCH; JSON string." },
        headers: { type: "object", description: "Optional extra headers." },
        pick: { type: "array", items: { type: "string" }, description: "Dot paths to project from each object, e.g. [\"id\",\"name\",\"due_at\"]." },
        maxChars: { type: "integer", description: "Default 20000." },
        tabId: { type: "integer" },
      },
      required: ["url"],
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      const res = await callPage(tab, "fetch", {
        url: args.url,
        method: args.method || "GET",
        body: args.body,
        headers: args.headers,
      });
      const method = (args.method || "GET").toUpperCase();
      const head = `${method} ${shortUrl(res.url)} -> ${res.status}${res.contentType ? " " + res.contentType.split(";")[0] : ""}${formatRate(res.rate)}`;
      let body;
      if (res.json !== undefined) {
        body = json(project(res.json, args.pick));
      } else {
        body = res.text || "(empty body)";
      }
      const extra = res.link ? `\nLink: ${res.link}` : "";
      const same = res.sameOrigin ? "" : "\nNOTE: this was a cross-origin request; cookies may be missing and the server must allow CORS.";
      return clip(`${head}${extra}${same}\n\n${body}`, args.maxChars || 20000);
    },
  },
  {
    name: "page.fetchAll",
    description:
      "Fetch a paginated JSON collection using the Link rel=\"next\" header (Canvas and most REST APIs) and return one JSON object per line. Use for course lists, assignments, modules, files and enrollments. Throttles between pages.",
    risk: "read",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "First page URL, e.g. /api/v1/courses?per_page=100" },
        pick: { type: "array", items: { type: "string" }, description: "Fields to keep from each item." },
        maxPages: { type: "integer", description: "1-20, default 8." },
        maxChars: { type: "integer", description: "Default 20000." },
        tabId: { type: "integer" },
      },
      required: ["url"],
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      let url = args.url;
      let firstOrigin = "";
      try { firstOrigin = new URL(args.url, tab.url).origin; } catch {}
      const maxPages = Math.min(20, Math.max(1, Number(args.maxPages) || 8));
      const rows = [];
      let pages = 0;
      let note = "";
      const seen = new Set();
      while (url && pages < maxPages) {
        if (seen.has(url)) { note = "Pagination loop detected; stopped."; break; }
        seen.add(url);
        const res = await callPage(tab, "fetch", { url, method: "GET" });
        pages++;
        if (!res.ok) {
          note = `Stopped after ${pages} page(s): HTTP ${res.status}. ${typeof res.text === "string" ? res.text.slice(0, 300) : ""}`.trim();
          break;
        }
        if (res.json === undefined) {
          note = `Response was not JSON (${res.contentType || "unknown type"}). This API may need different headers or authentication.`;
          break;
        }
        const batch = Array.isArray(res.json)
          ? res.json
          : Array.isArray(res.json?.items) ? res.json.items
            : Array.isArray(res.json?.data) ? res.json.data
              : Array.isArray(res.json?.results) ? res.json.results
                : [res.json];
        rows.push(...batch);
        const next = nextLink(res.link);
        if (!next) break;
        let nextUrl;
        try {
          nextUrl = new URL(next, res.url || tab.url);
        } catch {
          note = "Pagination returned an invalid next link; stopped.";
          break;
        }
        if (firstOrigin && nextUrl.origin !== firstOrigin) {
          note = `Stopped pagination at a link to another origin (${nextUrl.origin}); FoxAgent only follows ${firstOrigin}.`;
          break;
        }
        url = nextUrl.href;
        await sleep(250);
      }
      if (!rows.length) return `No items returned from ${args.url}. ${note}`.trim();
      const packed = packRows(rows, args.pick, args.maxChars || 20000);
      const header = `FETCHED ${packed.count} item(s) from ${pages} page(s) for ${shortUrl(args.url)}.` +
        (packed.omitted ? ` ${packed.omitted} more item(s) did not fit; raise maxChars or narrow the pick fields.` : "") +
        (note ? `\n${note}` : "") +
        (args.pick?.length ? `\nFields: ${args.pick.join(", ")}` : "");
      return clip(`${header}\n\n${packed.text}`, (args.maxChars || 20000) + 600);
    },
  },
  {
    name: "web.fetch",
    description:
      "Fetch a public http(s) URL from the extension (no cookies, no JavaScript, no login) and return its title and readable text. Use for checking public pages or documentation without switching tabs. For logged-in pages use a tab plus page.read.",
    risk: "read",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        maxChars: { type: "integer", description: "Default 8000, max 30000." },
      },
      required: ["url"],
    },
    async run(args) {
      const u = requireHttp(args.url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      let res;
      let raw;
      try {
        res = await fetch(u.href, {
          headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0", Accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.8" },
          redirect: "follow",
          credentials: "omit",
          signal: controller.signal,
        });
        raw = (await res.text()).slice(0, 600000);
      } catch (e) {
        if (e?.name === "AbortError") throw new Error(`Timed out after 20s fetching ${u.href}.`);
        throw new Error(`Could not fetch ${u.href}: ${e.message}`);
      } finally {
        clearTimeout(timer);
      }
      const ct = res.headers.get("content-type") || "";
      const max = Math.min(30000, Math.max(1000, Number(args.maxChars) || 8000));
      if (/json/i.test(ct)) {
        let pretty = raw;
        try { pretty = JSON.stringify(JSON.parse(raw), null, 1); } catch {}
        return clip(`${u.href} -> ${res.status} (json, no cookies)\n\n${pretty}`, max);
      }
      if (!/html?/i.test(ct)) {
        return clip(`${u.href} -> ${res.status} ${ct}\n\n${raw}`, max);
      }
      let title = "";
      let text = "";
      try {
        const doc = new DOMParser().parseFromString(raw, "text/html");
        title = doc.title || "";
        for (const el of doc.querySelectorAll("script,style,noscript,svg,nav,footer,aside,template")) el.remove();
        text = (doc.body?.innerText || doc.body?.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
      } catch {
        text = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
      return clip(`${u.href} -> ${res.status} (text snapshot, no cookies)\nTITLE: ${title}\n\n${text}`, max);
    },
  },
  {
    name: "browser.tabs",
    description: "List open tabs with their ids, titles and URLs. Use this to find the Canvas tab, or pages to read and compare.",
    risk: "read",
    parameters: { type: "object", properties: {} },
    async run() {
      const tabs = await browser.tabs.query({});
      const lines = tabs.map((t) => `[${t.id}]${t.active ? " *active*" : ""} ${t.title || "(no title)"} — ${t.url || ""}`);
      return clip(`OPEN TABS (${tabs.length}):\n${lines.join("\n")}`, 8000);
    },
  },
  {
    name: "browser.open",
    description: "Open a URL in a new tab and wait for it to load. Use this when a task needs a different site than the active tab. Returns the new tab id for page.read/page.snapshot.",
    risk: "act",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        active: { type: "boolean", description: "Focus the new tab. Default true." },
      },
      required: ["url"],
    },
    async run(args) {
      const u = requireHttp(args.url);
      const tab = await browser.tabs.create({ url: u.href, active: args.active !== false });
      const loaded = await waitForLoad(tab.id);
      return `Opened tab [${loaded.id}] ${loaded.title || ""} — ${loaded.url}`;
    },
  },
  {
    name: "browser.switch",
    description: "Make an existing tab active in its window. Use when the user needs to see or interact with a page, or before a page action that only works on the visible tab.",
    risk: "act",
    parameters: {
      type: "object",
      properties: { tabId: { type: "integer" } },
      required: ["tabId"],
    },
    async run(args) {
      const tab = await browser.tabs.get(Number(args.tabId));
      await browser.tabs.update(tab.id, { active: true });
      await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
      return `Switched to [${tab.id}] ${tab.title || ""} — ${tab.url}`;
    },
  },
  {
    name: "browser.close",
    description: "Close a tab by id. Use for cleanup after reading pages you opened. Do not close tabs the user opened unless asked.",
    risk: "act",
    parameters: {
      type: "object",
      properties: { tabId: { type: "integer" } },
      required: ["tabId"],
    },
    async run(args) {
      const tab = await browser.tabs.get(Number(args.tabId));
      await browser.tabs.remove(tab.id);
      return `Closed tab [${tab.id}] ${tab.title || ""}.`;
    },
  },
  {
    name: "browser.download",
    description: "Download one file to the user's Downloads folder. The URL must be an http(s) URL; cookies are sent as usual. Give a full relative path such as FoxAgent/Canvas/Biology/week1/lecture.pdf.",
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        filename: { type: "string" },
      },
      required: ["url", "filename"],
    },
    async run(args) {
      const u = requireHttp(args.url);
      const filename = safeFilename(args.filename);
      const id = await browser.downloads.download({ url: u.href, filename, conflictAction: "uniquify", saveAs: false });
      return `Download started: ${filename} (download id ${id}).`;
    },
  },
  {
    name: "browser.downloadMany",
    description:
      "Download many files in one approved batch (up to 200). Use after building a manifest, and include the course/module in each filename. Returns per-file queued/failed status. This is the correct tool for \"download every material in every module\".",
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        files: {
          type: "array",
          description: "Files to download.",
          items: {
            type: "object",
            properties: { url: { type: "string" }, filename: { type: "string" } },
            required: ["url", "filename"],
          },
        },
      },
      required: ["files"],
    },
    async run(args, ctx) {
      const files = Array.isArray(args.files) ? args.files.slice(0, 200) : [];
      if (!files.length) throw new Error("No files provided.");
      const prepared = [];
      const skipped = [];
      for (const f of files) {
        try {
          requireHttp(f.url, "File URL");
          prepared.push({ url: new URL(f.url).href, filename: safeFilename(f.filename, "FoxAgent/download") });
        } catch (e) {
          skipped.push(`${f.filename || f.url}: ${e.message}`);
        }
      }
      const results = [];
      let ok = 0;
      for (let i = 0; i < prepared.length; i += 4) {
        const batch = prepared.slice(i, i + 4);
        const settled = await Promise.allSettled(batch.map((f) =>
          browser.downloads.download({ url: f.url, filename: f.filename, conflictAction: "uniquify", saveAs: false })
        ));
        settled.forEach((s, j) => {
          if (s.status === "fulfilled") {
            ok++;
            results.push(`ok   ${batch[j].filename} (id ${s.value})`);
          } else {
            results.push(`FAIL ${batch[j].filename}: ${s.reason?.message || s.reason}`);
          }
        });
      }
      const lines = [
        `Queued ${ok} of ${files.length} download(s)${files.length > 200 ? " (capped at 200 per call)" : ""}.`,
        ...results.slice(0, 200),
        ...skipped.map((s) => `SKIP ${s}`),
      ];
      return clip(lines.join("\n"), 14000);
    },
  },
  {
    name: "files.write",
    description: "Write a text file (Markdown, JSON, CSV) to the user's Downloads folder via a browser download. Use for reports, manifests and extracted notes. Include a path like FoxAgent/reports/canvas-weekly.md.",
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string" },
        content: { type: "string" },
        mimeType: { type: "string", description: "Default text/markdown." },
      },
      required: ["filename", "content"],
    },
    async run(args) {
      const filename = safeFilename(args.filename, "FoxAgent/note.md");
      const content = String(args.content ?? "");
      if (content.length > 4_000_000) throw new Error("File is too large (4 MB limit). Split it into parts.");
      const blob = new Blob([content], { type: args.mimeType || "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      try {
        const id = await browser.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return `Saved ${filename} (${content.length} chars, download id ${id}).`;
      } catch (e) {
        URL.revokeObjectURL(url);
        throw new Error(`Could not save file: ${e.message}`);
      }
    },
  },
  {
    name: "task.note",
    description:
      "Append a line to the task scratchpad. The scratchpad is shown to you in every request, so use it for a checklist, progress, ids, filenames and anything you must not forget during a long task. Keep it terse. It survives page loads and long conversations.",
    risk: "read",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "Short line, e.g. \"[x] course 42 modules fetched; files pending\"." } },
      required: ["text"],
    },
    async run(args, ctx) {
      const total = addNote(args.text);
      return `Noted. Scratchpad is now ${total} characters.`;
    },
  },
  {
    name: "ui.ask",
    description:
      "Ask the user a question and wait for their answer, inside the sidebar. Use when a task is ambiguous (which course? include pages or only files?), before a large download, or to request a manual step such as logging in. Do not ask trivia you can observe.",
    risk: "read",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" }, description: "Optional suggested answers." },
      },
      required: ["question"],
    },
    async run(args, ctx) {
      const answer = await ctx.ask({ question: args.question, options: args.options || [] });
      return `User answered: ${answer || "(no answer)"}`;
    },
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function findTool(name) {
  const exact = TOOL_BY_NAME.get(name);
  if (exact) return exact;
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = norm(name);
  return TOOLS.find((t) => norm(t.name) === wanted) || null;
}

export function summarizeArgs(args) {
  const entries = Object.entries(args || {}).filter(([k]) => k !== "tabId");
  if (!entries.length) return "";
  return entries
    .map(([k, v]) => {
      let s;
      if (typeof v === "string") s = v;
      else if (Array.isArray(v)) s = `${v.length} item(s)`;
      else s = JSON.stringify(v);
      s = s.replace(/\s+/g, " ");
      return `${k}=${s.length > 70 ? s.slice(0, 70) + "…" : s}`;
    })
    .join(", ");
}
