import { describe, it, expect } from "vitest";
import editHtml from "./fixtures/recipe-edit.html?raw";
import editNoCatHtml from "./fixtures/recipe-edit-nocat.html?raw";
import { parseRecipeForm } from "../src/rm/parse";
import { CATEGORIES, formFromRecipe, recipeFromForm } from "../src/rm/fields";

describe("recipeFromForm", () => {
  it("maps Dutch form keys onto the English recipe shape", async () => {
    const recipe = recipeFromForm(await parseRecipeForm(editHtml));
    expect(recipe.id).toBe("4166830");
    expect(recipe.name).toBe("Groentesoep met linzen");
    expect(recipe.categories).toEqual(["Hoofdgerecht"]);
    expect(recipe.ingredients).toContain("400 g linzen");
    expect(recipe.image_url).toContain("f33bef4a0a0194");
  });

  it("turns blank numeric fields into null rather than 0", async () => {
    const recipe = recipeFromForm(await parseRecipeForm(editHtml));
    expect(recipe.servings).toBeNull();
    expect(recipe.cook_time).toBeNull();
    expect(recipe.nutrition.energy).toBeNull();
  });

  it("parses numbers that are present", async () => {
    const recipe = recipeFromForm(await parseRecipeForm(editNoCatHtml));
    expect(recipe.cook_time).toBe(20);
    expect(recipe.source_url).toBe(
      "https://www.example.com/recept/voorbeeld/",
    );
  });

  it("splits an empty tag string into no tags", async () => {
    const recipe = recipeFromForm(await parseRecipeForm(editHtml));
    expect(recipe.tags).toEqual([]);
  });
});

describe("formFromRecipe", () => {
  it("emits namespaced form keys", () => {
    const body = formFromRecipe({ name: "Soep", ingredients: "water", cook_time: 15 });
    expect(body["rm_recipe_options[receptNaam]"]).toBe("Soep");
    expect(body["rm_recipe_options[ingredienten]"]).toBe("water");
    expect(body["rm_recipe_options[bTijd]"]).toBe("15");
  });

  it("joins tags with commas, the format the upstream widget writes", () => {
    const body = formFromRecipe({ name: "x", tags: ["bonen", "comfort"] });
    expect(body["rm_recipe_options[tags]"]).toBe("bonen,comfort");
  });

  it("emits categories and cookbooks as repeated array fields", () => {
    const body = formFromRecipe({
      name: "x",
      categories: ["Soep", "Lunch"],
      cookbook_ids: ["69061"],
    });
    expect(body["rm_recipe_options[soortGerecht][]"]).toEqual(["Soep", "Lunch"]);
    expect(body["rm_recipe_options[cookbook][]"]).toEqual(["69061"]);
  });

  it("omits fields the caller did not set", () => {
    const body = formFromRecipe({ name: "x" });
    expect(body).not.toHaveProperty("rm_recipe_options[opmerkingen]");
    expect(body).not.toHaveProperty("rm_recipe_options[bTijd]");
  });

  it("writes an empty string for a field explicitly cleared to null", () => {
    const body = formFromRecipe({ name: "x", notes: null });
    expect(body["rm_recipe_options[opmerkingen]"]).toBe("");
  });

  it("rejects a category outside the fixed upstream list", () => {
    expect(() => formFromRecipe({ name: "x", categories: ["Tapas"] })).toThrow(/Tapas/);
  });

  it("round-trips a parsed recipe without losing fields", async () => {
    const recipe = recipeFromForm(await parseRecipeForm(editNoCatHtml));
    const body = formFromRecipe(recipe);
    expect(body["rm_recipe_options[receptNaam]"]).toBe(recipe.name);
    expect(body["rm_recipe_options[bTijd]"]).toBe("20");
    expect(body["rm_recipe_options[bronURL]"]).toBe(recipe.source_url);
  });
});

describe("CATEGORIES", () => {
  it("holds the 17 values the upstream form offers", () => {
    expect(CATEGORIES).toHaveLength(17);
    expect(CATEGORIES).toContain("Hoofdgerecht");
    expect(CATEGORIES).toContain("Saus & Dressings");
  });
});
