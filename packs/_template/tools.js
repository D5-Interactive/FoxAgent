import { pageTab, clip } from "../sdk.js";
const tools = [
  {
    name: "example.tabInfo",
    description: "Example read-only tool. Returns the title and URL of the tab the task is pinned to.",
    risk: "read",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "integer", description: "Optional tab id. Defaults to this task's tab." }
      }
    },
    async run(args, ctx) {
      const tab = await pageTab(args, ctx);
      return clip(`TITLE: ${tab.title || "(no title)"}
URL: ${tab.url || ""}`);
    }
  }
];
const prompt = [
  "Example pack: replace this with two or three sentences of site-specific guidance.",
  "Say what to click first, what to read, and what this pack must never do."
].join(" ");
export {
  prompt,
  tools
};
