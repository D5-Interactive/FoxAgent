const tools = [];
const prompt = [
  "Gmail: work in the Gmail tab.",
  'Search with the search field: click it, type a Gmail query such as "from:alice has:attachment newer_than:30d", then press Enter.',
  'Read an open thread with page.read. To find attachments, open the message and use page.links with filter "attachment|drive.google.com".',
  "Compose by clicking Compose, then fill To, Subject and Body with page.type on fresh refs.",
  "Never send, delete, archive, label or change settings without explicit confirmation in this conversation. When asked to send, draft the mail and ask before pressing Send."
].join(" ");
export {
  prompt,
  tools
};
