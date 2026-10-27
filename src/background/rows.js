/*
 * Paginated JSON helpers shared by core tools and installed packs.
 */

import { callPage } from "./page.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function nextLink(header) {
  if (!header) return "";
  for (const part of String(header).split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (m) return m[1];
  }
  return "";
}

export function getPath(obj, path) {
  return String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function project(value, paths) {
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

export function lines(rows) {
  return rows.map((r) => {
    try { return JSON.stringify(r); } catch { return String(r); }
  }).join("\n");
}

/*
 * Follow Link rel="next" through a JSON collection. Stops at another origin,
 * a loop, a non-JSON reply, or the page cap. Every row is complete JSON.
 */
export async function fetchAllRows(tab, url, { pick, maxPages = 8, maxChars = 20000 } = {}) {
  let next = url;
  let firstOrigin = "";
  try { firstOrigin = new URL(url, tab.url).origin; } catch {}
  const pages = Math.min(20, Math.max(1, Number(maxPages) || 8));
  const rows = [];
  let used = 0;
  let note = "";
  const seen = new Set();
  for (let p = 0; next && p < pages; p++) {
    if (seen.has(next)) { note = "Pagination loop detected; stopped."; break; }
    seen.add(next);
    const res = await callPage(tab, "fetch", { url: next, method: "GET" });
    if (!res.ok) {
      note = `Stopped after ${p + 1} page(s): HTTP ${res.status}. ${typeof res.text === "string" ? res.text.slice(0, 300) : ""}`.trim();
      break;
    }
    if (res.json === undefined) {
      note = `Response was not JSON (${res.contentType || "unknown type"}). The API may need a different origin or headers.`;
      break;
    }
    const batch = Array.isArray(res.json)
      ? res.json
      : Array.isArray(res.json?.items) ? res.json.items
        : Array.isArray(res.json?.data) ? res.json.data
          : Array.isArray(res.json?.results) ? res.json.results
            : [res.json];
    for (const row of batch) {
      const one = pick?.length ? project(row, pick) : row;
      let line;
      try { line = JSON.stringify(one); } catch { line = String(one); }
      if (used + line.length + 1 > maxChars) {
        note = note || `Character cap reached; ${rows.length} item(s) shown, some omitted.`;
        return { rows, pages: p + 1, note, text: lines(rows) };
      }
      rows.push(one);
      used += line.length + 1;
    }
    const link = nextLink(res.link);
    if (!link) break;
    let parsed;
    try { parsed = new URL(link, res.url || tab.url); } catch { note = "Invalid next link; stopped."; break; }
    if (firstOrigin && parsed.origin !== firstOrigin) {
      note = `Stopped at a cross-origin next link (${parsed.origin}).`;
      break;
    }
    next = parsed.href;
    await sleep(250);
  }
  return { rows, pages: seen.size, note, text: lines(rows) };
}
