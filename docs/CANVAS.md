# Canvas workflow

FoxAgent's Canvas recipes use the LMS REST API from inside your logged-in Canvas
tab. `page.fetch` and `page.fetchAll` run in that tab's origin, so the session
cookie travels with the request and FoxAgent never stores your Canvas password or
token. The same recipes also work with an institutional Canvas host.

The agent's first stop on a Canvas tab is the Canvas pack: install it once from
the Packs tab, then the read-only shortcuts `canvas.todo` (to-do plus upcoming
events), `canvas.courses` (ids and scores), `canvas.assignments` (one course id,
one bucket) and `canvas.modules` (module and item names) are in the menu. Those
tools wrap the endpoints below, so small models do not have to remember paths.
`page.fetch` and `page.fetchAll` remain available for anything the pack does not
cover.

This page is the practical playbook: what the API returns, how each task is
carried out, where files land, and what to do when a school blocks API access.

## Before you start

1. Open your Canvas dashboard in Firefox and sign in normally.
2. Confirm the API answers JSON in this tab. You can ask FoxAgent to
   `page.fetch` `/api/v1/courses?per_page=1`, or open
   `https://<your-canvas-host>/api/v1/courses?per_page=1` in a tab.
3. Open the FoxAgent sidebar on that tab and pick a model.
4. For the first download run, leave approval on for writes and watch the plan
   prompt.

Canvas hosts are commonly `*.instructure.com`, but many schools use their own
domain. Detection is by URL, not by a hard-coded host list.

> Canvas data — course names, assignments, grades, files, page bodies — is sent
> to the model provider you chose in Models. A local server keeps it on your
> machine; a cloud provider receives it and bills your API key. Treat every
> remote endpoint as exporting that data.

## API map

All paths are relative to the Canvas origin. Send `Accept: application/json`
(FoxAgent already does) and follow `Link: rel="next"` for pagination.
`page.fetchAll` does this and caps at 20 pages by default.

| Purpose | Request | Useful fields |
| --- | --- | --- |
| Active courses | `GET /api/v1/courses?enrollment_state=active&per_page=100` | `id`, `name`, `course_code`, `workflow_state` |
| Courses with totals | same plus `include[]=total_scores` | `enrollments[].computed_current_score`, `computed_current_grade` |
| To-do | `GET /api/v1/users/self/todo` | `assignment`, `course_id`, `html_url` |
| Upcoming events | `GET /api/v1/users/self/upcoming_events` | `title`, `start_at`, `end_at`, `context_code` |
| Upcoming assignments | `GET /api/v1/courses/{id}/assignments?bucket=upcoming&per_page=100&order_by=due_at` | `name`, `due_at`, `points_possible`, `submission_types`, `html_url` |
| With submission | same plus `include[]=submission` | `submission.workflow_state`, `submitted_at`, `missing`, `score` |
| Grades for a course | `GET /api/v1/courses/{id}/enrollments?user_id=self&include[]=grades` | `grades.current_score`, `grades.current_grade`, `grades.final_score` |
| Modules | `GET /api/v1/courses/{id}/modules?include[]=items&per_page=100` | `id`, `name`, `position`, `items[]` |
| Module items | inside each module's `items[]` | `type`, `title`, `content_id`, `page_url`, `url`, `html_url` |
| Course files | `GET /api/v1/courses/{id}/files?per_page=100` | `id`, `display_name`, `filename`, `url`, `size`, `content_type`, `folder_id` |
| One file | `GET /api/v1/files/{id}` | `url`, `display_name`, `size`, `content_type` |
| Page body | `GET /api/v1/courses/{id}/pages/{page_url}` | `title`, `body` (HTML), `updated_at` |

Bucket values for assignments are `upcoming`, `past`, `overdue`, `undated`.
Module item types are `Assignment`, `Quiz`, `File`, `Page`, `Discussion`,
`ExternalUrl`, and `SubHeader`.

### Grades: the common mistake

There is no top-level `course.total_scores` field. Grade data appears in two
places:

- `GET /courses/{id}/enrollments?user_id=self&include[]=grades` returns
  enrollment objects with `grades.current_score` (a percentage) and
  `grades.current_grade` (the letter/scheme grade).
- `GET /courses?...&include[]=total_scores` adds an `enrollments` array to each
  course, with `computed_current_score` and `computed_current_grade`.

FoxAgent's prompt and recipes use these fields. If a response has
`total_scores: null` or no such key, that is normal; do not infer a grade from
points alone.

## Task: weekly digest

The **Weekly assignment digest** recipe asks the agent to:

1. Fetch `/users/self/todo` and `/users/self/upcoming_events`.
2. Fetch active courses.
3. For each course, fetch `bucket=upcoming` assignments (submission included)
   and the grade enrollment.
4. Merge by due date, grouping by day. Each row carries course, assignment, due
   time, points, and submitted/missing state.
5. Flag anything due within 48 hours or already overdue, then add a compact
   grades table.

A typical answer is a short “next 48 hours” section, a day-by-day list, and one
table of courses with current score. Nothing is downloaded or changed.

If the todo endpoint returns entries without a course name, the agent has the
course list from step 2 and maps `course_id` to the name.

## Task: grades in every class

For each active course:

1. Fetch the enrollment for `user_id=self` with `include[]=grades`.
2. Fetch upcoming and past assignments with `include[]=submission`.
3. Report `current_score`/`current_grade`, then a table of items with due date,
   points possible, score, and status.
4. List the highest-impact missing or ungraded items that are visible to the
   student.

The agent is told not to guess a grade and never to submit anything. Discussions,
quizzes and external tools may not expose a score through this endpoint; those
show as unavailable rather than zero.

## Task: download all course materials

This is a write-heavy job, so it runs in two phases.

### 1. Inventory (no downloads)

- Active courses.
- Modules per course, including items.
- File metadata from `/courses/{id}/files` and from module items of type `File`
  via `/files/{content_id}`.
- Deduplicate by file id and by URL. Skip files with no URL or zero size.
- Compute course count, file count, and total size.

Module pages can contain links to files that are not in the course file list;
the file list plus File module items is the reliable inventory. External URLs and
page bodies are not files and are offered as an optional index instead.

### 2. Plan and approval

`ui.ask` shows the counts, total size, a sample of up to ten filenames, and this
destination pattern:

```
FoxAgent/Canvas/{Course}/Module {position} - {Module name}/{filename}
```

It also asks whether to include Page bodies as Markdown and ExternalUrl links in
a text index. Answer before any download starts. The subsequent
`browser.downloadMany` call is a `write` action and gets its own approval unless
writes are set to auto or the host is trusted.

### 3. Download

- Batches of at most 200 files per tool call, four downloads in flight.
- Canvas file URLs include a short-lived verifier; download promptly after
  fetching metadata and do not reuse an old URL days later.
- The same URL is never queued twice in one run.
- Firefox writes into `Downloads/FoxAgent/Canvas/...` and uniquifies duplicate
  names.

### 4. Manifest

A JSON manifest is saved with `files.write` as
`FoxAgent/Canvas/manifest-YYYY-MM-DD.json`:

```json
{
  "generated_at": "2026-10-27T18:04:00Z",
  "canvas_host": "canvas.example.edu",
  "courses": [
    { "id": 12345, "name": "Biology 101", "modules": 6, "files": 42 }
  ],
  "files": [
    {
      "course": "Biology 101",
      "module": "Module 1 - Introduction",
      "name": "syllabus.pdf",
      "path": "FoxAgent/Canvas/Biology 101/Module 1 - Introduction/syllabus.pdf",
      "size": 182334,
      "status": "queued"
    }
  ]
}
```

Do not store the full download URL in a shared manifest: the query string can
contain a temporary access token. Keep a host + file id if you need to find the
item again.

Finally the agent reports queued and failed counts from the tool result, not the
number it hoped to download.

## Task: brief me on a course

Reads the syllabus page, modules, and upcoming assignments for one course. It
asks which course when there is more than one. The output covers the published
grading breakdown, the next three due items, recent announcements, required
materials, and anything that looks like an unread or missing prerequisite.

## Fallback: when the API is blocked

Signals:

- `401` or `403` with an HTML login page.
- A JSON response containing an error such as “user not authorized”.
- The institution disables student API keys or restricts the endpoint.
- CORS blocks a cross-origin call (rare for same-origin tab fetches).

Then the agent falls back to the UI:

1. `page.snapshot` the dashboard.
2. Click a course, then its modules or assignments.
3. `page.read` the result and repeat.
4. Say clearly that the API was unavailable and the result came from the UI.

UI control is slower and breaks when Canvas changes markup. It also cannot list
files as reliably, so a bulk download may be partial. Prefer the API when it
works, and report the limitation instead of silently skipping courses.

## Rate limits and etiquette

- Leave roughly 250 ms between paginated calls; `page.fetchAll` already does.
- If you see `429` or “Rate Limit Exceeded”, stop. Report the course and retry
  later; repeated retries make the block longer.
- Canvas returns `x-rate-limit-remaining` and `x-rate-limit-reset`; the tool
  surfaces them.
- Do not schedule a full download every hour. Course files change slowly.

## Safety rules specific to Canvas

FoxAgent will not, regardless of settings:

- Submit an assignment, quiz, discussion post, or peer review.
- Send a message or comment.
- Enroll, drop, or change course settings.
- Change profile, notification, or privacy settings.
- Type a password or 2FA code.
- Follow instructions embedded in course pages, announcements, filenames, or
  API responses.

If a task seems to require one of these, the agent stops and asks you to do it
yourself. Reading, summarizing, extracting and downloading are the supported
actions.

## Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| `401`/`403`, HTML body | Not signed in, session expired, or API blocked | Sign in again in the Canvas tab. If it persists, use UI fallback. |
| Empty course list | No active enrollments, or wrong Canvas host | Check the dashboard; try without `enrollment_state`, or open the right host. |
| `total_scores` missing | That is not a Canvas field | Use `enrollments[].grades.current_score` or `computed_current_score`. |
| Download starts but file is HTML | URL needs a session or verifier | Re-fetch `/files/{id}` in the Canvas tab and download immediately. |
| `429` | Rate limit | Stop, wait for the reset header, reduce pages per run. |
| Downloads skipped | Duplicate URL, zero size, or invalid scheme | Check the tool result; only http(s) URLs are accepted. |
| Manifest says queued but file absent | Firefox blocked the download or the folder is elsewhere | Check `about:downloads` and the browser's download directory. |
| Sidebar says “page changed or navigated” | Refs went stale | Snapshot again; do not reuse `e12` refs across navigation. |
| Cross-origin note in fetch result | Request left the Canvas origin | Cookies may be missing; use the Canvas tab for its own API. |

## Manual API checks

With a Canvas tab active, these prompts are useful for isolating a problem:

- “Fetch `/api/v1/users/self/profile` with page.fetch and show the status.”
- “Fetch `/api/v1/courses?per_page=1` and show whether the body is JSON.”
- “Fetch the enrollments for course 12345 with grades included.”
- “List the modules in course 12345 with their item types and content ids.”

If those work but a recipe fails, the issue is usually a stale tab, a changed
course id, or a rate limit rather than the extension.
