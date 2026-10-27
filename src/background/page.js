/*
 * Tab injection + page messaging.
 */

const injected = new Set();

const RESTRICTED = /^(about|chrome|moz-extension|resource|view-source|jar|addons):/i;

export function isRestricted(url) {
  return !url || RESTRICTED.test(url) || url.startsWith("https://addons.mozilla.org");
}

export async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab in this window.");
  return tab;
}

export async function resolveTab(tabId) {
  if (tabId != null) {
    try {
      return await browser.tabs.get(Number(tabId));
    } catch {
      throw new Error(`No tab with id ${tabId}.`);
    }
  }
  return activeTab();
}

async function ping(tabId) {
  try {
    const res = await browser.tabs.sendMessage(tabId, { __foxagent: true, op: "ping" });
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

export async function ensureInjected(tab) {
  if (!tab?.id) throw new Error("This tab cannot be controlled.");
  if (isRestricted(tab.url)) {
    throw new Error(`Firefox doesn't let extensions run on ${tab.url || "this page"}. Open a normal http(s) page.`);
  }
  if (await ping(tab.id)) {
    injected.add(tab.id);
    return;
  }
  try {
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/content/agent.js"],
    });
  } catch (err) {
    throw new Error(`Could not attach to the page: ${err.message}`);
  }
  for (let i = 0; i < 6; i++) {
    if (await ping(tab.id)) {
      injected.add(tab.id);
      return;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error("The page loaded FoxAgent's bridge but did not respond. Reload the tab and try again.");
}

export async function callPage(tab, op, args = {}) {
  await ensureInjected(tab);
  let res;
  try {
    res = await browser.tabs.sendMessage(tab.id, { __foxagent: true, op, args });
  } catch (err) {
    injected.delete(tab.id);
    throw new Error(`The page changed or navigated while working (${err.message}). Take a new snapshot and retry.`);
  }
  if (!res) throw new Error("The page did not respond. Reload the tab and try again.");
  if (!res.ok) throw new Error(res.error || "Page operation failed.");
  return res.result;
}

export async function tabInfo(tab) {
  if (!tab) return null;
  return { id: tab.id, url: tab.url, title: tab.title, active: tab.active };
}

export async function waitForLoad(tabId, timeoutMs = 15000) {
  const tab = await browser.tabs.get(tabId);
  if (tab.status === "complete") return tab;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      browser.tabs.onUpdated.removeListener(listener);
      browser.tabs.get(tabId).then(resolve, () => resolve(tab));
    }, timeoutMs);
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "complete") {
        clearTimeout(timer);
        browser.tabs.onUpdated.removeListener(listener);
        browser.tabs.get(tabId).then(resolve, () => resolve(tab));
      }
    };
    browser.tabs.onUpdated.addListener(listener);
  });
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
