import { describe, expect, it } from "vitest";
import { ReceptenmakerClient } from "../src/rm/client";

const username = process.env.RM_USER;
const password = process.env.RM_PASS;
const credentialsPresent = Boolean(username && password);

/**
 * Hits the real Receptenmaker site, so it only runs when credentials are supplied:
 *   RM_USER=... RM_PASS=... npm test
 * Reads only. Set RM_LIVE_WRITE=1 to also create and delete a scratch recipe.
 */
describe.skipIf(!credentialsPresent)("live account (reads)", () => {
  const client = () => new ReceptenmakerClient({ username: username!, password: password! });

  it("signs in and lists recipes", async () => {
    const list = await client().listRecipes({});
    expect(list.total).toBeGreaterThan(0);
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items[0].id).toMatch(/^\d+$/);
    expect(list.items[0].name.length).toBeGreaterThan(0);
  }, 60_000);

  it("rejects a wrong password", async () => {
    const wrong = new ReceptenmakerClient({ username: username!, password: "not-the-password" });
    await expect(wrong.listRecipes({})).rejects.toThrow();
  }, 60_000);

  it("reads one recipe in full", async () => {
    const rm = client();
    const list = await rm.listRecipes({});
    const recipe = await rm.getRecipe(list.items[0].id);
    expect(recipe.id).toBe(list.items[0].id);
    expect(recipe.name).toBe(list.items[0].name);
  }, 60_000);

  it("reports a missing recipe rather than inventing one", async () => {
    await expect(client().getRecipe("999999999")).rejects.toThrow(/no recipe with id/);
  }, 60_000);

  it("lists cookbooks", async () => {
    const books = await client().listCookbooks();
    for (const book of books) expect(book.id).toMatch(/^\d+$/);
  }, 60_000);

  it("searches by text", async () => {
    const all = await client().listRecipes({});
    const term = all.items[0].name.split(" ")[0];
    const found = await client().listRecipes({ query: term });
    expect(found.total).toBeGreaterThan(0);
  }, 60_000);
});

describe.skipIf(!credentialsPresent || process.env.RM_LIVE_WRITE !== "1")(
  "live account (writes)",
  () => {
    const client = () => new ReceptenmakerClient({ username: username!, password: password! });
    const marker = `ZZ VITEST PROBE ${Date.now()}`;

    it("creates, updates and deletes a scratch recipe", async () => {
      const rm = client();

      const created = await rm.createRecipe({
        name: marker,
        ingredients: "1 probe",
        instructions: "Discard.",
        cook_time: 5,
        categories: ["Soep"],
      });
      expect(created.name).toBe(marker);
      expect(created.cook_time).toBe(5);
      expect(created.categories).toEqual(["Soep"]);

      try {
        const updated = await rm.updateRecipe(created.id, { notes: "probe note" });
        expect(updated.notes).toBe("probe note");
        // A partial update must not clear the fields it did not mention.
        expect(updated.name).toBe(marker);
        expect(updated.cook_time).toBe(5);
        expect(updated.categories).toEqual(["Soep"]);
      } finally {
        await rm.deleteRecipe(created.id);
      }

      await expect(rm.getRecipe(created.id)).rejects.toThrow(/no recipe with id/);
    }, 180_000);
  },
);
