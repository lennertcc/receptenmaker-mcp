import { describe, it, expect } from "vitest";
import listHtml from "./fixtures/recipes-list.html?raw";
import searchHtml from "./fixtures/recipes-search.html?raw";
import editHtml from "./fixtures/recipe-edit.html?raw";
import editNoCatHtml from "./fixtures/recipe-edit-nocat.html?raw";
import cookbooksHtml from "./fixtures/cookbooks.html?raw";
import {
  ParseError,
  parseCookbooks,
  parseLoginError,
  parseRecipeForm,
  parseRecipeList,
  parseTagLibrary,
} from "../src/rm/parse";

describe("parseRecipeList", () => {
  it("reads the total and every row of a full page", async () => {
    const list = await parseRecipeList(listHtml);
    expect(list.total).toBe(69);
    expect(list.items).toHaveLength(20);
  });

  it("extracts each column of a row", async () => {
    const { items } = await parseRecipeList(listHtml);
    expect(items[0]).toMatchObject({
      id: "4444003",
      name: "Groentesoep met linzen",
      cookTime: "20",
      source: "www.example.com",
      shared: false,
      createdAt: "06-09-2026 15:29",
      imageUrl: null,
    });
  });

  it("does not leak row-action link text into the recipe name", async () => {
    const { items } = await parseRecipeList(listHtml);
    for (const item of items) {
      expect(item.name).not.toMatch(/recept wijzigen|Kookstand|details/i);
      expect(item.name).toBe(item.name.trim());
      expect(item.name.length).toBeGreaterThan(0);
    }
  });

  it("picks up the thumbnail when a recipe has one", async () => {
    const { items } = await parseRecipeList(listHtml);
    const withImage = items.find((i) => i.id === "4340898");
    expect(withImage?.imageUrl).toContain("12337ba3907714");
  });

  it("reads a narrowed search result", async () => {
    const list = await parseRecipeList(searchHtml);
    expect(list.total).toBe(9);
    expect(list.items).toHaveLength(9);
  });

  it("distinguishes a shared recipe from an unshared one", async () => {
    const { items } = await parseRecipeList(searchHtml);
    const shared = items.filter((i) => i.shared);
    expect(shared).toHaveLength(1);
    expect(shared[0].sharedLabel).toContain("gedeeld");
    expect(items.filter((i) => !i.shared).length).toBeGreaterThan(0);
  });

  it("throws rather than reporting an empty library when the table is missing", async () => {
    await expect(parseRecipeList("<div class='wrap'><p>nothing</p></div>")).rejects.toThrow(
      ParseError,
    );
  });
});

describe("parseRecipeForm", () => {
  it("reads scalar fields and long text areas", async () => {
    const form = await parseRecipeForm(editHtml);
    expect(form.fields.id).toBe("4166830");
    expect(form.fields.receptNaam).toBe("Groentesoep met linzen");
    expect(form.fields.ingredienten).toContain("400 g linzen");
    expect(form.fields.bWijze).toContain("Snipper de ui");
    expect(form.nonce).toBe("testnonce123");
  });

  it("reads checked categories and leaves unchecked ones out", async () => {
    const form = await parseRecipeForm(editHtml);
    expect(form.categories).toEqual(["Hoofdgerecht"]);
  });

  it("reports every selectable cookbook and which are checked", async () => {
    const form = await parseRecipeForm(editHtml);
    expect(form.availableCookbookIds).toEqual(["69061", "72180", "72181", "71281"]);
    expect(form.cookbookIds).toEqual([]);
  });

  it("returns each photo with its storage id", async () => {
    const form = await parseRecipeForm(editHtml);
    expect(form.photos).toHaveLength(1);
    expect(form.photos[0].storageId).toBe("f33bef4a0a0194");
    expect(form.photos[0].url).toContain("/f33bef4a0a0194/");
  });

  it("keeps photo order, which puts the header photo first", async () => {
    const second =
      '<img data-storage-id="aaaabbbbcccc11" class="recipeImage" src="https://s3.example/recepten/images/aaaabbbbcccc11/400x300/image.jpg"/>';
    const html = editHtml.replace(/(<img[^>]*class="recipeImage"[^>]*>)/, `$1${second}`);
    const form = await parseRecipeForm(html);
    expect(form.photos.map((p) => p.storageId)).toEqual(["f33bef4a0a0194", "aaaabbbbcccc11"]);
  });

  it("falls back to the storage id in the url when the attribute is missing", async () => {
    const html = editHtml.replace(/data-storage-id="[^"]*"\s*/, "");
    const form = await parseRecipeForm(html);
    expect(form.photos[0].storageId).toBe("f33bef4a0a0194");
  });

  it("reports no photos for a recipe without any", async () => {
    const html = editHtml.replace(/<img[^>]*class="recipeImage"[^>]*>/g, "");
    expect((await parseRecipeForm(html)).photos).toEqual([]);
  });

  it("handles a recipe with no categories and a source url", async () => {
    const form = await parseRecipeForm(editNoCatHtml);
    expect(form.fields.id).toBe("4444003");
    expect(form.fields.receptNaam).toBe("Ovenschotel met aubergine");
    expect(form.fields.bronURL).toBe(
      "https://www.example.com/recept/voorbeeld/",
    );
    expect(form.fields.bTijd).toBe("20");
    expect(form.categories).toEqual([]);
  });

  it("throws when the form is absent", async () => {
    await expect(parseRecipeForm("<div class='wrap'></div>")).rejects.toThrow(ParseError);
  });
});

describe("parseTagLibrary", () => {
  it("lists the tags the account has defined", async () => {
    expect(await parseTagLibrary(editHtml)).toEqual([
      "snel",
      "feest",
      "vegetarisch",
      "zomer",
    ]);
  });
});

describe("parseCookbooks", () => {
  it("reads id, name and cover for each cookbook", async () => {
    const books = await parseCookbooks(cookbooksHtml);
    expect(books.map((b) => b.id)).toEqual(["69061", "72180", "72181", "71281"]);
    expect(books.map((b) => b.name)).toEqual([
      "weekmenu",
      "bakken",
      "basis",
      "groenten",
    ]);
    expect(books[0].imageUrl).toContain("602987692ba0d6");
  });
});

describe("parseLoginError", () => {
  it("detects the WordPress login error block", async () => {
    const html = `<div id="login"><div id="login_error">Onbekende gebruikersnaam.</div></div>`;
    expect(await parseLoginError(html)).toContain("Onbekende gebruikersnaam");
  });

  it("returns null when there is no error", async () => {
    expect(await parseLoginError("<div id='login'><form></form></div>")).toBeNull();
  });
});
