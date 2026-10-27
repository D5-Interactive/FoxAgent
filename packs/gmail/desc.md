# Gmail pack

A playbook, not an API. Gmail web has no simple cookie-authenticated JSON
endpoint, so the agent drives the page you are already signed in to and uses the
core reading and clicking tools.

## What it helps with

- Search queries typed into the Gmail search field.
- Reading an open thread and summarizing it.
- Finding attachment links and downloading them into a folder.
- Drafting a message field by field.

## Safety

The pack tells the agent to draft and ask before sending. It must not delete,
archive, label or change settings without explicit confirmation. Attachments
are downloaded through the normal download approval.

## Hosts

`mail.google.com`.
