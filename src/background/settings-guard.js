/*
 * The sidebar is display code. It may change known settings, but never
 * provider credentials, base URLs or unknown keys: those have dedicated
 * messages (saveKey/forgetKey/useModel/refreshModels) with their own checks.
 */

import { PROVIDERS } from "./store.js";

const SETTINGS_KEYS = new Set([
  "provider", "temperature", "maxSteps", "toolMode", "contextChars", "maxPageChars",
  "approval", "dryRun", "trustedSites", "siteAllowlist", "autoIncludePage",
  "packs", "autoUpdate", "vision",
]);

export const hostList = (value) => (Array.isArray(value) ? value : [])
  .map((v) => String(v || "").toLowerCase().trim())
  .filter((v) => v && !/\s/.test(v))
  .slice(0, 200);

export function cleanSettingsPatch(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const [key, value] of Object.entries(input)) {
    if (!SETTINGS_KEYS.has(key)) continue;
    switch (key) {
      case "provider":
        if (PROVIDERS[value]) out.provider = String(value);
        break;
      case "temperature":
        out.temperature = Math.max(0, Math.min(2, Number(value) || 0));
        break;
      case "maxSteps":
        out.maxSteps = Math.max(1, Math.min(80, Number(value) || 32));
        break;
      case "contextChars":
        out.contextChars = Math.max(8000, Math.min(400000, Number(value) || 48000));
        break;
      case "maxPageChars":
        out.maxPageChars = Math.max(2000, Math.min(60000, Number(value) || 12000));
        break;
      case "toolMode":
        if (["auto", "native", "json"].includes(value)) out.toolMode = value;
        break;
      case "vision":
        if (["auto", "on", "off"].includes(value)) out.vision = value;
        break;
      case "dryRun":
      case "autoIncludePage":
      case "autoUpdate":
        out[key] = Boolean(value);
        break;
      case "packs":
        out.packs = (Array.isArray(value) ? value : [])
          .map((id) => String(id || "").trim().toLowerCase())
          .filter((id) => /^[a-z0-9][a-z0-9-]*$/.test(id))
          .slice(0, 30);
        break;
      case "trustedSites":
      case "siteAllowlist":
        out[key] = hostList(value);
        break;
      case "approval": {
        const modes = ["auto", "confirm"];
        const clean = {};
        for (const level of ["read", "act", "write"]) {
          const mode = value?.[level];
          if (modes.includes(mode)) clean[level] = mode;
        }
        if (Object.keys(clean).length) out.approval = clean;
        break;
      }
      default:
        break;
    }
  }
  return out;
}
