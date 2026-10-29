# Canvas LMS pack

Read-only shortcuts for the Canvas REST API. FoxAgent runs them inside your
logged-in Canvas tab, so the session cookie travels with each request and no
Canvas password or token is stored.

## Tools

- `canvas.digest` returns active courses, current scores and every upcoming
  assignment in one call.
- `canvas.todo` merges your to-do list with upcoming events.
- `canvas.courses` lists active courses with ids and current scores.
- `canvas.assignments` returns one course's assignments for a bucket:
  upcoming, past, overdue or undated.
- `canvas.modules` lists module and item names for one course.

## Boundaries

The pack never submits assignments, posts to discussions, sends messages or
changes course settings. Downloads are proposed with counts, size and a sample
of filenames before a batch starts. If your school blocks API access, the agent
falls back to the page UI and tells you.

## Hosts

Enabled on `*.instructure.com` and institutional hosts that start with
`canvas.`. If your school uses a different hostname, open the pack editor and
add it to `hosts` in `pack.json`.
