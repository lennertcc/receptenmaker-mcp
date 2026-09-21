import {
  ParseError,
  parseCookbooks,
  parseLoginError,
  parseRecipeForm,
  parseRecipeList,
  parseTagLibrary,
  type Cookbook,
  type RawRecipeForm,
  type RecipeListPage,
} from "./parse";
import { formFromRecipe, recipeFromForm, type Recipe, type RecipeInput } from "./fields";

/** The stored credentials were rejected, or the session could not be renewed. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class RecipeNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeNotFoundError";
  }
}

/** Receptenmaker answered, but refused or failed the operation. */
export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

const DEFAULT_BASE = "https://www.receptenmaker.com";
const ADMIN = "/wp-admin/admin.php";
const PAGE_SIZE = 20;

/** Sort keys the recipe list accepts, mapped from the tool-facing names. */
export const SORT_KEYS = {
  name: "receptNaam",
  category: "soortGerecht",
  cook_time: "bTijd",
  tags: "tags",
  source: "bron",
  created: "aanmaakdatum",
} as const;

export type SortKey = keyof typeof SORT_KEYS;
export type ShareMode = "private" | "public" | "none";

/** The submit button each sharing action is driven by, with the label the form sends. */
const SHARE_BUTTONS: Record<ShareMode, [string, string]> = {
  private: ["sharePrivate", "delen"],
  public: ["sharePublic", "Delen"],
  none: ["removeShare", "niet meer delen"],
};

export interface Credentials {
  username: string;
  password: string;
}

export interface ClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface ListParams {
  query?: string;
  cookbookId?: string;
  sort?: SortKey;
  order?: "asc" | "desc";
  page?: number;
}

const USER_AGENT = "receptenmaker-mcp/1.0 (+https://github.com/lennertcc/receptenmaker-mcp)";

/**
 * Talks to the Receptenmaker WordPress front end as a logged-in user.
 *
 * Session cookies live only in this instance; nothing is persisted. When the upstream
 * session lapses the client logs in again once and replays the request.
 */
export class ReceptenmakerClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private cookies = new Map<string, string>();
  private loggedIn = false;

  constructor(
    private readonly credentials: Credentials,
    options: ClientOptions = {},
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    // The global fetch must stay bound to globalThis: calling it as a method of this
    // instance trips the Workers runtime's "Illegal invocation" check.
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  // --- session ---------------------------------------------------------------

  private hasSessionCookie(): boolean {
    for (const name of this.cookies.keys()) {
      if (name.startsWith("wordpress_logged_in")) return true;
    }
    return false;
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  private storeCookies(response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const raw =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : ((headers as unknown as { getAll?: (k: string) => string[] }).getAll?.("set-cookie") ??
          (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")!] : []));

    for (const cookie of raw) {
      const [pair] = cookie.split(";");
      const split = pair.indexOf("=");
      if (split <= 0) continue;
      const name = pair.slice(0, split).trim();
      const value = pair.slice(split + 1).trim();
      if (value === "" || value === "deleted") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async login(): Promise<void> {
    this.cookies.set("wordpress_test_cookie", "WP Cookie check");
    const body = new URLSearchParams({
      log: this.credentials.username,
      pwd: this.credentials.password,
      rememberme: "forever",
      "wp-submit": "Log In",
      redirect_to: `${this.baseUrl}/wp-admin/`,
      testcookie: "1",
    });

    const response = await this.fetchImpl(`${this.baseUrl}/wp-login.php`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: this.cookieHeader(),
        "user-agent": USER_AGENT,
      },
      redirect: "manual",
    });
    this.storeCookies(response);

    if (!this.hasSessionCookie()) {
      const message =
        response.status === 200 ? await parseLoginError(await response.text()) : null;
      throw new AuthError(
        message ??
          "Receptenmaker rejected the sign-in; the stored username or password is no longer valid",
      );
    }
    this.loggedIn = true;
  }

  private static isLoginRedirect(response: Response): boolean {
    if (response.status < 300 || response.status >= 400) return false;
    return (response.headers.get("location") ?? "").includes("wp-login.php");
  }

  private async send(
    url: string,
    init: RequestInit = {},
    allowRelogin = true,
  ): Promise<Response> {
    if (!this.loggedIn) await this.login();

    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        cookie: this.cookieHeader(),
        "user-agent": USER_AGENT,
      },
      redirect: "manual",
    });
    this.storeCookies(response);

    if (ReceptenmakerClient.isLoginRedirect(response)) {
      if (!allowRelogin) {
        throw new AuthError(
          "Receptenmaker session expired and signing in again did not restore it; re-authorize this connection",
        );
      }
      this.cookies.clear();
      this.loggedIn = false;
      await this.login();
      return this.send(url, init, false);
    }
    return response;
  }

  private async getHtml(url: string): Promise<string> {
    const response = await this.send(url);
    if (response.status >= 400) {
      throw new UpstreamError(`Receptenmaker returned HTTP ${response.status} for ${url}`);
    }
    if (response.status >= 300) {
      const location = response.headers.get("location");
      if (location) return this.getHtml(new URL(location, this.baseUrl).toString());
    }
    return response.text();
  }

  private async postForm(
    url: string,
    fields: Record<string, string | string[]>,
  ): Promise<Response> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      if (Array.isArray(value)) for (const item of value) body.append(key, item);
      else body.append(key, value);
    }
    return this.send(url, {
      method: "POST",
      body: body.toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  }

  // --- urls ------------------------------------------------------------------

  private adminUrl(params: Record<string, string>): string {
    const url = new URL(`${this.baseUrl}${ADMIN}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  private editUrl(id: string): string {
    return this.adminUrl({ page: "rm_recipe", action: "editRecipe", recipeId: id });
  }

  private blankFormUrl(): string {
    return this.adminUrl({ page: "rm_recipe" });
  }

  /**
   * Endpoints the forms post to. The markup uses `action="?save-recipe=true"`, which a
   * browser resolves against admin.php without any `page` parameter — confirmed by
   * capturing the real requests, so they are reproduced exactly.
   */
  private actionUrl(action: "save-recipe" | "delete-recipe" | "share-recipe"): string {
    return `${this.baseUrl}${ADMIN}?${action}=true`;
  }

  // --- reads -----------------------------------------------------------------

  async listRecipes(params: ListParams): Promise<RecipeListPage> {
    const query: Record<string, string> = { page: "recipes" };
    if (params.query) query.s = params.query;
    if (params.sort) query.orderby = SORT_KEYS[params.sort];
    if (params.order) query.order = params.order;
    if (params.page && params.page > 1) query.paged = String(params.page);
    else if (params.page) query.paged = String(params.page);
    if (params.cookbookId) query.cookbook_id = params.cookbookId;

    return parseRecipeList(await this.getHtml(this.adminUrl(query)));
  }

  /**
   * Every page of a result set. Receptenmaker offers no category filter, so callers that
   * need one filter these rows themselves; a library is small enough to walk.
   */
  async listAllRecipes(params: ListParams, maxPages = 25): Promise<RecipeListPage> {
    const first = await this.listRecipes({ ...params, page: 1 });
    const pageSize = first.items.length || PAGE_SIZE;
    const pages = Math.min(Math.ceil(first.total / pageSize), maxPages);

    const items = [...first.items];
    for (let page = 2; page <= pages; page += 1) {
      const next = await this.listRecipes({ ...params, page });
      if (next.items.length === 0) break;
      items.push(...next.items);
    }
    return { total: first.total, items };
  }

  private async loadRecipeForm(id: string): Promise<RawRecipeForm> {
    let form: RawRecipeForm;
    try {
      form = await parseRecipeForm(await this.getHtml(this.editUrl(id)));
    } catch (error) {
      if (error instanceof ParseError) {
        throw new RecipeNotFoundError(`no recipe with id ${id} could be opened`);
      }
      throw error;
    }
    if (form.fields.id !== id) {
      throw new RecipeNotFoundError(`no recipe with id ${id} could be opened`);
    }
    return form;
  }

  async getRecipe(id: string): Promise<Recipe> {
    return recipeFromForm(await this.loadRecipeForm(id));
  }

  async listCookbooks(): Promise<Cookbook[]> {
    return parseCookbooks(await this.getHtml(this.adminUrl({ page: "cookbooks" })));
  }

  /**
   * The tag picker on any recipe form lists the account's whole tag library, so this reads
   * the newest recipe rather than opening a blank form (which reserves a recipe id).
   */
  async listTags(): Promise<string[]> {
    const list = await this.listRecipes({ sort: "created", order: "desc" });
    const first = list.items[0];
    const html = await this.getHtml(first ? this.editUrl(first.id) : this.blankFormUrl());
    return parseTagLibrary(html);
  }

  // --- writes ----------------------------------------------------------------

  private static idFromResponse(response: Response): string | null {
    const location = response.headers.get("location") ?? "";
    return location.match(/recipeId=(\d+)/)?.[1] ?? null;
  }

  private async save(
    form: RawRecipeForm,
    input: RecipeInput,
    referer: string,
  ): Promise<Response> {
    if (!form.nonce) {
      throw new UpstreamError(
        "the recipe form did not include a security token; the upstream page layout may have changed",
      );
    }
    const response = await this.postForm(this.actionUrl("save-recipe"), {
      ...formFromRecipe(input),
      plugin_settings_nonce: form.nonce,
      _wp_http_referer: referer,
      headImage: "",
    });
    if (response.status >= 400) {
      throw new UpstreamError(`saving the recipe failed with HTTP ${response.status}`);
    }
    return response;
  }

  /**
   * Creates a recipe. Opening the blank form reserves the id the new recipe will get, and
   * that id has to be posted back with the fields.
   */
  async createRecipe(input: RecipeInput): Promise<Recipe> {
    const blank = await parseRecipeForm(await this.getHtml(this.blankFormUrl()));
    const reservedId = blank.fields.id;
    const response = await this.save(
      blank,
      { ...input, id: reservedId },
      `${ADMIN}?page=rm_recipe`,
    );

    const id = ReceptenmakerClient.idFromResponse(response) ?? reservedId;
    if (!id) {
      throw new UpstreamError("the recipe was posted but Receptenmaker returned no recipe id");
    }
    return this.getRecipe(id);
  }

  /** Reads the recipe first and posts the merged result, so absent fields keep their value. */
  async updateRecipe(id: string, patch: RecipeInput): Promise<Recipe> {
    const form = await this.loadRecipeForm(id);
    const current = recipeFromForm(form);
    const { image_url: _ignored, ...currentFields } = current;

    const merged: RecipeInput = {
      ...currentFields,
      ...patch,
      id,
      nutrition: { ...current.nutrition, ...patch.nutrition },
    };

    await this.save(form, merged, `${ADMIN}?page=rm_recipe&action=editRecipe&recipeId=${id}`);
    return this.getRecipe(id);
  }

  async setRecipeCookbooks(id: string, cookbookIds: string[]): Promise<Recipe> {
    return this.updateRecipe(id, { cookbook_ids: cookbookIds });
  }

  /** Irreversible upstream: the recipe is gone, not moved to a trash. */
  async deleteRecipe(id: string): Promise<void> {
    await this.loadRecipeForm(id);
    const response = await this.postForm(this.actionUrl("delete-recipe"), {
      deleteRecipeId: id,
      deleteRecipe: "Recept verwijderen",
    });

    const location = response.headers.get("location") ?? "";
    if (response.status >= 400 || (location && !location.includes("recipe-deleted=success"))) {
      throw new UpstreamError(
        `Receptenmaker did not confirm the deletion of recipe ${id} (HTTP ${response.status})`,
      );
    }
  }

  async shareRecipe(id: string, mode: ShareMode): Promise<Recipe> {
    const [field, label] = SHARE_BUTTONS[mode];
    const response = await this.postForm(this.actionUrl("share-recipe"), {
      shareRecipeId: id,
      [field]: label,
    });
    if (response.status >= 400) {
      throw new UpstreamError(`changing sharing for recipe ${id} failed with HTTP ${response.status}`);
    }
    return this.getRecipe(id);
  }

  /** Hands a URL to Receptenmaker's own importer, which scrapes and stores the recipe. */
  async importRecipeFromUrl(url: string): Promise<Recipe> {
    const response = await this.postForm(`${this.baseUrl}/php/functions.php`, {
      function: "getContentsFromSiteAndSave",
      version: "18",
      url,
    });

    let payload: {
      status?: string;
      objectID?: string | number;
      photoUrl?: string;
      photoStorageId?: string;
    };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      throw new UpstreamError("the import endpoint returned a response that was not JSON");
    }

    switch (payload.status) {
      case "ok":
        break;
      case "site_unsubscribed":
        throw new UpstreamError(
          `${new URL(url).hostname} has opted out of having its recipes saved in Receptenmaker, so this one cannot be imported`,
        );
      case "noURLSpecified":
        throw new UpstreamError(`Receptenmaker did not accept ${url} as a valid recipe URL`);
      default:
        throw new UpstreamError(
          `the importer failed with status "${payload.status ?? "unknown"}"`,
        );
    }

    const id = payload.objectID !== undefined ? String(payload.objectID) : null;
    if (!id) {
      throw new UpstreamError("the importer reported success but returned no recipe id");
    }

    // The importer hands back the photo's source URL and leaves fetching it to a second
    // call, the way the site's own page does after importing.
    if (payload.photoUrl) await this.attachPhoto(id, payload.photoUrl);

    return this.getRecipe(id);
  }

  /** Stores a photo from its source URL against a recipe and makes it the header image. */
  private async attachPhoto(recipeId: string, photoUrl: string): Promise<void> {
    const response = await this.postForm(`${this.baseUrl}/php/photoFunctions.php`, {
      function: "savePhoto",
      objectID: recipeId,
      photoUrl,
    });

    let saved: { status?: string; storageID?: string };
    try {
      saved = (await response.json()) as typeof saved;
    } catch {
      return; // The recipe imported fine; only its photo is missing.
    }
    if (saved.status !== "ok" || !saved.storageID) return;

    await this.postForm(`${this.baseUrl}/php/photoFunctions.php`, {
      function: "setPhotoAsHead",
      objectID: recipeId,
      storageID: saved.storageID,
    });
  }
}
