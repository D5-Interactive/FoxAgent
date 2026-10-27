import { pageTab, hostOf, fetchAllRows, lines, clip, hostMatches } from "../sdk.js";
const PATTERNS = ["*.instructure.com", "canvas.*"];
async function canvasTab(args, ctx) {
  const tab = await pageTab(args, ctx);
  if (!hostMatches(hostOf(tab.url), PATTERNS)) {
    throw new Error(`This tab is not Canvas (${hostOf(tab.url) || "unknown host"}). Open your Canvas tab and run the task there.`);
  }
  return tab;
}
const tools = [
  {
    name: "canvas.todo",
    description: 'Canvas: everything due soon and upcoming events, already merged and sorted. Use this first for "what do I have due". Read-only.',
    risk: "read",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        maxChars: { type: "integer", description: "Default 12000." }
      }
    },
    async run(args, ctx) {
      const tab = await canvasTab(args, ctx);
      const maxChars = args.maxChars || 12e3;
      const todo = await fetchAllRows(tab, "/api/v1/users/self/todo?per_page=100", {
        pick: ["type", "assignment.name", "assignment.due_at", "assignment.points_possible", "course_id", "html_url"],
        maxPages: 3,
        maxChars
      });
      const events = await fetchAllRows(tab, "/api/v1/users/self/upcoming_events?per_page=100", {
        pick: ["title", "start_at", "end_at", "context_name", "html_url"],
        maxPages: 2,
        maxChars
      });
      const head = `TODO (${todo.rows.length})${todo.note ? ` - ${todo.note}` : ""}
`;
      const mid = `
UPCOMING EVENTS (${events.rows.length})${events.note ? ` - ${events.note}` : ""}
`;
      return clip(head + todo.text + mid + events.text, maxChars + 800);
    }
  },
  {
    name: "canvas.courses",
    description: "Canvas: your active courses with ids and current scores. Call this before any per-course tool; do not guess course ids.",
    risk: "read",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        maxChars: { type: "integer", description: "Default 10000." }
      }
    },
    async run(args, ctx) {
      const tab = await canvasTab(args, ctx);
      const maxChars = args.maxChars || 1e4;
      const result = await fetchAllRows(
        tab,
        "/api/v1/courses?enrollment_state=active&per_page=100&include[]=total_scores",
        { pick: ["id", "name", "course_code", "computed_current_score", "computed_current_grade"], maxPages: 3, maxChars }
      );
      return clip(`COURSES (${result.rows.length})${result.note ? ` - ${result.note}` : ""}
${result.text}`, maxChars + 400);
    }
  },
  {
    name: "canvas.assignments",
    description: "Canvas: assignments for one course id, in one bucket (upcoming, past, overdue, undated). Returns dates, points and links. Read-only.",
    risk: "read",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        courseId: { type: "integer", description: "From canvas.courses." },
        bucket: { type: "string", enum: ["upcoming", "past", "overdue", "undated"], description: "Default upcoming." },
        tabId: { type: "integer" },
        maxChars: { type: "integer", description: "Default 12000." }
      },
      required: ["courseId"]
    },
    async run(args, ctx) {
      const tab = await canvasTab(args, ctx);
      const courseId = Number(args.courseId);
      if (!Number.isFinite(courseId)) throw new Error("courseId must be a number from canvas.courses.");
      const bucket = String(args.bucket || "upcoming");
      if (!["upcoming", "past", "overdue", "undated"].includes(bucket)) throw new Error(`Unknown bucket ${bucket}.`);
      const maxChars = args.maxChars || 12e3;
      const result = await fetchAllRows(
        tab,
        `/api/v1/courses/${courseId}/assignments?bucket=${bucket}&per_page=100&order_by=due_at`,
        { pick: ["id", "name", "due_at", "points_possible", "has_submitted_submissions", "html_url"], maxPages: 4, maxChars }
      );
      return clip(`ASSIGNMENTS course ${courseId} / ${bucket} (${result.rows.length})${result.note ? ` - ${result.note}` : ""}
${result.text}`, maxChars + 400);
    }
  },
  {
    name: "canvas.modules",
    description: "Canvas: module names and item titles for one course id. Use before downloading materials. Read-only.",
    risk: "read",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        courseId: { type: "integer", description: "From canvas.courses." },
        tabId: { type: "integer" },
        maxChars: { type: "integer", description: "Default 12000." }
      },
      required: ["courseId"]
    },
    async run(args, ctx) {
      const tab = await canvasTab(args, ctx);
      const courseId = Number(args.courseId);
      if (!Number.isFinite(courseId)) throw new Error("courseId must be a number from canvas.courses.");
      const maxChars = args.maxChars || 12e3;
      const result = await fetchAllRows(
        tab,
        `/api/v1/courses/${courseId}/modules?include[]=items&per_page=100`,
        { maxPages: 4, maxChars }
      );
      const compact = result.rows.map((m) => ({
        id: m.id,
        name: m.name,
        position: m.position,
        items: Array.isArray(m.items) ? m.items.map((i) => `${i.type}: ${i.title}`) : []
      }));
      return clip(`MODULES course ${courseId} (${compact.length})${result.note ? ` - ${result.note}` : ""}
${lines(compact)}`, maxChars + 400);
    }
  }
];
const prompt = [
  "Canvas: use the canvas.* tools instead of writing API paths.",
  "canvas.todo for what is due, canvas.courses for ids and scores, canvas.assignments for one course and bucket, canvas.modules before downloads.",
  "Never guess a course id. On 401/403 or HTML instead of JSON, the institution blocks the API: fall back to snapshot/click and say so. On 429, stop and report it.",
  "Reading, summarizing and downloading are the job. Never submit assignments, post, message, change settings, or enroll/drop.",
  "Before a large download, use ui.ask with counts, total size, a sample of filenames and the destination pattern. Use browser.downloadMany in batches, keep a manifest with files.write, and skip duplicate URLs."
].join(" ");
export {
  prompt,
  tools
};
