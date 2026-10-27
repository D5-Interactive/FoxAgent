import { callPage, resolveTab, hostOf } from "../src/background/page.js";
import { fetchAllRows, lines, project } from "../src/background/rows.js";
import { hostMatches } from "../src/background/hosts.js";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function clip(value, max = 2e4) {
  const s = String(value ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + `

[truncated: ${s.length - max} more characters. Narrow the request if you need the rest.]`;
}
async function pageTab(args, ctx) {
  const tab = await resolveTab(args.tabId, ctx.session?.tabId);
  ctx.activeTab = tab;
  return tab;
}
export {
  callPage,
  clip,
  fetchAllRows,
  hostMatches,
  hostOf,
  lines,
  pageTab,
  project,
  resolveTab,
  sleep
};
