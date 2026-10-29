import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

globalThis.browser = {
  runtime: { getURL: (path) => `moz-extension://test/${path}` },
};
globalThis.fetch = async (url) => {
  const path = String(url).replace("moz-extension://test/", "");
  const body = await fs.readFile(new URL(`../${path}`, import.meta.url), "utf8");
  return { ok: true, status: 200, json: async () => JSON.parse(body) };
};

const { packTools, packRecipes, packList, packPrompts } = await import("../src/background/packs.js");
const { RECIPES } = await import("../src/background/recipes.js");

test("canvas tools do not appear on a slides tab", async () => {
  assert.deepEqual(await packTools(["canvas"], ["docs.google.com"]), []);
  assert.deepEqual(await packPrompts(["canvas"], "docs.google.com"), []);
  assert.deepEqual(await packRecipes(["canvas"], "docs.google.com"), []);
});

test("canvas tools appear on a canvas tab", async () => {
  const tools = await packTools(["canvas"], ["canvas.instructure.com"]);
  assert.ok(tools.some((tool) => tool.name === "canvas.digest"));
  const recipes = await packRecipes(["canvas"], "canvas.instructure.com");
  assert.deepEqual(recipes.map((recipe) => recipe.id).sort(), [
    "canvas.course",
    "canvas.grades",
    "canvas.materials",
    "canvas.weekly",
  ]);
});

test("the core task list has no canvas recipes", () => {
  assert.ok(RECIPES.every((recipe) => !recipe.id.startsWith("canvas.")));
});

test("installed packs report whether they match the tab", async () => {
  const here = await packList(["canvas"], "canvas.instructure.com");
  const elsewhere = await packList(["canvas"], "docs.google.com");
  assert.equal(here.find((pack) => pack.id === "canvas").active, true);
  assert.equal(elsewhere.find((pack) => pack.id === "canvas").active, false);
});

test("a disabled pack contributes nothing", async () => {
  assert.deepEqual(await packTools([], ["canvas.instructure.com"]), []);
  assert.deepEqual(await packRecipes([], "canvas.instructure.com"), []);
});
