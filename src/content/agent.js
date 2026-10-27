/*
 * FoxAgent page bridge.
 * Injected on demand into the active tab. Everything here runs in the page's
 * own origin, so page.fetch carries the user's session cookies for same-origin
 * APIs (Canvas, wikis, intranets). Nothing is evaluated.
 */
(() => {
  if (window.__foxAgentBridge) return;
  window.__foxAgentBridge = true;

  const HIDDEN_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "svg", "SVG", "CANVAS",
    "OBJECT", "EMBED", "VIDEO", "AUDIO", "META", "LINK", "HEAD", "TITLE",
  ]);
  const SKIP_TAGS = new Set(["NAV", "FOOTER", "ASIDE", "DIALOG"]);
  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DETAILS", "DIV", "DL", "DT", "DD",
    "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4",
    "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION",
    "TABLE", "UL",
  ]);
  const CLICKABLE = [
    "a[href]", "button", "input:not([type=password])", "select", "textarea",
    "summary", "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]",
    "[role=tab]", "[role=menuitem]", "[role=option]", "[contenteditable=true]",
    "[onclick]",
  ].join(",");

  const refs = new Map();
  let refSeq = 0;
  const hiddenCache = new WeakMap();

  const text = (v) => (v == null ? "" : String(v));
  const clean = (v) => text(v).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const clamp = (v, lo, hi, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
  };
  const absolute = (href) => {
    try {
      const u = new URL(href, location.href);
      if (!/^https?:$/.test(u.protocol) && u.protocol !== "mailto:") return "";
      return u.href;
    } catch {
      return "";
    }
  };
  const tagOf = (el) => String(el?.tagName || "").toLowerCase();
  const viewOf = (el) => el?.ownerDocument?.defaultView || window;
  const isInput = (el) => tagOf(el) === "input";
  const isTextarea = (el) => tagOf(el) === "textarea";
  const isSelect = (el) => tagOf(el) === "select";
  const isPassword = (el) => isInput(el) && el.type === "password";

  function hidden(el) {
    if (!el || el.nodeType !== 1 || typeof el.getBoundingClientRect !== "function") return true;
    if (hiddenCache.has(el)) return hiddenCache.get(el);
    let result = false;
    if (el.hidden || el.getAttribute("aria-hidden") === "true") result = true;
    else {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") result = true;
      else if (Number(cs.opacity) === 0) result = true;
      else if (parseFloat(cs.fontSize) < 1) result = true;
      else {
        const r = el.getBoundingClientRect();
        if (r.width < 2 && r.height < 2) result = true;
      }
    }
    hiddenCache.set(el, result);
    return result;
  }

  function labelOf(el) {
    const tag = el.tagName.toLowerCase();
    if (isPassword(el)) return "[password field]";
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    if (el.id) {
      const scope = el.getRootNode?.() || document;
      const lab = scope.querySelector?.(`label[for="${CSS.escape(el.id)}"]`)
        || document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) return clean(lab.innerText);
    }
    const wrapping = el.closest("label");
    if (wrapping && tag !== "label") {
      const t = clean(wrapping.innerText);
      if (t) return t;
    }
    const own = clean(el.innerText || el.textContent);
    if (own) return own.slice(0, 160);
    if (tag === "input") {
      if (el.type === "hidden" || el.type === "submit" || el.type === "button") return clean(el.value) || el.type;
      return clean(el.getAttribute("placeholder") || el.getAttribute("title") || el.name || el.type);
    }
    if (tag === "select") {
      const o = [...el.options].filter((x) => x.selected)[0];
      return clean(o ? o.textContent : el.name);
    }
    return clean(el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("name") || tag);
  }

  function refFor(el) {
    if (el.__foxRef) return el.__foxRef;
    const ref = "e" + ++refSeq;
    el.__foxRef = ref;
    refs.set(ref, el);
    return ref;
  }

  /*
   * Modern pages put controls behind open shadow roots and same-origin
   * iframes. Walk those too so snapshot/query can see the real form.
   */
  function roots() {
    const out = [];
    const seen = new Set();
    const visit = (root) => {
      if (!root || seen.has(root)) return;
      seen.add(root);
      out.push(root);
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) visit(el.shadowRoot);
        if (el.tagName === "IFRAME") {
          try { if (el.contentDocument) visit(el.contentDocument); } catch {}
        }
      }
    };
    visit(document);
    return out;
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < (window.innerHeight || 0) && r.left < (window.innerWidth || 0);
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }

  function visibleText() {
    let out = document.body?.innerText || "";
    for (const root of roots()) {
      if (root === document) continue;
      const t = root.body?.innerText || root.host?.innerText || "";
      if (t) out += "\n" + t;
    }
    return clean(out);
  }

  function snapshot(opts = {}) {
    const limit = clamp(opts.maxElements, 20, 400, 200);
    const outline = [];
    const all = roots();
    for (const root of all) {
      for (const h of root.querySelectorAll("h1,h2,h3")) {
        if (outline.length >= 30) break;
        if (hidden(h)) continue;
        const t = clean(h.innerText);
        if (t) outline.push(`${"  ".repeat(Number(h.tagName[1]) - 1)}${h.tagName.toLowerCase()} ${t.slice(0, 100)}`);
      }
    }

    /*
     * On small screens a 200 element cap fills with navigation. Rank controls
     * that are on screen and directly actionable first, then keep DOM order as
     * the tie-breaker.
     */
    const candidates = [];
    let order = 0;
    let total = 0;
    for (const root of all) {
      for (const el of root.querySelectorAll(CLICKABLE)) {
        total++;
        if (isPassword(el) || hidden(el)) continue;
        const tag = el.tagName;
        let score = inViewport(el) ? 100 : 0;
        if (tag === "BUTTON" || el.type === "submit" || el.getAttribute("role") === "button") score += 25;
        if (tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable) score += 18;
        if (tag === "SELECT") score += 14;
        if (tag === "A") score += 4;
        candidates.push({ el, score, order: order++ });
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.order - b.order);

    const lines = [];
    const seen = new Set();
    for (const { el } of candidates) {
      if (lines.length >= limit) break;
      if (seen.has(el)) continue;
      seen.add(el);
      const ref = refFor(el);
      const tag = el.tagName.toLowerCase();
      const bits = [];
      const type = el.getAttribute("type");
      if (type) bits.push(type);
      const role = el.getAttribute("role");
      if (role) bits.push(role);
      if (el.isContentEditable) bits.push("editable");
      if (el.getAttribute("aria-expanded")) bits.push("expanded=" + el.getAttribute("aria-expanded"));
      if (el.disabled || el.getAttribute("aria-disabled") === "true") bits.push("disabled");
      if (el.checked) bits.push("checked");
      if (el.getAttribute("aria-selected") === "true") bits.push("selected");
      if (!inViewport(el)) bits.push("offscreen");
      const name = labelOf(el);
      let line = `${ref} <${tag}${bits.length ? " " + bits.join(" ") : ""}> ${JSON.stringify(name)}`;
      const placeholder = el.getAttribute("placeholder");
      if (placeholder && placeholder !== name) line += ` placeholder=${JSON.stringify(clean(placeholder).slice(0, 60))}`;
      if (tag === "a") {
        const u = absolute(el.getAttribute("href"));
        if (u) line += ` -> ${u}`;
      } else if (tag === "select") {
        const vals = [...el.options].slice(0, 10).map((o) => (o.value === o.textContent.trim() ? o.value : `${o.value}=${clean(o.textContent)}`));
        if (vals.length) line += ` options=[${vals.join(", ")}]`;
      } else if ((tag === "input" || tag === "textarea") && el.type !== "password" && el.value) {
        line += ` value=${JSON.stringify(clean(el.value).slice(0, 80))}`;
      }
      lines.push(line);
    }
    return {
      url: location.href,
      title: document.title,
      outline,
      elements: lines,
      total,
    };
  }

  function root() {
    const candidates = [
      "main", "[role=main]", "article", "#main-content", "#content", "#canvas",
      ".markdown-body", ".content", ".post", ".entry-content",
    ];
    let best = null;
    let bestScore = 0;
    for (const sel of candidates) {
      for (const el of document.querySelectorAll(sel)) {
        if (hidden(el)) continue;
        const t = el.innerText || "";
        if (t.length < 200) continue;
        const noise = el.querySelectorAll("nav,footer,aside,form").length * 250;
        const links = el.querySelectorAll("a").length * 25;
        const score = t.length - noise - links;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
    }
    if (best && (best.innerText || "").length > 300) return best;
    return document.body;
  }

  function mdChildren(node, ctx) {
    let out = "";
    for (const child of node.childNodes) out += mdNode(child, ctx);
    return out;
  }

  function mdNode(node, ctx) {
    if (node.nodeType === Node.TEXT_NODE) {
      let t = text(node.nodeValue).replace(/\u00a0/g, " ");
      if (ctx.pre) return t;
      t = t.replace(/\s+/g, " ");
      return t.trim() ? t : " ";
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node;
    const tag = el.tagName;
    if (HIDDEN_TAGS.has(tag) || HIDDEN_TAGS.has(tag.toLowerCase())) return "";
    if (el !== ctx.root && hidden(el)) return "";
    if (isPassword(el)) return "";

    const inner = () => mdChildren(el, ctx);
    const block = (s) => "\n\n" + s.trim() + "\n\n";

    // Read what modern apps render: open shadow roots and same-origin frames.
    if (el.shadowRoot) {
      const shadow = mdChildren(el.shadowRoot, { ...ctx, root: el.shadowRoot }).trim();
      return shadow ? block(shadow) : "";
    }
    if (tag === "IFRAME") {
      try {
        const doc = el.contentDocument;
        if (doc?.body) {
          const framed = mdChildren(doc.body, { ...ctx, root: doc.body }).trim();
          return framed ? block(framed) : "";
        }
      } catch {}
      return "";
    }

    switch (tag) {
      case "BR": return "\n";
      case "HR": return block("---");
      case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": {
        const n = Number(tag[1]);
        const t = clean(inner());
        return t ? block("#".repeat(n) + " " + t) : "";
      }
      case "P": return block(inner());
      case "DIV": case "SECTION": case "ARTICLE": case "MAIN": case "HEADER":
      case "FIGURE": case "FIGCAPTION": case "ADDRESS": case "DL": case "DT": case "DD": {
        const t = inner();
        return t.trim() ? "\n\n" + t.trim() + "\n\n" : "";
      }
      case "NAV": case "FOOTER": case "ASIDE": case "FORM": case "FIELDSET":
        return SKIP_TAGS.has(tag) ? "" : block(inner());
      case "UL": case "OL":
        return block(renderList(el, tag === "OL", (ctx.listDepth || 0)));
      case "LI": return block(inner());
      case "BLOCKQUOTE": {
        const t = inner().trim();
        if (!t) return "";
        return block(t.split("\n").map((l) => (l.trim() ? "> " + l : ">")).join("\n"));
      }
      case "PRE": {
        const raw = text(el.textContent).replace(/```/g, "`\u200b``").trim();
        return raw ? block("```\n" + raw + "\n```") : "";
      }
      case "CODE": {
        const t = clean(el.textContent);
        return t ? "`" + t.replace(/`/g, "\u200b`") + "`" : "";
      }
      case "STRONG": case "B": {
        const t = inner().trim();
        return t ? `**${t}**` : "";
      }
      case "EM": case "I": {
        const t = inner().trim();
        return t ? `*${t}*` : "";
      }
      case "DEL": case "S": {
        const t = inner().trim();
        return t ? `~~${t}~~` : "";
      }
      case "A": {
        const t = clean(inner()) || clean(el.getAttribute("title"));
        const u = absolute(el.getAttribute("href"));
        if (!t) return u ? u : "";
        return u ? `[${t}](${u})` : t;
      }
      case "IMG": {
        const src = absolute(el.getAttribute("src") || el.getAttribute("data-src"));
        const w = Number(el.getAttribute("width") || el.naturalWidth || 0);
        const h = Number(el.getAttribute("height") || el.naturalHeight || 0);
        if (!src || (w > 0 && w < 40) || (h > 0 && h < 40)) return "";
        const alt = clean(el.getAttribute("alt")) || "image";
        return `![${alt}](${src})`;
      }
      case "TABLE": return block(renderTable(el));
      case "BUTTON": case "INPUT": case "SELECT": case "TEXTAREA": return "";
      case "SUMMARY": {
        const t = clean(inner());
        return t ? block("**" + t + "**") : "";
      }
      case "DETAILS": {
        const open = el.hasAttribute("open") ? "" : "";
        return block(open + inner());
      }
      case "TIME": return clean(inner());
      default: {
        if (BLOCK_TAGS.has(tag)) {
          const t = inner();
          return t.trim() ? block(t) : "";
        }
        return inner();
      }
    }
  }

  function renderList(el, ordered, depth) {
    const items = [...el.children].filter((c) => c.tagName === "LI");
    let out = "";
    items.forEach((li, i) => {
      const marker = ordered ? `${i + 1}.` : "-";
      let inline = "";
      const nested = [];
      for (const c of li.childNodes) {
        if (c.nodeType === Node.ELEMENT_NODE && (c.tagName === "UL" || c.tagName === "OL")) nested.push(c);
        else inline += mdNode(c, { root: li, listDepth: depth + 1, pre: false });
      }
      inline = inline.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
      out += `${"  ".repeat(depth)}${marker} ${inline}\n`;
      for (const n of nested) out += renderList(n, n.tagName === "OL", depth + 1);
    });
    return out.trimEnd();
  }

  function renderTable(el) {
    const rows = [];
    for (const tr of el.querySelectorAll("tr")) {
      const cells = [...tr.children]
        .filter((c) => c.tagName === "TD" || c.tagName === "TH")
        .map((c) => clean(c.innerText).replace(/\|/g, "\\|"));
      if (cells.length) rows.push(cells);
      if (rows.length >= 60) break;
    }
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r) => r.concat(Array(width - r.length).fill(""));
    const head = pad(rows[0]);
    const sep = Array(width).fill("---");
    return [head, sep, ...rows.slice(1).map(pad)]
      .map((r) => "| " + r.join(" | ") + " |")
      .join("\n");
  }

  /*
   * DOM text nodes often carry layout whitespace ("word  word") that is not
   * meaningful in Markdown. Collapse runs of spaces outside code fences, while
   * keeping indentation for nested lists.
   */
  function tidyMarkdown(md) {
    let inFence = false;
    return md.split("\n").map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(/(\S)[ \t]{2,}(?=\S)/g, "$1 ");
    }).join("\n");
  }

  function read(opts = {}) {
    let target;
    if (opts.selector) {
      target = document.querySelector(opts.selector);
      if (!target) throw new Error(`No element matches ${opts.selector}`);
    } else {
      target = root();
    }
    const markdown = tidyMarkdown(mdChildren(target, { root: target, listDepth: 0, pre: false })
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim());
    const max = clamp(opts.maxChars, 1000, 60000, 12000);
    const truncated = markdown.length > max;
    return {
      url: location.href,
      title: document.title,
      markdown: truncated ? markdown.slice(0, max) : markdown,
      truncated,
      chars: markdown.length,
      words: markdown ? markdown.split(/\s+/).length : 0,
      selection: clean(window.getSelection()?.toString()).slice(0, 4000),
    };
  }

  function links(opts = {}) {
    const filter = opts.filter ? new RegExp(opts.filter, "i") : null;
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll("a[href]")) {
      if (hidden(a)) continue;
      const href = absolute(a.getAttribute("href"));
      if (!href || seen.has(href)) continue;
      const label = clean(a.innerText || a.getAttribute("aria-label") || a.getAttribute("title"));
      if (filter && !filter.test(href + " " + label)) continue;
      seen.add(href);
      out.push({ text: label.slice(0, 120), href });
      if (out.length >= clamp(opts.limit, 5, 500, 200)) break;
    }
    return { url: location.href, count: out.length, links: out };
  }

  function element(ref) {
    const el = refs.get(ref);
    if (!el || !el.isConnected) {
      throw new Error(`Ref ${ref} is stale or unknown. Call page.snapshot again and use a fresh ref.`);
    }
    return el;
  }

  function flash(el) {
    try {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      const prev = el.style.outline;
      el.style.outline = "2px solid #e8620f";
      setTimeout(() => { el.style.outline = prev; }, 900);
    } catch {}
  }

  function click(opts) {
    const el = element(opts.ref);
    flash(el);
    const name = labelOf(el).slice(0, 120);
    if (el.disabled) throw new Error(`Element ${opts.ref} is disabled.`);
    if (typeof el.click === "function") el.click();
    else {
      const view = viewOf(el);
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        el.dispatchEvent(new view.MouseEvent(type, { bubbles: true, cancelable: true, view }));
      }
    }
    return { ref: opts.ref, label: name };
  }

  /*
   * Click by visible label. Refs go stale and small models reuse them, so a
   * text match is both shorter and more reliable for "click Next".
   */
  function clickText(opts) {
    const wanted = clean(opts.text).toLowerCase();
    if (!wanted) throw new Error("page.clickText needs the visible text to click.");    const exact = Boolean(opts.exact);
    const role = clean(opts.role).toLowerCase();
    const matches = [];
    for (const root of roots()) {
      for (const el of root.querySelectorAll(CLICKABLE)) {
        if (isPassword(el) || hidden(el) || el.disabled) continue;
        if (role && String(el.getAttribute("role") || el.tagName).toLowerCase() !== role) continue;
        const label = labelOf(el);
        const lower = clean(label).toLowerCase();
        if (!lower) continue;
        const isExact = lower === wanted;
        const starts = lower.startsWith(wanted);
        if (isExact || starts || (!exact && lower.includes(wanted))) {
          matches.push({ el, label, rank: isExact ? 0 : starts ? 1 : 2, offscreen: inViewport(el) ? 0 : 1 });
        }
        if (matches.length >= 60) break;
      }
    }
    if (!matches.length) {
      throw new Error(`No visible button or link matches ${JSON.stringify(opts.text)}. Use page.snapshot or page.query to see the labels.`);
    }
    matches.sort((a, b) => a.rank - b.rank || a.offscreen - b.offscreen);
    const nth = Math.max(0, Number(opts.nth) || 0);
    const pick = matches[nth];
    if (!pick) throw new Error(`Only ${matches.length} element(s) match ${JSON.stringify(opts.text)}; nth=${nth} is out of range.`);
    const ref = refFor(pick.el);
    click({ ref });
    return {
      ref,
      label: pick.label.slice(0, 120),
      matches: matches.length,
      others: matches
        .map((m, i) => ({ label: m.label.slice(0, 60), i }))
        .filter((m) => m.i !== nth)
        .slice(0, 4),
    };
  }

  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    for (let i = 0; i < 5 && el; i++) {
      if (el.shadowRoot) {
        const inner = el.shadowRoot.elementFromPoint(x, y);
        if (inner && inner !== el) { el = inner; continue; }
      }
      if (el.tagName === "IFRAME") {
        try {
          const r = el.getBoundingClientRect();
          const inner = el.contentDocument?.elementFromPoint(x - r.left, y - r.top);
          if (inner && inner !== el) { el = inner; continue; }
        } catch {}
      }
      break;
    }
    return el;
  }

  function clickAt(opts = {}) {
    const x = Number(opts.x);
    const y = Number(opts.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("page.clickAt needs numeric x and y.");
    const el = deepElementFromPoint(x, y);
    if (!el) throw new Error(`Nothing is visible at ${x},${y}. Take a fresh screenshot and use a point inside a control.`);
    if (isPassword(el)) throw new Error("That point is a password field. Ask the user to sign in.");
    const ref = refFor(el);
    click({ ref });
    return { ref, label: labelOf(el).slice(0, 120), tag: el.tagName.toLowerCase(), x, y };
  }

  function query(opts = {}) {
    const selector = text(opts.selector).trim();
    const wanted = clean(opts.text).toLowerCase();
    const role = clean(opts.role).toLowerCase();
    const limit = clamp(opts.limit, 1, 200, 50);
    const items = [];
    for (const root of roots()) {
      let nodes;
      try {
        nodes = root.querySelectorAll(selector || CLICKABLE);
      } catch {
        throw new Error(`Bad CSS selector: ${selector}`);
      }
      for (const el of nodes) {
        if (hidden(el)) continue;
        if (role && String(el.getAttribute("role") || el.tagName).toLowerCase() !== role) continue;
        const label = labelOf(el);
        if (wanted && !clean(label).toLowerCase().includes(wanted)) continue;
        items.push({
          ref: refFor(el),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          label: label.slice(0, 160),
          type: el.getAttribute("type") || "",
          value: el.value != null ? clean(el.value).slice(0, 80) : "",
          disabled: Boolean(el.disabled),
          rect: rectOf(el),
        });
        if (items.length >= limit) break;
      }
      if (items.length >= limit) break;
    }
    return { url: location.href, title: document.title, count: items.length, items };
  }

  function editable(el) {
    return isInput(el) || isTextarea(el) || isSelect(el) || el.isContentEditable;
  }

  function findField(spec = {}) {
    if (spec.ref) return element(spec.ref);
    const wanted = clean(spec.label || spec.placeholder || spec.name || "").toLowerCase();
    if (!wanted) throw new Error("Each field needs a ref, label, placeholder or name.");
    for (const root of roots()) {
      for (const el of root.querySelectorAll("input, textarea, select, [contenteditable=true]")) {
        if (isPassword(el) || hidden(el) || el.disabled || !editable(el)) continue;
        const bits = [
          labelOf(el),
          el.getAttribute("placeholder"),
          el.getAttribute("name"),
          el.getAttribute("aria-label"),
        ].filter(Boolean).map((v) => clean(v).toLowerCase());
        if (bits.some((b) => b === wanted || b.includes(wanted))) return el;
      }
    }
    throw new Error(`No visible field matches ${JSON.stringify(spec.label || spec.placeholder || spec.name)}.`);
  }

  function fill(opts = {}) {
    const fields = Array.isArray(opts.fields) ? opts.fields.slice(0, 20) : [];
    if (!fields.length) throw new Error("page.fill needs a fields array.");
    const results = [];
    let last = null;
    for (const spec of fields) {
      try {
        const el = findField(spec);
        if (isSelect(el)) {
          select({ ref: refFor(el), value: text(spec.value) });
        } else {
          type({ ref: refFor(el), text: text(spec.value), clear: spec.clear !== false });
        }
        last = el;
        results.push({ field: (spec.label || spec.placeholder || spec.ref || "field").toString().slice(0, 80), ok: true });
      } catch (e) {
        results.push({ field: (spec.label || spec.placeholder || spec.ref || "field").toString().slice(0, 80), ok: false, error: String(e.message || e) });
      }
    }
    let submitted = false;
    if (opts.submit && last) {
      const form = last.form || last.closest?.("form");
      if (form && typeof form.requestSubmit === "function") {
        form.requestSubmit();
        submitted = true;
      }
    }
    return { results, submitted };
  }

  function press(opts = {}) {
    const el = opts.ref ? element(opts.ref) : document.activeElement;
    const key = text(opts.key || "Enter");
    const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39 };
    el?.focus?.();
    const view = el ? viewOf(el) : window;
    for (const type of ["keydown", "keypress", "keyup"]) {
      el?.dispatchEvent(new view.KeyboardEvent(type, {
        key, code: key, keyCode: codes[key] || 0, which: codes[key] || 0, bubbles: true, cancelable: true,
      }));
    }
    let submitted = false;
    if (key === "Enter" && el) {
      const form = el.form || el.closest?.("form");
      if (form && typeof form.requestSubmit === "function") {
        form.requestSubmit();
        submitted = true;
      }
    }
    return { key, submitted, target: el ? labelOf(el).slice(0, 80) : "(none)" };
  }

  async function waitFor(opts = {}) {
    const timeout = clamp(opts.timeoutMs, 200, 30000, 6000);
    const selector = text(opts.selector).trim();
    const wanted = clean(opts.text).toLowerCase();
    const gone = Boolean(opts.gone);
    const started = Date.now();
    const present = () => {
      if (selector) {
        for (const root of roots()) {
          try { if (root.querySelector(selector)) return true; } catch { throw new Error(`Bad CSS selector: ${selector}`); }
        }
        return false;
      }
      if (!wanted) return true;
      return visibleText().toLowerCase().includes(wanted);
    };
    while (Date.now() - started < timeout) {
      const here = present();
      if (gone ? !here : here) return { ok: true, elapsed: Date.now() - started, state: gone ? "gone" : "present" };
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`Timed out after ${timeout}ms waiting for ${selector ? selector : `text ${JSON.stringify(opts.text)}`}${gone ? " to disappear" : ""}.`);
  }

  function setNativeValue(el, value) {
    const view = viewOf(el);
    const proto = isTextarea(el) ? view.HTMLTextAreaElement.prototype
      : isSelect(el) ? view.HTMLSelectElement.prototype
      : view.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
  }

  function type(opts) {
    const el = element(opts.ref);
    if (isPassword(el)) throw new Error("Refusing to type into a password field. Ask the user to sign in.");
    if (el.isContentEditable) {
      el.focus();
      el.textContent = text(opts.text);
    } else if (isInput(el) || isTextarea(el)) {
      el.focus();
      if (opts.clear === false) setNativeValue(el, text(el.value) + text(opts.text));
      else setNativeValue(el, text(opts.text));
    } else {
      throw new Error(`Ref ${opts.ref} is not an editable field.`);
    }
    const view = viewOf(el);
    el.dispatchEvent(new view.InputEvent("input", { bubbles: true, data: text(opts.text), inputType: "insertText" }));
    el.dispatchEvent(new view.Event("change", { bubbles: true }));
    if (opts.submit) {
      const form = el.form || el.closest("form");
      if (form) {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
      } else {
        const submitView = viewOf(el);
        for (const t of ["keydown", "keypress", "keyup"]) {
          el.dispatchEvent(new submitView.KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        }
      }
    }
    return { ref: opts.ref, submitted: Boolean(opts.submit), valueLength: text(opts.text).length };
  }

  function select(opts) {
    const el = element(opts.ref);
    if (!isSelect(el)) throw new Error(`Ref ${opts.ref} is not a <select>.`);
    const wanted = text(opts.value);
    const opt = [...el.options].find((o) => o.value === wanted)
      || [...el.options].find((o) => clean(o.textContent) === wanted);
    if (!opt) throw new Error(`No option ${JSON.stringify(wanted)}. Options: ${[...el.options].map((o) => o.value).join(", ")}`);
    setNativeValue(el, opt.value);
    el.dispatchEvent(new (viewOf(el)).Event("change", { bubbles: true }));
    return { ref: opts.ref, value: opt.value, label: clean(opt.textContent) };
  }

  function scroll(opts = {}) {
    if (opts.ref) {
      element(opts.ref).scrollIntoView({ block: "center", behavior: "smooth" });
      return { scrolledTo: opts.ref };
    }
    const amount = clamp(opts.amount, 100, 5000, 700);
    const dy = opts.direction === "up" ? -amount : amount;
    window.scrollBy({ top: dy, behavior: "smooth" });
    return { scrolledBy: dy, y: Math.round(window.scrollY), height: document.documentElement.scrollHeight };
  }

  async function pageFetch(opts = {}) {
    const raw = text(opts.url);
    const url = new URL(raw, location.href).href;
    if (!/^https?:/i.test(url)) throw new Error("Only http(s) URLs can be fetched.");
    const method = text(opts.method || "GET").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) throw new Error("Unsupported method.");
    const headers = { Accept: "application/json, text/plain, text/html;q=0.9, */*;q=0.8" };
    for (const [k, v] of Object.entries(opts.headers || {})) {
      if (/^(host|origin|cookie|content-length)$/i.test(k)) continue;
      headers[k] = text(v);
    }
    let body;
    if (opts.body != null && method !== "GET" && method !== "HEAD") {
      if (typeof opts.body === "string") {
        body = opts.body;
        if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
          headers["Content-Type"] = "application/json";
        }
      } else {
        body = JSON.stringify(opts.body);
        headers["Content-Type"] = "application/json";
      }
    }
    const sameOrigin = url.startsWith(location.origin + "/") || url === location.origin;
    const controller = new AbortController();
    const limitMs = Math.max(5000, Math.min(120000, Number(opts.timeoutMs) || 45000));
    const timer = setTimeout(() => controller.abort(), limitMs);
    let res;
    let rawText;
    try {
      res = await fetch(url, { method, headers, body, credentials: "include", redirect: "follow", signal: controller.signal });
      rawText = (await res.text()).slice(0, 400000);
    } catch (e) {
      if (e?.name === "AbortError") {
        throw new Error(`Request timed out after ${Math.round(limitMs / 1000)}s: ${url}`);
      }
      throw new Error(`Request failed (${sameOrigin ? "same-origin" : "cross-origin, likely CORS" }): ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
    const ct = res.headers.get("content-type") || "";
    const link = res.headers.get("link") || "";
    const rate = {
      remaining: res.headers.get("x-rate-limit-remaining"),
      reset: res.headers.get("x-rate-limit-reset"),
      retryAfter: res.headers.get("retry-after"),
    };
    let json;
    if (/json/i.test(ct) || /^\s*[[{]/.test(rawText)) {
      try { json = JSON.parse(rawText); } catch {}
    }
    return {
      url: res.url || url,
      sameOrigin,
      status: res.status,
      ok: res.ok,
      contentType: ct,
      link,
      rate,
      json,
      text: json === undefined ? rawText : "",
      chars: rawText.length,
    };
  }

  async function handle(msg) {
    switch (msg.op) {
      case "ping": return { ok: true, url: location.href, title: document.title };
      case "snapshot": return snapshot(msg.args);
      case "read": return read(msg.args);
      case "links": return links(msg.args);
      case "click": return click(msg.args);
      case "clickText": return clickText(msg.args);
      case "clickAt": return clickAt(msg.args);
      case "query": return query(msg.args);
      case "fill": return fill(msg.args);
      case "press": return press(msg.args);
      case "waitFor": return waitFor(msg.args);
      case "type": return type(msg.args);
      case "select": return select(msg.args);
      case "scroll": return scroll(msg.args);
      case "fetch": return pageFetch(msg.args);
      default: throw new Error(`Unknown page op: ${msg.op}`);
    }
  }

  browser.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.__foxagent !== true) return undefined;
    if (sender?.id && sender.id !== browser.runtime.id) return undefined;
    return handle(msg)
      .then((result) => ({ ok: true, result }))
      .catch((e) => ({ ok: false, error: String(e?.message || e) }));
  });
})();
