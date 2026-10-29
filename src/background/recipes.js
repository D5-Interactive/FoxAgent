const RECIPES = [
  {
    id: "page.markdown",
    tag: "Page",
    title: "Extract this page to Markdown",
    hint: "Clean article text, saved as a .md file you can keep.",
    prompt: [
      "Extract the main content of the active tab as clean Markdown.",
      "Read it, remove navigation and boilerplate, keep headings, lists, tables, code and links. Then save it with files.write to FoxAgent/markdown/<site>-<slug>-YYYY-MM-DD.md and tell me the filename, word count, and the five main sections.",
      "If the page is a PDF or a JavaScript app with no readable text, say so instead of inventing content."
    ].join("\n")
  },
  {
    id: "page.audit",
    tag: "Page",
    title: "Check this page",
    hint: "Links, dated claims, stale info, and a quick credibility read.",
    prompt: [
      "Check the active page for problems.",
      "Read the content, list its links (page.links), and report: broken-looking or suspicious links (do not follow all of them; check at most five with web.fetch), claims with dates that are now in the past, obvious contradictions, missing sources, and anything that looks like a scam or phishing pattern.",
      "Give me a short verdict: what the page is, whether it looks current, and the three things I should verify myself."
    ].join("\n")
  },
  {
    id: "tabs.digest",
    tag: "Page",
    title: "Digest my open tabs",
    hint: "Group what is open, find the thread, and close nothing.",
    prompt: [
      "Look at my open tabs (browser.tabs) and tell me what I am working on.",
      "Pick the tabs that belong to the same task, read the most relevant two or three with page.read, and summarize the through-line. List tabs that look like duplicates or dead ends, but do not close anything."
    ].join("\n")
  },
  {
    id: "doc.review",
    tag: "Page",
    title: "Review a document",
    hint: "Summary, key facts, risks, and questions to ask.",
    prompt: [
      "Review the document or long page in the active tab.",
      "Give me: a five-bullet summary, the key numbers and dates in a table, obligations or deadlines, anything ambiguous that I should clarify, and the three questions I should ask the author.",
      "Quote short phrases for anything important. If the document is a PDF that these tools cannot read, say so and offer to download it."
    ].join("\n")
  }
];
export {
  RECIPES
};
