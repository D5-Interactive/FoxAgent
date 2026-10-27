/*
 * Pack SDK. A pack gets the same page helpers and clipping rules as the
 * built-in tools, so pack output cannot flood a small model's context.
 *
 * Pack modules export:
 *   export const tools = [ ...tool specs, same shape as src/background/tools.js ]
 *   export const prompt = "Short, site-specific guidance."
 */

import { callPage, resolveTab, hostOf } from "../src/background/page.js";
import { fetchAllRows, lines, project, nextLink } from "../src/background/rows.js";

export { callPage, resolveTab, hostOf, fetchAllRows, lines, project, nextLink };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function clip(value, max = 20000) {
  const s = String(value ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n[truncated: ${s.length - max} more characters. Narrow the request if you need the rest.]`;
}

export function hostMatches(host, patterns) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  if (!h) return false;
  const list = Array.isArray(patterns) ? patterns : [];
  if (!list.length) return true;
  return list.some((raw) => {
    const p = String(raw || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    if (!p) return false;
    const regex = new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return regex.test(h);
  });
}

/*
 * Resolve the tab a pack tool should read. An explicit tabId wins; otherwise
 * the session's pinned tab, never the active tab.
 */
export async function pageTab(args, ctx) {
  const tab = await resolveTab(args.tabId, ctx.session?.tabId);
  ctx.activeTab = tab;
  return tab;
}
