import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AuthError,
  RecipeNotFoundError,
  ReceptenmakerClient,
  UpstreamError,
  type ListParams,
} from "./rm/client";
import { ParseError, type RecipeListItem } from "./rm/parse";
import { CATEGORIES } from "./rm/fields";
import type { ReceptenmakerAppClient } from "./rm/app-client";

const SITE = "https://www.receptenmaker.com";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

const fail = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/** Turns the client's error types into messages a model can act on. */
async function guarded(run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await run());
  } catch (error) {
    if (error instanceof AuthError) {
      return fail(
        `Could not sign in to Receptenmaker: ${error.message}. Re-authorize this connection to store fresh credentials.`,
      );
    }
    if (error instanceof RecipeNotFoundError) return fail(error.message);
    if (error instanceof UpstreamError) return fail(error.message);
    if (error instanceof ParseError) {
      return fail(
        `Receptenmaker's page could not be read: ${error.message}. This usually means the site changed and this server needs updating.`,
      );
    }
    return fail(
      `Unexpected failure: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const categoryEnum = z.enum(CATEGORIES as unknown as [string, ...string[]]);

const toNumber = (value: string): number | null => {
  const parsed = Number(value.replace(",", "."));
  return value.trim() !== "" && Number.isFinite(parsed) ? parsed : null;
};

function listItem(item: RecipeListItem) {
  return {
    id: item.id,
    name: item.name,
    categories: item.category ? item.category.split(",").map((c) => c.trim()) : [],
    cook_time_minutes: toNumber(item.cookTime),
    tags: item.tags ? item.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
    source: item.source,
    shared: item.shared,
    created_at: item.createdAt,
    image_url: item.imageUrl,
  };
}

const nutritionSchema = z
  .object({
    energy: z.number().nullable(),
    protein: z.number().nullable(),
    carbohydrate: z.number().nullable(),
    sugars: z.number().nullable(),
    fat: z.number().nullable(),
    saturated_fat: z.number().nullable(),
    sodium: z.number().nullable(),
    salt: z.number().nullable(),
    dietary_fiber: z.number().nullable(),
  })
  .partial();

/** Writable recipe fields. Leaving one out keeps its value; null clears it. */
const recipeFields = {
  ingredients: z
    .string()
    .nullable()
    .optional()
    .describe("One ingredient per line. Lines starting with -- act as headings."),
  instructions: z.string().nullable().optional().describe("Preparation steps, one per line."),
  notes: z.string().nullable().optional(),
  source: z.string().nullable().optional().describe("Where the recipe came from, e.g. a site name or book."),
  source_url: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  servings: z.number().nullable().optional(),
  pieces: z.number().nullable().optional().describe("Yield counted in pieces instead of servings."),
  prep_time: z.number().nullable().optional().describe("Preparation time in minutes."),
  cook_time: z.number().nullable().optional().describe("Cooking time in minutes."),
  oven_time: z.number().nullable().optional().describe("Oven time in minutes."),
  oven_temp: z.number().nullable().optional().describe("Oven temperature in °C."),
  categories: z.array(categoryEnum).optional(),
  cookbook_ids: z
    .array(z.string())
    .optional()
    .describe("Ids from list_cookbooks. Replaces the recipe's current cookbooks."),
  nutrition: nutritionSchema.optional().describe("Per-serving nutrition values."),
};

function withUrls<T extends { id: string }>(recipe: T) {
  return {
    ...recipe,
    edit_url: `${SITE}/wp-admin/admin.php?page=rm_recipe&action=editRecipe&recipeId=${recipe.id}`,
    cooking_view_url: `${SITE}/kookstand/?recipe=${recipe.id}`,
  };
}

/**
 * The two clients a tool can reach. Most work goes through the website; cookbook
 * management exists only in the mobile app's API.
 */
export interface Clients {
  web: () => ReceptenmakerClient;
  app: () => ReceptenmakerAppClient;
}

export function registerTools(server: McpServer, clients: Clients): void {
  const getClient = clients.web;
  server.registerTool(
    "search_recipes",
    {
      title: "Search recipes",
      description:
        "Search or browse the recipes in this Receptenmaker account. The text query matches recipe names and ingredients. Results are paged 20 at a time. Filtering by category is done by this server after fetching every page, so it is slower than a plain query.",
      inputSchema: {
        query: z.string().optional().describe("Free text matched against names and ingredients."),
        category: categoryEnum.optional(),
        cookbook_id: z.string().optional().describe("Restrict to one cookbook; ids come from list_cookbooks."),
        sort: z.enum(["name", "category", "cook_time", "tags", "source", "created"]).optional(),
        order: z.enum(["asc", "desc"]).optional(),
        page: z.number().int().min(1).optional().describe("1-based page number; ignored when filtering by category."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, category, cookbook_id, sort, order, page }) =>
      guarded(async () => {
        const params: ListParams = { query, cookbookId: cookbook_id, sort, order };
        const rm = getClient();

        if (category) {
          const all = await rm.listAllRecipes(params);
          const matching = all.items.filter((item) =>
            item.category.split(",").some((c) => c.trim() === category),
          );
          return {
            total: matching.length,
            searched: all.items.length,
            filtered_locally: true,
            recipes: matching.map(listItem),
          };
        }

        const result = await rm.listRecipes({ ...params, page });
        return {
          total: result.total,
          page: page ?? 1,
          page_size: 20,
          recipes: result.items.map(listItem),
        };
      }),
  );

  server.registerTool(
    "get_recipe",
    {
      title: "Get a recipe",
      description:
        "Read one recipe in full: ingredients, instructions, notes, times, servings, nutrition, categories and cookbooks.",
      inputSchema: { id: z.string().describe("Recipe id, as returned by search_recipes.") },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => guarded(async () => withUrls(await getClient().getRecipe(id))),
  );

  server.registerTool(
    "list_cookbooks",
    {
      title: "List cookbooks",
      description:
        "The cookbooks in this account, with the ids used by the other cookbook tools.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guarded(() => getClient().listCookbooks()),
  );

  server.registerTool(
    "list_categories",
    {
      title: "List categories",
      description:
        "The fixed set of dish categories Receptenmaker accepts. No other value can be assigned to a recipe.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guarded(async () => ({ categories: CATEGORIES })),
  );

  server.registerTool(
    "list_tags",
    {
      title: "List tags",
      description: "The tags this account has defined, which can be assigned to any recipe.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guarded(async () => ({ tags: await getClient().listTags() })),
  );

  server.registerTool(
    "create_recipe",
    {
      title: "Create a recipe",
      description:
        "Add a new recipe to the account. Only the name is required. To save a recipe that already exists on a website, prefer import_recipe_from_url.",
      inputSchema: { name: z.string().min(1), ...recipeFields },
      annotations: { readOnlyHint: false },
    },
    async (input) => guarded(async () => withUrls(await getClient().createRecipe(input))),
  );

  server.registerTool(
    "update_recipe",
    {
      title: "Update a recipe",
      description:
        "Change an existing recipe. Fields left out keep their current value; pass null to clear one. Note that categories and cookbook_ids replace the current lists rather than adding to them.",
      inputSchema: { id: z.string(), name: z.string().min(1).optional(), ...recipeFields },
      annotations: { readOnlyHint: false },
    },
    async ({ id, ...patch }) =>
      guarded(async () => withUrls(await getClient().updateRecipe(id, patch))),
  );

  server.registerTool(
    "delete_recipe",
    {
      title: "Delete a recipe",
      description:
        "Permanently delete a recipe. Receptenmaker has no trash, so this cannot be undone — confirm with the user before calling it.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ id }) =>
      guarded(async () => {
        await getClient().deleteRecipe(id);
        return { deleted: id };
      }),
  );

  server.registerTool(
    "set_recipe_cookbooks",
    {
      title: "Set a recipe's cookbooks",
      description:
        "Replace the set of cookbooks a recipe belongs to. Pass an empty list to remove it from all of them.",
      inputSchema: { id: z.string(), cookbook_ids: z.array(z.string()) },
      annotations: { readOnlyHint: false },
    },
    async ({ id, cookbook_ids }) =>
      guarded(async () => withUrls(await getClient().setRecipeCookbooks(id, cookbook_ids))),
  );

  server.registerTool(
    "share_recipe",
    {
      title: "Share a recipe",
      description:
        "Change how a recipe is shared: 'public' publishes it to the Receptenmaker community, 'private' shares it by link, and 'none' withdraws sharing.",
      inputSchema: { id: z.string(), mode: z.enum(["private", "public", "none"]) },
      annotations: { readOnlyHint: false },
    },
    async ({ id, mode }) =>
      guarded(async () => withUrls(await getClient().shareRecipe(id, mode))),
  );

  server.registerTool(
    "create_cookbook",
    {
      title: "Create a cookbook",
      description:
        "Create a new, empty cookbook. Add recipes to it afterwards with set_recipe_cookbooks.",
      inputSchema: { name: z.string().min(1).describe("Name shown on the cookbook.") },
      annotations: { readOnlyHint: false },
    },
    async ({ name }) => guarded(() => clients.app().createCookbook(name)),
  );

  server.registerTool(
    "rename_cookbook",
    {
      title: "Rename a cookbook",
      description: "Change a cookbook's name. Ids come from list_cookbooks.",
      inputSchema: { id: z.string(), name: z.string().min(1) },
      annotations: { readOnlyHint: false },
    },
    async ({ id, name }) =>
      guarded(async () => {
        await clients.app().renameCookbook(id, name);
        return { id, name };
      }),
  );

  server.registerTool(
    "delete_cookbook",
    {
      title: "Delete a cookbook",
      description:
        "Permanently delete a cookbook. The recipes in it are not deleted, they simply stop belonging to it. This cannot be undone — confirm with the user before calling it.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ id }) =>
      guarded(async () => {
        await clients.app().deleteCookbook(id);
        return { deleted: id };
      }),
  );

  server.registerTool(
    "import_recipe_from_url",
    {
      title: "Import a recipe from a URL",
      description:
        "Hand a recipe page's URL to Receptenmaker's own importer, which reads the page and saves the recipe with its photo. Some sites opt out of this and will be refused.",
      inputSchema: { url: z.string().url().describe("Full URL of a recipe page.") },
      annotations: { readOnlyHint: false },
    },
    async ({ url }) =>
      guarded(async () => withUrls(await getClient().importRecipeFromUrl(url))),
  );
}
