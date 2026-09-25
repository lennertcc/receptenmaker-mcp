import { parse, type HTMLElement } from "node-html-parser";

/** Raised when a page does not have the shape this parser expects. */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

const RECIPE_OPTION_PREFIX = "rm_recipe_options[";

/** textarea content is recipe prose, so keep it as raw text instead of markup. */
function document(html: string): HTMLElement {
  return parse(html, {
    blockTextElements: { script: false, style: false, pre: false, textarea: true },
  });
}

function hasAttr(el: HTMLElement, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(el.attributes, name);
}

/** Text belonging directly to an element, ignoring any nested markup. */
function ownText(el: HTMLElement): string {
  return el.childNodes
    .filter((n) => n.nodeType === 3)
    .map((n) => n.text)
    .join("")
    .trim();
}

function optionKey(name: string): string | null {
  if (!name.startsWith(RECIPE_OPTION_PREFIX)) return null;
  const inner = name.slice(RECIPE_OPTION_PREFIX.length);
  return inner.endsWith("]") ? inner.slice(0, -1) : null;
}

export interface RecipeListItem {
  id: string;
  name: string;
  imageUrl: string | null;
  category: string;
  cookTime: string;
  tags: string;
  source: string;
  shared: boolean;
  sharedLabel: string;
  createdAt: string;
}

export interface RecipeListPage {
  total: number;
  items: RecipeListItem[];
}

const NOT_SHARED = "niet gedeeld";

export async function parseRecipeList(html: string): Promise<RecipeListPage> {
  const doc = document(html);
  const table = doc.querySelector("table.wp-list-table");
  if (!table) {
    throw new ParseError(
      "recipe list table not found (table.wp-list-table); the upstream page layout may have changed",
    );
  }

  const items: RecipeListItem[] = [];
  for (const row of table.querySelectorAll("tr")) {
    const checkbox = row.querySelector('input[name="item[]"]');
    const editLink = row.querySelector('a[href*="recipeId="]');
    const id =
      checkbox?.getAttribute("value") ??
      editLink?.getAttribute("href")?.match(/recipeId=(\d+)/)?.[1];
    if (!id) continue;

    const column = (name: string) => row.querySelector(`td.column-${name}`)?.text.trim() ?? "";
    const primary = row.querySelector("th.column-primary") ?? row.querySelector("th");
    const sharedLabel = column("openbaar");

    items.push({
      id,
      name: primary ? ownText(primary) : "",
      imageUrl: row.querySelector("td.column-image img")?.getAttribute("src") ?? null,
      category: column("soortGerecht"),
      cookTime: column("bereiding"),
      tags: column("tags"),
      source: column("bron"),
      shared: sharedLabel !== "" && sharedLabel !== NOT_SHARED,
      sharedLabel,
      createdAt: column("aanmaakdatum"),
    });
  }

  const countText = doc.querySelector("span.displaying-num")?.text ?? "";
  const counted = countText.replace(/\./g, "").match(/(\d+)/);
  return { total: counted ? Number(counted[1]) : items.length, items };
}

export interface RawRecipeForm {
  fields: Record<string, string>;
  categories: string[];
  availableCategories: string[];
  cookbookIds: string[];
  availableCookbookIds: string[];
  nonce: string | null;
  /** In the order the site lists them, which puts the header photo first. */
  photos: RawPhoto[];
}

export interface RawPhoto {
  storageId: string;
  url: string;
}

/**
 * Reads the recipe edit form.
 *
 * The fields are located by name across the whole document rather than within
 * `form#recipe-options-form`: the upstream markup makes HTML parsers unwrap that form
 * element, while its inputs survive. Only this form uses the `rm_recipe_options` prefix,
 * so there is nothing else to confuse them with.
 */
export async function parseRecipeForm(html: string): Promise<RawRecipeForm> {
  const doc = document(html);
  const form = doc;
  if (!doc.querySelector('input[name="rm_recipe_options[receptNaam]"]')) {
    throw new ParseError(
      "recipe form fields not found (rm_recipe_options[receptNaam]); the recipe may not exist or the upstream page layout may have changed",
    );
  }

  const fields: Record<string, string> = {};
  const categories: string[] = [];
  const availableCategories: string[] = [];
  const cookbookIds: string[] = [];
  const availableCookbookIds: string[] = [];

  for (const input of form.querySelectorAll("input")) {
    const name = input.getAttribute("name");
    if (!name) continue;
    const value = input.getAttribute("value") ?? "";

    if (name === "rm_recipe_options[soortGerecht][]") {
      availableCategories.push(value);
      if (hasAttr(input, "checked")) categories.push(value);
      continue;
    }
    if (name === "rm_recipe_options[cookbook][]") {
      availableCookbookIds.push(value);
      if (hasAttr(input, "checked")) cookbookIds.push(value);
      continue;
    }

    const key = optionKey(name);
    if (key) fields[key] = value;
  }

  for (const area of form.querySelectorAll("textarea")) {
    const key = optionKey(area.getAttribute("name") ?? "");
    if (key) fields[key] = area.text;
  }

  for (const select of form.querySelectorAll("select")) {
    const key = optionKey(select.getAttribute("name") ?? "");
    if (!key) continue;
    const chosen = select
      .querySelectorAll("option")
      .find((option) => hasAttr(option, "selected"));
    if (chosen) fields[key] = chosen.getAttribute("value") ?? chosen.text.trim();
  }

  return {
    fields,
    categories,
    availableCategories,
    cookbookIds,
    availableCookbookIds,
    nonce: form.querySelector('input[name="plugin_settings_nonce"]')?.getAttribute("value") ?? null,
    photos: form.querySelectorAll("img.recipeImage").flatMap((img) => {
      const url = img.getAttribute("src");
      const storageId =
        img.getAttribute("data-storage-id") ?? url?.match(/\/images\/([a-z0-9]+)\//)?.[1];
      return url && storageId ? [{ storageId, url }] : [];
    }),
  };
}

/** Tags the account has defined, offered by the form's tag picker. */
export async function parseTagLibrary(html: string): Promise<string[]> {
  const tags = document(html)
    .querySelectorAll("a.addTag")
    .map((a) => a.text.trim())
    .filter(Boolean);
  return [...new Set(tags)];
}

export interface Cookbook {
  id: string;
  name: string;
  imageUrl: string | null;
}

export async function parseCookbooks(html: string): Promise<Cookbook[]> {
  const doc = document(html);
  const grid = doc.querySelector("div.cookbooks-grid");
  if (!grid && !doc.querySelector("div.wrap")) {
    throw new ParseError(
      "cookbook page not recognised (div.cookbooks-grid); the upstream page layout may have changed",
    );
  }

  const books: Cookbook[] = [];
  for (const item of doc.querySelectorAll("a.cookbooks-item")) {
    const id = item.getAttribute("href")?.match(/cookbook_id=(\d+)/)?.[1];
    if (!id) continue;
    books.push({
      id,
      name: item.querySelector("h3")?.text.trim() ?? "",
      imageUrl: item.querySelector("img")?.getAttribute("src") ?? null,
    });
  }
  return books;
}

/** The message WordPress shows for a rejected login, or null when there is none. */
export async function parseLoginError(html: string): Promise<string | null> {
  const error = document(html).querySelector("#login_error");
  const message = error?.text.trim();
  return message ? message : null;
}
