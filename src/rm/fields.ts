import type { RawRecipeForm } from "./parse";

/** The categories the upstream form offers; it accepts no others. */
export const CATEGORIES = [
  "Algemeen",
  "Amuse",
  "Bijgerecht",
  "Brunch",
  "Hoofdgerecht",
  "Lunch",
  "Nagerecht",
  "Ontbijt",
  "Ovenschotel",
  "Patisserie",
  "Salade",
  "Saus & Dressings",
  "Snacks & Drinks",
  "Soep",
  "Tussengerecht",
  "Vegetarisch",
  "Voorgerecht",
] as const;

export type Category = (typeof CATEGORIES)[number];

const TEXT_FIELDS = {
  name: "receptNaam",
  ingredients: "ingredienten",
  instructions: "bWijze",
  notes: "opmerkingen",
  source: "bron",
  source_url: "bronURL",
} as const;

const NUMBER_FIELDS = {
  servings: "aantalPersonen",
  pieces: "aantalStuks",
  prep_time: "vbTijd",
  cook_time: "bTijd",
  oven_time: "ovenTijd",
  oven_temp: "ovenTemperatuur",
} as const;

const NUTRITION_FIELDS = {
  energy: "energy",
  protein: "protein",
  carbohydrate: "carbohydrate",
  sugars: "sugars",
  fat: "fat",
  saturated_fat: "saturatedFat",
  sodium: "natrium",
  salt: "salt",
  dietary_fiber: "dietaryFiber",
} as const;

export type Nutrition = { -readonly [K in keyof typeof NUTRITION_FIELDS]: number | null };

export interface Recipe {
  id: string;
  name: string;
  ingredients: string;
  instructions: string;
  notes: string;
  source: string;
  source_url: string;
  tags: string[];
  servings: number | null;
  pieces: number | null;
  prep_time: number | null;
  cook_time: number | null;
  oven_time: number | null;
  oven_temp: number | null;
  nutrition: Nutrition;
  categories: string[];
  cookbook_ids: string[];
  image_url: string | null;
}

/** A partial recipe: an absent key is left alone, an explicit null clears the field. */
export interface RecipeInput {
  id?: string;
  name?: string;
  ingredients?: string | null;
  instructions?: string | null;
  notes?: string | null;
  source?: string | null;
  source_url?: string | null;
  tags?: string[] | null;
  servings?: number | null;
  pieces?: number | null;
  prep_time?: number | null;
  cook_time?: number | null;
  oven_time?: number | null;
  oven_temp?: number | null;
  nutrition?: Partial<Nutrition>;
  categories?: string[];
  cookbook_ids?: string[];
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

export function recipeFromForm(form: RawRecipeForm): Recipe {
  const f = form.fields;
  const nutrition = {} as Nutrition;
  for (const [key, upstream] of Object.entries(NUTRITION_FIELDS)) {
    nutrition[key as keyof Nutrition] = toNumber(f[upstream]);
  }

  return {
    id: f.id ?? "",
    name: (f.receptNaam ?? "").trim(),
    ingredients: f.ingredienten ?? "",
    instructions: f.bWijze ?? "",
    notes: f.opmerkingen ?? "",
    source: f.bron ?? "",
    source_url: f.bronURL ?? "",
    tags: (f.tags ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    servings: toNumber(f.aantalPersonen),
    pieces: toNumber(f.aantalStuks),
    prep_time: toNumber(f.vbTijd),
    cook_time: toNumber(f.bTijd),
    oven_time: toNumber(f.ovenTijd),
    oven_temp: toNumber(f.ovenTemperatuur),
    nutrition,
    categories: form.categories,
    cookbook_ids: form.cookbookIds,
    image_url: form.imageUrls[0] ?? null,
  };
}

const option = (key: string) => `rm_recipe_options[${key}]`;

export function formFromRecipe(input: RecipeInput): Record<string, string | string[]> {
  const body: Record<string, string | string[]> = {};

  if (input.id !== undefined) body[option("id")] = input.id;

  for (const [key, upstream] of Object.entries(TEXT_FIELDS)) {
    const value = input[key as keyof typeof TEXT_FIELDS];
    if (value !== undefined) body[option(upstream)] = value ?? "";
  }

  for (const [key, upstream] of Object.entries(NUMBER_FIELDS)) {
    const value = input[key as keyof typeof NUMBER_FIELDS];
    if (value !== undefined) body[option(upstream)] = value === null ? "" : String(value);
  }

  if (input.nutrition) {
    for (const [key, upstream] of Object.entries(NUTRITION_FIELDS)) {
      const value = input.nutrition[key as keyof Nutrition];
      if (value !== undefined) body[option(upstream)] = value === null ? "" : String(value);
    }
  }

  if (input.tags !== undefined) {
    body[option("tags")] = (input.tags ?? []).map((tag) => tag.trim()).join(",");
  }

  if (input.categories !== undefined) {
    const unknown = input.categories.filter(
      (c) => !(CATEGORIES as readonly string[]).includes(c),
    );
    if (unknown.length > 0) {
      throw new Error(
        `unknown categor${unknown.length > 1 ? "ies" : "y"} ${unknown.join(", ")}; allowed values are ${CATEGORIES.join(", ")}`,
      );
    }
    body["rm_recipe_options[soortGerecht][]"] = input.categories;
  }

  if (input.cookbook_ids !== undefined) {
    body["rm_recipe_options[cookbook][]"] = input.cookbook_ids;
  }

  return body;
}
