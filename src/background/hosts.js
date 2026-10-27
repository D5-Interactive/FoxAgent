export function hostMatches(host, patterns) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  const list = Array.isArray(patterns) ? patterns : [];
  if (!list.length) return true;
  if (!h) return false;
  return list.some((raw) => {
    const p = String(raw || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    if (!p) return false;
    const regex = new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return regex.test(h);
  });
}
