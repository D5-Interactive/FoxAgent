const REPO = "D5-Interactive/FoxAgent";
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const INTERVAL = 6 * 60 * 60 * 1e3;
const CACHE_KEY = "updateCache";
let inFlight = null;
function parts(version) {
  return String(version || "").replace(/^v/i, "").split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
}
function isNewer(latest, current) {
  const a = parts(latest);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}
async function cachedUpdate() {
  const stored = await browser.storage.local.get(CACHE_KEY);
  return stored?.[CACHE_KEY] || null;
}
async function checkUpdate({ force = false } = {}) {
  const cache = await cachedUpdate();
  if (!force && cache && Date.now() - cache.checkedAt < INTERVAL) return cache;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const res = await fetch(API, {
      headers: { Accept: "application/vnd.github+json" },
      credentials: "omit",
      cache: "no-store"
    });
    if (!res.ok) {
      const detail = res.status === 403 ? "GitHub rate limit reached; try again later." : `${res.status} ${res.statusText}`;
      throw new Error(`Could not check GitHub releases: ${detail}`);
    }
    const release = await res.json();
    const latest = String(release.tag_name || "").replace(/^v/i, "");
    const current = browser.runtime.getManifest().version;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = assets.find((a) => /\.(zip|xpi)$/i.test(a.name || "")) || null;
    const data = {
      checkedAt: Date.now(),
      current,
      latest: latest || current,
      available: Boolean(latest) && isNewer(latest, current),
      name: String(release.name || `FoxAgent ${latest}`).slice(0, 200),
      url: String(release.html_url || `https://github.com/${REPO}/releases/latest`),
      notes: String(release.body || "").slice(0, 4e3),
      asset: asset ? { name: String(asset.name), url: String(asset.browser_download_url), size: Number(asset.size) || 0 } : null
    };
    await browser.storage.local.set({ [CACHE_KEY]: data });
    return data;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
async function downloadUpdate() {
  const data = await checkUpdate({ force: true });
  if (!data.available) throw new Error("FoxAgent is already on the latest release.");
  if (!data.asset?.url) throw new Error("This release has no package to download. Open the release page instead.");
  const filename = `FoxAgent/updates/${data.asset.name}`;
  const downloadId = await browser.downloads.download({
    url: data.asset.url,
    filename,
    saveAs: false,
    conflictAction: "uniquify"
  });
  return { ...data, downloadId, filename };
}
export {
  cachedUpdate,
  checkUpdate,
  downloadUpdate,
  isNewer
};
