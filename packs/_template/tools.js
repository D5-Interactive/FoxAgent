/*
 * Example pack. Copy this directory and rename it, then:
 *   1. Change id, name, version, description and hosts in pack.json.
 *   2. Add the new id to packs/index.json.
 *   3. Keep tools read-only unless the site genuinely needs a write.
 *
 * A tool has the same shape as the built-in tools: name, description, risk,
 * needsPage, parameters (JSON schema) and run(args, ctx). Use ctx.session for
 * the tab pinned to the run and ctx.settings for user settings.
 */

import { pageTab, clip } from "../sdk.js";

export const tools = [
  {
    name: "example.tabInfo",
    description: "Example read-only tool. Returns the title and URL of the tab the task is pinned to.",
    risk: "read",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "integer", description: "Optional tab id. Defaults to this task's tab." },
      },
    },
    async run(args, ctx) {
      const tab = await pageTab(args, ctx);
      return clip(`TITLE: ${tab.title || "(no title)"}\nURL: ${tab.url || ""}`);
    },
  },
];

export const prompt = [
  "Example pack: replace this with two or three sentences of site-specific guidance.",
  "Say what to click first, what to read, and what this pack must never do.",
].join(" ");
