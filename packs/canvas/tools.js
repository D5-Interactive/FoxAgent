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
  },
  {
    name: "canvas.digest",
    description: "Canvas: active courses with current scores plus every upcoming assignment across them, sorted by due date. Use this for a weekly brief instead of looping per course.",
    risk: "read",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        maxCourses: { type: "integer", description: "1-30, default 15." },
        tabId: { type: "integer" },
        maxChars: { type: "integer", description: "Default 24000." }
      }
    },
    async run(args, ctx) {
      const tab = await canvasTab(args, ctx);
      const maxChars = args.maxChars || 24e3;
      const courseLimit = Math.min(30, Math.max(1, Number(args.maxCourses) || 15));
      const courses = await fetchAllRows(
        tab,
        "/api/v1/courses?enrollment_state=active&per_page=100&include[]=total_scores",
        { pick: ["id", "name", "computed_current_score", "computed_current_grade"], maxPages: 2, maxChars: 8e3 }
      );
      const list = courses.rows.slice(0, courseLimit);
      const grades = list.map((c) => `${c.id} ${c.name}: ${c.computed_current_score ?? "?"}${c.computed_current_grade ? ` (${c.computed_current_grade})` : ""}`).join("\n");
      const upcoming = [];
      for (const course of list) {
        const res = await fetchAllRows(
          tab,
          `/api/v1/courses/${course.id}/assignments?bucket=upcoming&per_page=100&order_by=due_at`,
          { pick: ["id", "name", "due_at", "points_possible", "has_submitted_submissions"], maxPages: 2, maxChars: 6e3 }
        );
        for (const assignment of res.rows) upcoming.push({ course: course.name, ...assignment });
      }
      upcoming.sort((a, b) => String(a.due_at || "9999").localeCompare(String(b.due_at || "9999")));
      const note = courses.note ? `\n${courses.note}` : "";
      return clip(`COURSES (${list.length})${courses.rows.length > list.length ? `, first ${list.length}` : ""}${note}\n${grades}\n\nUPCOMING (${upcoming.length})\n${lines(upcoming)}`, maxChars);
    }
  }
];
const recipes = [
  {
    id: "canvas.weekly",
    tag: "Canvas",
    title: "Weekly assignment digest",
    hint: "Due dates, upcoming events, overdue work, and grades at a glance.",
    prompt: [
      "Build my Canvas weekly digest for the active Canvas tab.",
      "Use canvas.digest for active courses, current scores and every upcoming assignment in one call, and canvas.todo for to-do items and upcoming events. Do not fetch per-course grade enrollments: canvas.digest already includes each course's computed score.",
      "Group everything by day with course, assignment, due time, points, and submitted state. Flag anything due in the next 48 hours and anything overdue. Add a compact grades table from the COURSES block.",
      "Do not download or submit anything. If an API call fails, tell me and fall back to the UI only if it is quick."
    ].join("\n")
  },
  {
    id: "canvas.grades",
    tag: "Canvas",
    title: "Check grades in every class",
    hint: "Current score per course plus missing or ungraded work.",
    prompt: [
      "Check my grades in every active Canvas course.",
      "Use canvas.courses for current scores and grades. Then use canvas.assignments with bucket=past for each course id to find missing work (has_submitted_submissions). Do not fetch enrollment endpoints per course.",
      "Present one table per course: item, due date, points possible, score, status. Then a short list of the highest-impact missing items. Never guess a grade and never submit anything."
    ].join("\n")
  },
  {
    id: "canvas.materials",
    tag: "Canvas",
    title: "Download all course materials",
    hint: "Every file in every module, sorted into course folders with a manifest.",
    prompt: [
      "Download all materials from every module in every active Canvas course.",
      "First inventory without downloading: list active courses, then each course's modules with items, then the files (/api/v1/courses/{id}/files?per_page=100, plus module File items by content_id through /api/v1/files/{id}). Skip duplicate URLs and empty files.",
      "Then use ui.ask to show me: number of courses, number of files, total size, a sample of up to ten filenames, and the destination pattern (FoxAgent/Canvas/{Course}/Module {n} - {Name}/{filename}). Also ask whether to include Page bodies as Markdown and ExternalUrl links in a text index. Wait for my answer.",
      "Download in batches with browser.downloadMany (at most 200 per call), keep a manifest of course, module, filename, size and status, and save it with files.write as FoxAgent/Canvas/manifest-YYYY-MM-DD.json. Replace slashes in course, module and file names with '-' so they stay single folder names. Report queued and failed counts. Do not download the same file twice and do not click through the UI unless the API is blocked."
    ].join("\n")
  },
  {
    id: "canvas.course",
    tag: "Canvas",
    title: "Brief me on a course",
    hint: "What this course expects, what is due, and what is missing.",
    prompt: [
      "Give me a briefing on one Canvas course. If there is more than one active course, use ui.ask to ask which one.",
      "Read the syllabus page, modules and upcoming assignments. Report: the grading breakdown if published, the next three due items with dates, recent announcements, required materials, and anything that looks like a missing prerequisite or unread module.",
      "Keep it under 300 words and do not change anything in Canvas."
    ].join("\n")
  }
];
const prompt = [
  "Canvas: use the canvas.* tools instead of writing API paths.",
  "canvas.digest for a weekly brief: courses, current scores and every upcoming assignment in one call. canvas.todo for to-do and events, canvas.courses for ids, canvas.assignments for one course and bucket, canvas.modules before downloads.",
  "Never guess a course id. On 401/403 or HTML instead of JSON, the institution blocks the API: fall back to snapshot/click and say so. On 429, stop and report it.",
  "Reading, summarizing and downloading are the job. Never submit assignments, post, message, change settings, or enroll/drop.",
  "Before a large download, use ui.ask with counts, total size, a sample of filenames and the destination pattern. Use browser.downloadMany in batches, keep a manifest with files.write, and skip duplicate URLs."
].join(" ");
export {
  prompt,
  recipes,
  tools
};
