import { callPage, resolveTab, waitForLoad } from "./page.js";
import { addNote } from "./sessions.js";
import { fetchAllRows, lines, project } from "./rows.js";
const MAX_TOOL_CHARS = 24e3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function clip(value, max = MAX_TOOL_CHARS) {
  const s = String(value ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + `

[truncated: ${s.length - max} more characters. Narrow the request (pick, selector, filter) if you need the rest.]`;
}
function json(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 1);
}
function safeFilename(name, fallback = "FoxAgent/download") {
  const parts = String(name || "").replace(/\\/g, "/").split("/").map((p) => p.replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim()).filter((p) => p && p !== "." && p !== "..");
  const out = parts.join("/").slice(0, 220);
  return out || fallback;
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
  const tab = await resolveTab(args.tabId, ctx.session?.tabId);
  ctx.activeTab = tab;
  return tab;
}
function requireHttp(url, what = "URL") {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new Error(`${what} is not a valid URL: ${url}`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`${what} must start with http:// or https://`);
  return u;
}
async function pageChange(after, beforeUrl, tabId) {
  const bits = [];
  if (after?.url && after.url !== beforeUrl) bits.push(`navigated to ${after.url}`);
  if (after?.title) bits.push(`title: ${after.title}`);
  try {
    const tabs = await browser.tabs.query({});
    const opened = tabs.filter((t) => t.openerTabId === tabId && t.id !== tabId).slice(0, 3);
    if (opened.length) bits.push(`opened: ${opened.map((t) => `[${t.id}] ${t.title || t.url}`).join("; ")}`);
  } catch {
  }
  return bits.length ? `Page now: ${bits.join("; ")}.` : "No navigation detected; snapshot again if the page changed.";
}
const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;
const META_HOST = /(^|\.)(metadata\.google\.internal|instance-data)$/i;
function requirePublicUrl(url) {
  const u = requireHttp(url);
  if (PRIVATE_HOST.test(u.hostname) || META_HOST.test(u.hostname)) {
    throw new Error("web.fetch refuses local and link-local addresses. Read local pages in a tab instead (page.read), where the user's session is already trusted.");
  }
  return u;
}
const TOOLS = [
  {
    name: "page.read",
    description: "Read the visible main content of a tab and return it as Markdown. Use this to understand an article, Canvas page, documentation, or document. Falls back to the whole body when no article container is found, and includes open shadow roots and same-origin iframes. Prefer this over snapshot when you need text, not controls.",
    risk: "read",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "integer", description: "Tab id from browser.tabs. Omit for the active tab." },
        selector: { type: "string", description: "Optional CSS selector to read only that subtree." },
        maxChars: { type: "integer", description: "Character cap, 1000-60000. Default from settings." }
      }
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      const cap = ctx.small ? Math.min(6e3, ctx.settings.maxPageChars) : ctx.settings.maxPageChars;
      const res = await callPage(tab, "read", {
        selector: args.selector,
        maxChars: args.maxChars ?? cap
      });
      if (!res.markdown) {
        return `The page has no readable text in the main container (it may be a JavaScript app or a PDF).
URL: ${res.url}
Try page.snapshot to see the controls, or scroll and read again.`;
      }
      return clip(
        `TITLE: ${res.title}
URL: ${res.url}
WORDS: ${res.words}${res.truncated ? " (truncated)" : ""}

${res.markdown}`
      );
    }
  },
  {
    name: "page.snapshot",
    description: "Outline a tab: headings plus every clickable or editable element with a stable ref (e12), including open shadow roots and same-origin iframes. Use the refs with page.click, page.type and page.select. Always snapshot before interacting, and again after the page changes.",
    risk: "read",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        maxElements: { type: "integer", description: "20-400, default 200." }
      }
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      const maxElements = args.maxElements ?? (ctx.small ? 60 : 200);
      const res = await callPage(tab, "snapshot", { maxElements });
      const parts = [
        `TITLE: ${res.title}`,
        `URL: ${res.url}`,
        res.outline.length ? `PAGE OUTLINE:
${res.outline.join("\n")}` : "",
        res.elements.length ? `INTERACTIVE ELEMENTS (${res.elements.length} of ${res.total}):
${res.elements.join("\n")}` : "No interactive elements found. The page may still be loading."
      ];
      return clip(parts.filter(Boolean).join("\n\n"));
    }
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
        filter: { type: "string", description: 'Regex matched against URL and link text, e.g. "pdf|syllabus".' },
        limit: { type: "integer", description: "5-500, default 200." }
      }
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
      return clip(`LINKS on ${res.url} (${res.links.length}):
` + res.links.map((l) => `- ${l.text || "(no text)"} \u2014 ${l.href}`).join("\n"));
    }
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
        tabId: { type: "integer" }
      },
      required: ["ref"]
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      const before = tab.url;
      const res = await callPage(tab, "click", { ref: args.ref });
      await sleep(900);
      const after = await browser.tabs.get(tab.id).catch(() => tab);
      return `Clicked ${res.ref} ${JSON.stringify(res.label)}. ${await pageChange(after, before, tab.id)}`;
    }
  },
  {
    name: "page.clickText",
    description: 'Click the first visible button or link whose text matches, without a snapshot or ref. This is the most reliable way for small models to click "Sign in", "Next", "Submit" or a menu item.',
    risk: "act",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: 'Visible label, e.g. "Next" or "Download all".' },
        exact: { type: "boolean", description: "Require the whole label to match. Default false." },
        tabId: { type: "integer" }
      },
      required: ["text"]
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      const before = tab.url;
      const res = await callPage(tab, "clickText", { text: args.text, exact: Boolean(args.exact) });
      await sleep(900);
      const after = await browser.tabs.get(tab.id).catch(() => tab);
      return `Clicked ${res.ref} ${JSON.stringify(res.label)}. ${await pageChange(after, before, tab.id)}`;
    }
  },
  {
    name: "page.clickAt",
    description: "Click at viewport coordinates from your most recent screenshot. Use only when a control has no usable label; prefer page.clickText.",
    risk: "act",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        x: { type: "integer", description: "X in the screenshot, from the left edge." },
        y: { type: "integer", description: "Y in the screenshot, from the top edge." },
        tabId: { type: "integer" }
      },
      required: ["x", "y"]
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      const before = tab.url;
      const res = await callPage(tab, "clickAt", { x: args.x, y: args.y });
      await sleep(700);
      const after = await browser.tabs.get(tab.id).catch(() => tab);
      return `Clicked ${res.ref} <${res.tag}> ${JSON.stringify(res.label)} at ${res.x},${res.y}. ${await pageChange(after, before, tab.id)}`;
    }
  },
  {
    name: "page.query",
    description: "Find controls precisely: by CSS selector, visible text, or ARIA role. Returns refs, labels, values and positions. Use when a snapshot is too large or you need every match.",
    risk: "read",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector, e.g. input[type=email] or [role=button]." },
        text: { type: "string", description: "Case-insensitive substring of the visible label." },
        role: { type: "string", description: "ARIA role or tag, e.g. button, link, textbox." },
        limit: { type: "integer", description: "1-200, default 50." },
        tabId: { type: "integer" }
      }
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      const res = await callPage(tab, "query", {
        selector: args.selector,
        text: args.text,
        role: args.role,
        limit: args.limit
      });
      if (!res.items.length) return `No visible controls matched on ${res.url}. Try page.snapshot.`;
      return clip(`MATCHES on ${res.url} (${res.count}):
${lines(res.items)}`);
    }
  },
  {
    name: "page.fill",
    description: "Fill several form fields in one call, by ref, label, placeholder or name. Set submit=true to submit the form after the last field. Replaces values unless clear=false.",
    risk: "act",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref: { type: "string" },
              label: { type: "string", description: "Visible label or placeholder text." },
              placeholder: { type: "string" },
              name: { type: "string", description: "The HTML name attribute." },
              value: { type: "string" },
              clear: { type: "boolean", description: "false appends instead of replacing." }
            },
            required: ["value"]
          }
        },
        submit: { type: "boolean" },
        tabId: { type: "integer" }
      },
      required: ["fields"]
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      const res = await callPage(tab, "fill", { fields: args.fields, submit: Boolean(args.submit) });
      await sleep(args.submit ? 900 : 200);
      const ok = res.results.filter((r) => r.ok).length;
      const bad = res.results.filter((r) => !r.ok);
      const parts = [`Filled ${ok}/${res.results.length} field(s)${res.submitted ? " and submitted" : ""}.`];
      if (bad.length) parts.push(`Not filled: ${bad.map((r) => `${r.field} (${r.error})`).join("; ")}`);
      if (res.submitted) parts.push(await pageChange(await browser.tabs.get(tab.id).catch(() => tab), tab.url, tab.id));
      return parts.join("\n");
    }
  },
  {
    name: "page.press",
    description: "Press a key in the focused element or a ref: Enter, Tab, Escape or an arrow. Use for search boxes and menus when typing alone does not submit.",
    risk: "act",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Enter, Tab, Escape, Backspace or an arrow key." },
        ref: { type: "string", description: "Optional field or element to focus first." },
        tabId: { type: "integer" }
      },
      required: ["key"]
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      const res = await callPage(tab, "press", { key: args.key, ref: args.ref });
      await sleep(500);
      return `Pressed ${res.key} on ${res.target}${res.submitted ? " and submitted the form" : ""}.`;
    }
  },
  {
    name: "page.wait",
    description: "Wait until text appears, a selector exists, or text disappears. Use after a click that loads content instead of guessing with sleeps.",
    risk: "read",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        selector: { type: "string" },
        gone: { type: "boolean", description: "Wait for the text or selector to disappear." },
        timeoutMs: { type: "integer", description: "200-30000, default 6000." },
        tabId: { type: "integer" }
      }
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      if (!args.text && !args.selector) throw new Error("Give page.wait a text or selector to wait for.");
      const res = await callPage(tab, "waitFor", {
        text: args.text,
        selector: args.selector,
        gone: args.gone,
        timeoutMs: args.timeoutMs
      });
      return `Wait satisfied after ${res.elapsed} ms: ${res.state}.`;
    }
  },
  {
    name: "page.screenshot",
    description: "Capture the visible area of the tab as an image for a vision model. Use for charts, maps, image editors, canvases, or layouts that the text outline cannot explain. The image is attached to your next reply.",
    risk: "read",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["jpeg", "png"], description: "Default jpeg." },
        quality: { type: "integer", description: "JPEG quality 20-95, default 60." },
        tabId: { type: "integer" }
      }
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      const format = args.format === "png" ? "png" : "jpeg";
      let dataUrl;
      try {
        dataUrl = await browser.tabs.captureTab(tab.id, {
          format,
          quality: Math.min(95, Math.max(20, Number(args.quality) || 60))
        });
      } catch (err) {
        throw new Error(`Firefox could not capture this tab (${err.message}). Some pages and windows block capture.`);
      }
      if (!dataUrl) throw new Error("The capture was empty. Try again after the page finishes loading.");
      ctx.session.lastImage = { dataUrl, at: Date.now(), tabId: tab.id, format };
      const kb = Math.round(dataUrl.length * 3 / 4 / 1024);
      return `Captured [${tab.id}] ${tab.title || ""} (${format}, about ${kb} KB). The image is attached to your next message; describe what you see before acting.`;
    }
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
        tabId: { type: "integer" }
      },
      required: ["ref", "text"]
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      const res = await callPage(tab, "type", {
        ref: args.ref,
        text: args.text,
        submit: Boolean(args.submit),
        clear: args.clear !== false
      });
      await sleep(args.submit ? 800 : 150);
      return `Typed ${res.valueLength} characters into ${args.ref}${res.submitted ? " and submitted" : ""}. ${res.submitted ? "Snapshot again to check the result." : ""}`.trim();
    }
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
        tabId: { type: "integer" }
      },
      required: ["ref", "value"]
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      const res = await callPage(tab, "select", { ref: args.ref, value: args.value });
      return `Selected ${JSON.stringify(res.label)} (value ${JSON.stringify(res.value)}) in ${args.ref}.`;
    }
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
        tabId: { type: "integer" }
      }
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      const res = await callPage(tab, "scroll", args);
      await sleep(400);
      return args.ref ? `Scrolled ${args.ref} into view.` : `Scrolled ${res.scrolledBy > 0 ? "down" : "up"} to y=${res.y} of ${res.height}.`;
    }
  },
  {
    name: "page.fetch",
    description: "Make an HTTP request from inside a tab, using that site's cookies and session (same-origin). This is the fastest way to read a site's own JSON API, e.g. Canvas /api/v1. Returns status, Link header, rate-limit headers and the body. Use pick to keep only the fields you need.",
    risk: "read",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute path or URL, resolved against the tab." },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "Default GET." },
        body: { type: "string", description: "Raw body for POST/PUT/PATCH; JSON string." },
        headers: { type: "object", description: "Optional extra headers." },
        pick: { type: "array", items: { type: "string" }, description: 'Dot paths to project from each object, e.g. ["id","name","due_at"].' },
        maxChars: { type: "integer", description: "Default 20000." },
        tabId: { type: "integer" }
      },
      required: ["url"]
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      const res = await callPage(tab, "fetch", {
        url: args.url,
        method: args.method || "GET",
        body: args.body,
        headers: args.headers
      });
      const method = (args.method || "GET").toUpperCase();
      const head = `${method} ${shortUrl(res.url)} -> ${res.status}${res.contentType ? " " + res.contentType.split(";")[0] : ""}${formatRate(res.rate)}`;
      let body;
      if (res.json !== void 0) {
        body = json(project(res.json, args.pick));
      } else {
        body = res.text || "(empty body)";
      }
      const extra = res.link ? `
Link: ${res.link}` : "";
      const same = res.sameOrigin ? "" : "\nNOTE: this was a cross-origin request; cookies may be missing and the server must allow CORS.";
      return clip(`${head}${extra}${same}

${body}`, args.maxChars || 2e4);
    }
  },
  {
    name: "page.fetchAll",
    description: 'Fetch a paginated JSON collection using the Link rel="next" header (Canvas and most REST APIs) and return one JSON object per line. Use for course lists, assignments, modules, files and enrollments. Throttles between pages.',
    risk: "read",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "First page URL, e.g. /api/v1/courses?per_page=100" },
        pick: { type: "array", items: { type: "string" }, description: "Fields to keep from each item." },
        maxPages: { type: "integer", description: "1-20, default 8." },
        maxChars: { type: "integer", description: "Default 20000." },
        tabId: { type: "integer" }
      },
      required: ["url"]
    },
    async run(args, ctx) {
      const tab = await pageFor(args, ctx);
      const maxChars = args.maxChars || 2e4;
      const result = await fetchAllRows(tab, args.url, {
        pick: args.pick,
        maxPages: args.maxPages,
        maxChars
      });
      if (!result.rows.length) return `No items returned from ${args.url}. ${result.note}`.trim();
      const header = `FETCHED ${result.rows.length} item(s) from ${result.pages} page(s) for ${shortUrl(args.url)}.` + (result.note ? `
${result.note}` : "") + (args.pick?.length ? `
Fields: ${args.pick.join(", ")}` : "");
      return clip(`${header}

${result.text}`, maxChars + 600);
    }
  },
  {
    name: "web.fetch",
    description: "Fetch a public http(s) URL from the extension (no cookies, no JavaScript, no login) and return its title and readable text. Use for checking public pages or documentation without switching tabs. For logged-in pages use a tab plus page.read.",
    risk: "read",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        maxChars: { type: "integer", description: "Default 8000, max 30000." }
      },
      required: ["url"]
    },
    async run(args) {
      const u = requirePublicUrl(args.url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2e4);
      let res;
      let raw;
      try {
        res = await fetch(u.href, {
          headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0", Accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.8" },
          redirect: "follow",
          credentials: "omit",
          signal: controller.signal
        });
        raw = (await res.text()).slice(0, 6e5);
      } catch (e) {
        if (e?.name === "AbortError") throw new Error(`Timed out after 20s fetching ${u.href}.`);
        throw new Error(`Could not fetch ${u.href}: ${e.message}`);
      } finally {
        clearTimeout(timer);
      }
      const ct = res.headers.get("content-type") || "";
      const max = Math.min(3e4, Math.max(1e3, Number(args.maxChars) || 8e3));
      if (/json/i.test(ct)) {
        let pretty = raw;
        try {
          pretty = JSON.stringify(JSON.parse(raw), null, 1);
        } catch {
        }
        return clip(`${u.href} -> ${res.status} (json, no cookies)

${pretty}`, max);
      }
      if (!/html?/i.test(ct)) {
        return clip(`${u.href} -> ${res.status} ${ct}

${raw}`, max);
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
      return clip(`${u.href} -> ${res.status} (text snapshot, no cookies)
TITLE: ${title}

${text}`, max);
    }
  },
  {
    name: "browser.tabs",
    description: "List open tabs with their ids, titles and URLs. Use this to find the Canvas tab, or pages to read and compare.",
    risk: "read",
    parameters: { type: "object", properties: {} },
    async run() {
      const tabs = await browser.tabs.query({});
      const lines2 = tabs.map((t) => `[${t.id}]${t.active ? " *active*" : ""} ${t.title || "(no title)"} \u2014 ${t.url || ""}`);
      return clip(`OPEN TABS (${tabs.length}):
${lines2.join("\n")}`, 8e3);
    }
  },
  {
    name: "browser.open",
    description: "Open a URL in a new tab and wait for it to load. Use this when a task needs a different site than the active tab. Returns the new tab id for page.read/page.snapshot.",
    risk: "act",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        active: { type: "boolean", description: "Focus the new tab. Default true." }
      },
      required: ["url"]
    },
    async run(args) {
      const u = requireHttp(args.url);
      const tab = await browser.tabs.create({ url: u.href, active: args.active !== false });
      const loaded = await waitForLoad(tab.id);
      return `Opened tab [${loaded.id}] ${loaded.title || ""} \u2014 ${loaded.url}`;
    }
  },
  {
    name: "browser.switch",
    description: "Make an existing tab active in its window. Use when the user needs to see or interact with a page, or before a page action that only works on the visible tab.",
    risk: "act",
    parameters: {
      type: "object",
      properties: { tabId: { type: "integer" } },
      required: ["tabId"]
    },
    async run(args) {
      const tab = await browser.tabs.get(Number(args.tabId));
      await browser.tabs.update(tab.id, { active: true });
      await browser.windows.update(tab.windowId, { focused: true }).catch(() => {
      });
      return `Switched to [${tab.id}] ${tab.title || ""} \u2014 ${tab.url}`;
    }
  },
  {
    name: "browser.close",
    description: "Close a tab by id. Use for cleanup after reading pages you opened. Do not close tabs the user opened unless asked.",
    risk: "act",
    parameters: {
      type: "object",
      properties: { tabId: { type: "integer" } },
      required: ["tabId"]
    },
    async run(args) {
      const tab = await browser.tabs.get(Number(args.tabId));
      await browser.tabs.remove(tab.id);
      return `Closed tab [${tab.id}] ${tab.title || ""}.`;
    }
  },
  {
    name: "browser.download",
    description: "Download one file to the user's Downloads folder. The URL must be an http(s) URL; cookies are sent as usual. Give a full relative path such as FoxAgent/Canvas/Biology/week1/lecture.pdf.",
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        filename: { type: "string" }
      },
      required: ["url", "filename"]
    },
    async run(args) {
      const u = requireHttp(args.url);
      const filename = safeFilename(args.filename);
      const id = await browser.downloads.download({ url: u.href, filename, conflictAction: "uniquify", saveAs: false });
      return `Download started: ${filename} (download id ${id}).`;
    }
  },
  {
    name: "browser.downloadMany",
    description: 'Download many files in one approved batch (up to 200). Use after building a manifest, and include the course/module in each filename. Returns per-file queued/failed status. This is the correct tool for "download every material in every module".',
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
            required: ["url", "filename"]
          }
        }
      },
      required: ["files"]
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
        const settled = await Promise.allSettled(batch.map(
          (f) => browser.downloads.download({ url: f.url, filename: f.filename, conflictAction: "uniquify", saveAs: false })
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
      const lines2 = [
        `Queued ${ok} of ${files.length} download(s)${files.length > 200 ? " (capped at 200 per call)" : ""}.`,
        ...results.slice(0, 200),
        ...skipped.map((s) => `SKIP ${s}`)
      ];
      return clip(lines2.join("\n"), 14e3);
    }
  },
  {
    name: "files.write",
    description: "Write a text file (Markdown, JSON, CSV) to the user's Downloads folder via a browser download. Use for reports, manifests and extracted notes. Include a path like FoxAgent/reports/weekly-digest.md.",
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string" },
        content: { type: "string" },
        mimeType: { type: "string", description: "Default text/markdown." }
      },
      required: ["filename", "content"]
    },
    async run(args) {
      const filename = safeFilename(args.filename, "FoxAgent/note.md");
      const content = String(args.content ?? "");
      if (content.length > 4e6) throw new Error("File is too large (4 MB limit). Split it into parts.");
      const blob = new Blob([content], { type: args.mimeType || "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      try {
        const id = await browser.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
        setTimeout(() => URL.revokeObjectURL(url), 6e4);
        return `Saved ${filename} (${content.length} chars, download id ${id}).`;
      } catch (e) {
        URL.revokeObjectURL(url);
        throw new Error(`Could not save file: ${e.message}`);
      }
    }
  },
  {
    name: "task.note",
    description: "Append a line to the task scratchpad. The scratchpad is shown to you in every request, so use it for a checklist, progress, ids, filenames and anything you must not forget during a long task. Keep it terse. It survives page loads and long conversations.",
    risk: "read",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: 'Short line, e.g. "[x] course 42 modules fetched; files pending".' } },
      required: ["text"]
    },
    async run(args, ctx) {
      const total = addNote(ctx.session, args.text);
      return `Noted. Scratchpad is now ${total} characters.`;
    }
  },
  {
    name: "ui.ask",
    description: "Ask the user a question and wait for their answer, inside the sidebar. Use when a task is ambiguous (which course? include pages or only files?), before a large download, or to request a manual step such as logging in. Do not ask trivia you can observe.",
    risk: "read",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" }, description: "Optional suggested answers." }
      },
      required: ["question"]
    },
    async run(args, ctx) {
      const answer = await ctx.ask({ question: args.question, options: args.options || [] });
      return `User answered: ${answer || "(no answer)"}`;
    }
  }
];
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
function findTool(name) {
  const exact = TOOL_BY_NAME.get(name);
  if (exact) return exact;
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = norm(name);
  return TOOLS.find((t) => norm(t.name) === wanted) || null;
}
function toolsFor({ small = false, vision = false } = {}) {
  const skip = new Set(small ? ["page.links", "browser.switch"] : []);
  if (!vision) {
    skip.add("page.screenshot");
    skip.add("page.clickAt");
  }
  return TOOLS.filter((t) => !skip.has(t.name));
}
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}
function suggestTools(name, limit = 3) {
  const wanted = String(name || "").toLowerCase();
  return TOOLS.map((t) => ({ name: t.name, d: distance(wanted, t.name.toLowerCase()) })).sort((a, b) => a.d - b.d).slice(0, limit).map((t) => t.name);
}
function summarizeArgs(args) {
  const entries = Object.entries(args || {}).filter(([k]) => k !== "tabId");
  if (!entries.length) return "";
  return entries.map(([k, v]) => {
    let s;
    if (typeof v === "string") s = v;
    else if (Array.isArray(v)) s = `${v.length} item(s)`;
    else s = JSON.stringify(v);
    s = s.replace(/\s+/g, " ");
    return `${k}=${s.length > 70 ? s.slice(0, 70) + "\u2026" : s}`;
  }).join(", ");
}
export {
  TOOLS,
  TOOL_BY_NAME,
  findTool,
  suggestTools,
  summarizeArgs,
  toolsFor
};
