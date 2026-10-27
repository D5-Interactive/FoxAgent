const RECIPES = [
  {
    id: "canvas.weekly",
    tag: "Canvas",
    title: "Weekly assignment digest",
    hint: "Due dates, upcoming events, overdue work, and grades at a glance.",
    prompt: [
      "Build my Canvas weekly digest for the active Canvas tab.",
      "Use the Canvas API and page.fetchAll. Start with /api/v1/users/self/todo and /api/v1/users/self/upcoming_events, then /api/v1/courses?enrollment_state=active&per_page=100, then each course's upcoming assignments (bucket=upcoming) and grade enrollment (/api/v1/courses/{id}/enrollments?user_id=self&include[]=grades).",
      "Grades live in enrollments[].grades.current_score / current_grade for each course, or computed_current_score in the course list when include[]=total_scores was requested; never read a top-level course.total_scores field.",
      "Group everything by day with course, assignment, due time, points, and submitted state. Flag anything due in the next 48 hours and anything overdue. Add a compact grades table from the enrollments data.",
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
      "For each course, fetch /api/v1/courses/{id}/enrollments?user_id=self&include[]=grades and report current_score, current_grade and the grading period if present. Also fetch upcoming and past assignments with the submission included to find missing or ungraded work that I can see.",
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
  },
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
