import { createHash } from "node:crypto";
import { AuthError, UpstreamError, type ClientOptions, type Credentials } from "./client";

/**
 * The endpoint the Receptenmaker mobile app talks to. Unlike the website it speaks JSON and
 * needs no session, and it reaches the one thing the website cannot do at all: creating,
 * renaming and deleting cookbooks. See docs/app-api.md.
 */
export const APP_FUNCTIONS_URL = "https://www.receptenmaker.com/app/functions.php";

/** The app posts a single form part under this fixed boundary; it is reproduced exactly. */
const BOUNDARY = "---------------------------14737809831466499882746641449";

/** Sent with every request, identifying the client build the API expects. */
const CLIENT_INFO = { os: "android", language: "nl", version: "28" } as const;

export interface AppCookbook {
  id: string;
  name: string;
  /** Storage key of the cover image, if the cookbook has one. */
  imageKey: string | null;
}

type Params = Record<string, string>;

interface AppResponse {
  status?: string;
  [key: string]: unknown;
}

/** The app hashes the password and never sends the plaintext. */
function passwordHash(password: string): string {
  return createHash("md5").update(password, "utf8").digest("hex").toUpperCase();
}

/**
 * Collections come back as a JSON-encoded string nested inside the JSON response, so they
 * need decoding a second time.
 */
function decodeList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new UpstreamError("the app API returned a collection that could not be decoded");
  }
}

/**
 * Cookbook management over the mobile app's API.
 *
 * Cookbook ids match the ones the website reports, so ids from the website client can be
 * passed to these methods. Recipe operations stay on the website client: they work there
 * already, and there is nothing to gain from having two ways to do the same thing.
 */
export class ReceptenmakerAppClient {
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly passwordMd5: string;
  private accountId?: string;

  constructor(
    private readonly credentials: Credentials,
    options: ClientOptions & { endpoint?: string } = {},
  ) {
    this.endpoint = options.endpoint ?? APP_FUNCTIONS_URL;
    // Bound to globalThis: the Workers runtime rejects the global fetch called as a method.
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.passwordMd5 = passwordHash(credentials.password);
  }

  /**
   * The app rewrites these three characters in the serialized JSON before sending, and the
   * server reverses it. A title containing a plus arrives mangled without this.
   */
  private static escape(body: string): string {
    return body
      .replaceAll("+", "plussign")
      .replaceAll("m²", "m2value")
      .replaceAll("€", "eurosign");
  }

  private async post(params: Params): Promise<AppResponse> {
    const body = ReceptenmakerAppClient.escape(
      JSON.stringify({ ...CLIENT_INFO, ...params }),
    );
    const multipart =
      `--${BOUNDARY}\r\n` +
      'Content-Disposition: form-data; name="json"\r\n' +
      "Content-Type: text/plain; charset=UTF-8\r\n\r\n" +
      `${body}\r\n` +
      `--${BOUNDARY}--\r\n`;

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      body: multipart,
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    });
    if (!response.ok) {
      throw new UpstreamError(
        `the app API returned HTTP ${response.status} for ${params.function}`,
      );
    }

    let payload: AppResponse;
    try {
      payload = (await response.json()) as AppResponse;
    } catch {
      throw new UpstreamError(
        `the app API returned a non-JSON response for ${params.function}`,
      );
    }

    if (payload.status === "invalidCredentials") {
      throw new AuthError(
        "Receptenmaker rejected the stored credentials; re-authorize this connection",
      );
    }
    return payload;
  }

  private async login(): Promise<string> {
    const payload = await this.post({
      function: "login",
      username: this.credentials.username,
      password: this.passwordMd5,
    });
    const id = payload.user;
    if (payload.status !== "ok" || typeof id !== "string" || id === "") {
      throw new AuthError(
        "Receptenmaker accepted the sign-in but returned no account id, so the app API cannot be used",
      );
    }
    return id;
  }

  /** Authenticated call. The account id is fetched once and kept for this instance. */
  private async call(fn: string, params: Params = {}): Promise<AppResponse> {
    this.accountId ??= await this.login();
    return this.post({
      function: fn,
      user: this.accountId,
      password: this.passwordMd5,
      ...params,
    });
  }

  private async expectOk(fn: string, params: Params, what: string): Promise<AppResponse> {
    const payload = await this.call(fn, params);
    if (payload.status !== "ok") {
      throw new UpstreamError(`${what} failed (status "${payload.status ?? "unknown"}")`);
    }
    return payload;
  }

  async listCookbooks(): Promise<AppCookbook[]> {
    const payload = await this.expectOk(
      "getKookboekenUser",
      { sortKey: "title" },
      "listing cookbooks",
    );
    return decodeList(payload.kookboeken)
      .filter((entry): entry is Record<string, string> => typeof entry === "object" && entry !== null)
      .map((entry) => ({
        id: String(entry.id ?? entry.objectID ?? ""),
        // The app puts the cookbook's own name in `subtitle`; `title` is the owner's name.
        name: (entry.subtitle ?? "").trim(),
        imageKey: entry.imageUrl ? String(entry.imageUrl) : null,
      }))
      .filter((book) => book.id !== "");
  }

  /** Creates a cookbook. Upstream creates it untitled, so the name is set in a second call. */
  async createCookbook(name: string): Promise<{ id: string; name: string }> {
    const created = await this.expectOk("createNewKookboek", {}, "creating the cookbook");
    const id = created.kookboekID;
    if (typeof id !== "string" || id === "") {
      throw new UpstreamError("the cookbook was created but Receptenmaker returned no id");
    }

    try {
      await this.renameCookbook(id, name);
    } catch (error) {
      throw new UpstreamError(
        `the cookbook was created with id ${id} but naming it failed (${
          error instanceof Error ? error.message : String(error)
        }); it currently has no name`,
      );
    }
    return { id, name };
  }

  async renameCookbook(id: string, name: string): Promise<void> {
    await this.expectOk(
      "setKookboekTitle",
      { kookboekID: id, title: name },
      `renaming cookbook ${id}`,
    );
  }

  /** Irreversible upstream. The recipes survive; only the cookbook is removed. */
  async deleteCookbook(id: string): Promise<void> {
    await this.expectOk("deleteKookboek", { kookboekID: id }, `deleting cookbook ${id}`);
  }

  /**
   * Uploads image bytes, base64-encoded, as a new photo on a recipe and returns its storage
   * id. Recipe ids are shared with the website. The bytes must be validated beforehand:
   * for data that is not an image, upstream reports failure yet still stores a broken
   * photo entry.
   */
  async uploadPhoto(recipeId: string, imageBase64: string): Promise<string> {
    const payload = await this.expectOk(
      "savePhoto",
      { objectID: recipeId, imgData: imageBase64 },
      "uploading the photo",
    );
    const id = payload.storageID;
    if (typeof id !== "string" || id === "") {
      throw new UpstreamError("the photo was uploaded but Receptenmaker returned no storage id");
    }
    return id;
  }
}
