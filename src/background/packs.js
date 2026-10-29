import { PACK_MODULES } from "../../packs/registry.js";
import { hostMatches } from "./hosts.js";
const LOCAL_INDEX = "packs/index.json";
const REMOTE_INDEX = "https://raw.githubusercontent.com/D5-Interactive/FoxAgent/main/packs/index.json";
let catalogPromise = null;
async function readJson(url) {
  const res = await fetch(url, { credentials: "omit", cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}
async function loadLocal() {
  const ids = await readJson(browser.runtime.getURL(LOCAL_INDEX));
  const list = Array.isArray(ids?.packs) ? ids.packs : [];
  const packs = [];
  for (const id of list) {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(String(id))) continue;
    try {
      const meta = await readJson(browser.runtime.getURL(`packs/${id}/pack.json`));
      if (!meta || meta.id !== id) continue;
      packs.push({
        id,
        name: String(meta.name || id),
        version: String(meta.version || "0.0.0"),
        description: String(meta.description || ""),
        hosts: Array.isArray(meta.hosts) ? meta.hosts.map(String) : [],
        author: String(meta.author || ""),
        icon: browser.runtime.getURL(`packs/${id}/icon.svg`)
      });
    } catch (err) {
      console.warn(`FoxAgent: could not load pack ${id}`, err);
    }
  }
  return packs;
}
function loadCatalog() {
  if (!catalogPromise) catalogPromise = loadLocal().catch((err) => {
    console.warn("FoxAgent: could not load the pack catalog", err);
    catalogPromise = null;
    return [];
  });
  return catalogPromise;
}
async function packList(enabledIds = [], host = "") {
  const enabled = new Set(enabledIds);
  const packs = await loadCatalog();
  return packs.map((pack) => ({
    ...pack,
    enabled: enabled.has(pack.id),
    active: enabled.has(pack.id) && matchesAny([host], pack.hosts)
  }));
}
function moduleFor(pack) {
  return PACK_MODULES[pack.id] || { tools: [], prompt: "" };
}
function matchesAny(hosts, patterns) {
  if (!(patterns || []).length) return true;
  return (hosts || []).some((host) => hostMatches(host, patterns));
}
async function activeModules(enabledIds, hosts) {
  const packs = await loadCatalog();
  const enabled = new Set(enabledIds);
  const out = [];
  for (const pack of packs) {
    if (!enabled.has(pack.id)) continue;
    if (!matchesAny(hosts, pack.hosts)) continue;
    const mod = moduleFor(pack);
    out.push({ pack, mod });
  }
  return out;
}
async function packTools(enabledIds, hosts) {
  const mods = await activeModules(enabledIds, hosts);
  const seen = new Set();
  const tools = [];
  for (const { mod } of mods) {
    for (const tool of Array.isArray(mod.tools) ? mod.tools : []) {
      if (!tool?.name || seen.has(tool.name)) continue;
      seen.add(tool.name);
      tools.push(tool);
    }
  }
  return tools;
}
async function packPrompts(enabledIds, host) {
  const mods = await activeModules(enabledIds, [host]);
  return mods.filter(({ mod }) => typeof mod.prompt === "string" && mod.prompt.trim()).map(({ pack, mod }) => ({ id: pack.id, name: pack.name, prompt: mod.prompt.trim() }));
}
async function packRecipes(enabledIds, host) {
  const mods = await activeModules(enabledIds, [host]);
  return mods.flatMap(({ mod }) => Array.isArray(mod.recipes) ? mod.recipes : []);
}
async function packDescription(id) {
  const packs = await loadCatalog();
  const pack = packs.find((p) => p.id === id);
  if (!pack) throw new Error("Unknown pack.");
  try {
    const res = await fetch(browser.runtime.getURL(`packs/${id}/desc.md`), { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    return (await res.text()).slice(0, 2e4);
  } catch {
    return pack.description;
  }
}
async function checkRemotePacks() {
  const local = await loadCatalog();
  const localIds = new Set(local.map((p) => p.id));
  const remote = await readJson(REMOTE_INDEX);
  const ids = (Array.isArray(remote?.packs) ? remote.packs : []).map((id) => String(id)).filter((id) => /^[a-z0-9][a-z0-9-]*$/i.test(id));
  const newPacks = ids.filter((id) => !localIds.has(id));
  const missing = [...localIds].filter((id) => !ids.includes(id));
  return {
    checkedAt: Date.now(),
    remoteCount: ids.length,
    newPacks,
    missing
  };
}
export {
  checkRemotePacks,
  loadCatalog,
  packDescription,
  packList,
  packPrompts,
  packRecipes,
  packTools
};
