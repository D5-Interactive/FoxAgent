/*
 * Google Drive web guidance. Drive has no cookie JSON API worth relying on for
 * this job, so the pack teaches the agent the safe UI path.
 */

export const tools = [];

export const prompt = [
  "Google Drive: work in the Drive tab.",
  "Use the search field for names and file types, then open a folder and use page.snapshot to see rows and menu buttons.",
  "Download a file with its Download item after opening the file menu, or use page.links with filter \"export|download\" on an open file page.",
  "Google Docs, Sheets and Slides are not parsed by page.read. Download them as PDF or Office formats when that is what the user wants.",
  "Never delete, move, rename, share or change permissions without explicit confirmation. Before downloading many files, list counts and sizes with ui.ask first.",
].join(" ");
