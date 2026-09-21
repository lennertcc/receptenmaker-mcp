import { describe, it, expect } from "vitest";
import listHtml from "./fixtures/recipes-list.html?raw";
import searchHtml from "./fixtures/recipes-search.html?raw";
import editHtml from "./fixtures/recipe-edit.html?raw";
import cookbooksHtml from "./fixtures/cookbooks.html?raw";
import { AuthError, ReceptenmakerClient, UpstreamError } from "../src/rm/client";

const CREDS = { username: "testuser@example.com", password: "pw" };

/** A result page with the table present but no rows. */
const searchEmptyHtml = searchHtml.replace(/<tr[^>]*>[\s\S]*?<\/tr>/g, "");

interface Call {
  url: string;
  method: string;
  body: string;
  cookie: string | null;
}

/** Scriptable fetch stub: each handler answers one request and records it. */
function stubFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const call: Call = {
      url: req.url,
      method: req.method,
      body: req.method === "POST" ? await req.text() : "",
      cookie: req.headers.get("cookie"),
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const loginOk = () =>
  new Response(null, {
    status: 302,
    headers: {
      location: "https://www.receptenmaker.com/wp-admin/",
      "set-cookie": "wordpress_logged_in_abc=token; path=/; HttpOnly",
    },
  });

const loginFailed = () =>
  new Response(
    `<div id="login"><div id="login_error">Het wachtwoord dat je hebt ingevoerd is onjuist.</div></div>`,
    { status: 200, headers: { "content-type": "text/html" } },
  );

const html = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html" } });

function client(handler: (call: Call) => Response) {
  const { fetchImpl, calls } = stubFetch(handler);
  return { rm: new ReceptenmakerClient(CREDS, { fetchImpl }), calls };
}

describe("login", () => {
  it("posts the credentials and reuses the session cookie on later requests", async () => {
    const { rm, calls } = client((call) =>
      call.url.includes("wp-login.php") ? loginOk() : html(listHtml),
    );
    await rm.listRecipes({});

    expect(calls[0].url).toContain("/wp-login.php");
    expect(calls[0].body).toContain("log=testuser%40example.com");
    expect(calls[0].body).toContain("pwd=pw");
    expect(calls[0].body).toContain("rememberme=forever");
    expect(calls[1].cookie).toContain("wordpress_logged_in_abc=token");
  });

  it("logs in once for several calls", async () => {
    const { rm, calls } = client((call) =>
      call.url.includes("wp-login.php")
        ? loginOk()
        : html(call.url.includes("page=cookbooks") ? cookbooksHtml : listHtml),
    );
    await rm.listRecipes({});
    await rm.listCookbooks();

    expect(calls.filter((c) => c.url.includes("wp-login.php"))).toHaveLength(1);
  });

  it("raises AuthError with the upstream message when the password is wrong", async () => {
    const { rm } = client(() => loginFailed());
    await expect(rm.listRecipes({})).rejects.toThrow(AuthError);
    await expect(rm.listRecipes({})).rejects.toThrow(/wachtwoord/);
  });

  it("raises AuthError when login returns no session cookie", async () => {
    const { rm } = client(
      () => new Response(null, { status: 302, headers: { location: "/wp-admin/" } }),
    );
    await expect(rm.listRecipes({})).rejects.toThrow(AuthError);
  });
});

describe("session expiry", () => {
  it("logs in again and retries once when the session has lapsed", async () => {
    let listAttempts = 0;
    const { rm, calls } = client((call) => {
      if (call.url.includes("wp-login.php")) return loginOk();
      listAttempts += 1;
      if (listAttempts === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://www.receptenmaker.com/wp-login.php?redirect_to=x" },
        });
      }
      return html(listHtml);
    });

    const result = await rm.listRecipes({});
    expect(result.total).toBe(69);
    expect(calls.filter((c) => c.url.includes("wp-login.php"))).toHaveLength(2);
  });

  it("gives up after a second expiry instead of looping", async () => {
    const { rm, calls } = client((call) =>
      call.url.includes("wp-login.php")
        ? loginOk()
        : new Response(null, {
            status: 302,
            headers: { location: "https://www.receptenmaker.com/wp-login.php" },
          }),
    );
    await expect(rm.listRecipes({})).rejects.toThrow(AuthError);
    expect(calls.filter((c) => c.url.includes("wp-login.php")).length).toBeLessThanOrEqual(2);
  });
});

describe("listRecipes", () => {
  it("passes search, sort, paging and cookbook filters upstream", async () => {
    const { rm, calls } = client((call) =>
      call.url.includes("wp-login.php") ? loginOk() : html(listHtml),
    );
    await rm.listRecipes({
      query: "soep",
      sort: "name",
      order: "desc",
      page: 3,
      cookbookId: "69061",
    });

    const url = new URL(calls[1].url);
    expect(url.searchParams.get("page")).toBe("recipes");
    expect(url.searchParams.get("s")).toBe("soep");
    expect(url.searchParams.get("orderby")).toBe("receptNaam");
    expect(url.searchParams.get("order")).toBe("desc");
    expect(url.searchParams.get("paged")).toBe("3");
    expect(url.searchParams.get("cookbook_id")).toBe("69061");
  });
});

describe("getRecipe", () => {
  it("returns the recipe mapped to the English shape", async () => {
    const { rm } = client((call) =>
      call.url.includes("wp-login.php") ? loginOk() : html(editHtml),
    );
    const recipe = await rm.getRecipe("4166830");
    expect(recipe.name).toBe("Groentesoep met linzen");
    expect(recipe.categories).toEqual(["Hoofdgerecht"]);
  });
});

describe("updateRecipe", () => {
  it("merges the patch over the current recipe so unsent fields survive", async () => {
    const { rm, calls } = client((call) =>
      call.url.includes("wp-login.php") ? loginOk() : html(editHtml),
    );
    await rm.updateRecipe("4166830", { notes: "lekker" });

    const save = calls.find((c) => c.method === "POST" && c.url.includes("save-recipe"));
    expect(save).toBeDefined();
    const body = new URLSearchParams(save!.body);
    expect(body.get("rm_recipe_options[opmerkingen]")).toBe("lekker");
    expect(body.get("rm_recipe_options[receptNaam]")).toBe("Groentesoep met linzen");
    expect(body.get("rm_recipe_options[id]")).toBe("4166830");
    expect(body.getAll("rm_recipe_options[soortGerecht][]")).toEqual(["Hoofdgerecht"]);
    expect(body.get("plugin_settings_nonce")).toBe("testnonce123");
  });
});

describe("createRecipe", () => {
  it("posts to the blank form without a recipe id", async () => {
    const { rm, calls } = client((call) =>
      call.url.includes("wp-login.php") ? loginOk() : html(editHtml),
    );
    await rm.createRecipe({ name: "Nieuw recept", ingredients: "zout" });

    const save = calls.find((c) => c.method === "POST" && c.url.includes("save-recipe"));
    const body = new URLSearchParams(save!.body);
    expect(body.get("rm_recipe_options[receptNaam]")).toBe("Nieuw recept");
    // The blank form reserves the id the new recipe will take, and it is posted back.
    expect(body.get("rm_recipe_options[id]")).toBe("4166830");
    expect(save!.url).toContain("save-recipe=true");
    expect(save!.url).not.toContain("page=");
  });
});

describe("deleteRecipe", () => {
  it("posts the delete form the way the browser does", async () => {
    const { rm, calls } = client((call) =>
      call.url.includes("wp-login.php") ? loginOk() : html(editHtml),
    );
    await rm.deleteRecipe("4166830");

    const del = calls.find((c) => c.method === "POST" && c.url.includes("delete-recipe"));
    expect(del).toBeDefined();
    const body = new URLSearchParams(del!.body);
    expect(body.get("deleteRecipeId")).toBe("4166830");
    // The upstream delete form posts the submit button's label and carries no nonce.
    expect(body.get("deleteRecipe")).toBe("Recept verwijderen");
    expect(del!.url).toContain("delete-recipe=true");
  });
});

describe("shareRecipe", () => {
  it("sends the flag matching the requested visibility", async () => {
    for (const [mode, field] of [
      ["private", "sharePrivate"],
      ["public", "sharePublic"],
      ["none", "removeShare"],
    ] as const) {
      const { rm, calls } = client((call) =>
        call.url.includes("wp-login.php") ? loginOk() : html(editHtml),
      );
      await rm.shareRecipe("4166830", mode);
      const post = calls.find((c) => c.method === "POST" && c.url.includes("share-recipe"));
      const body = new URLSearchParams(post!.body);
      expect(body.get("shareRecipeId")).toBe("4166830");
      expect(body.get(field)).not.toBeNull();
    }
  });
});

describe("importRecipeFromUrl", () => {
  it("returns the recipe the upstream importer created", async () => {
    const { rm, calls } = client((call) => {
      if (call.url.includes("wp-login.php")) return loginOk();
      if (call.url.includes("/php/functions.php")) {
        return Response.json({ status: "ok", objectID: "4166830" });
      }
      return html(editHtml);
    });

    const recipe = await rm.importRecipeFromUrl("https://example.com/recept");
    expect(recipe.id).toBe("4166830");
    const post = calls.find((c) => c.url.includes("/php/functions.php"));
    const body = new URLSearchParams(post!.body);
    expect(body.get("function")).toBe("getContentsFromSiteAndSave");
    expect(body.get("url")).toBe("https://example.com/recept");
  });

  it("explains that the source site opted out", async () => {
    const { rm } = client((call) =>
      call.url.includes("wp-login.php")
        ? loginOk()
        : Response.json({ status: "site_unsubscribed" }),
    );
    await expect(rm.importRecipeFromUrl("https://opted-out.example")).rejects.toThrow(
      /opted out|site_unsubscribed/i,
    );
  });

  it("reports an invalid url", async () => {
    const { rm } = client((call) =>
      call.url.includes("wp-login.php")
        ? loginOk()
        : Response.json({ status: "noURLSpecified" }),
    );
    await expect(rm.importRecipeFromUrl("not-a-url")).rejects.toThrow(UpstreamError);
  });
});

describe("listCookbooks", () => {
  it("returns the account's cookbooks", async () => {
    const { rm } = client((call) =>
      call.url.includes("wp-login.php") ? loginOk() : html(cookbooksHtml),
    );
    const books = await rm.listCookbooks();
    expect(books).toHaveLength(4);
    expect(books[0].name).toBe("weekmenu");
  });
});

describe("listAllRecipes", () => {
  it("walks every page of a larger library", async () => {
    // The fixture reports 69 items and returns 20 rows, so four pages are expected.
    const { rm, calls } = client((call) =>
      call.url.includes("wp-login.php") ? loginOk() : html(listHtml),
    );
    const all = await rm.listAllRecipes({});

    const paged = calls.filter((c) => c.url.includes("page=recipes"));
    expect(paged).toHaveLength(4);
    expect(new URL(paged[3].url).searchParams.get("paged")).toBe("4");
    expect(all.total).toBe(69);
    expect(all.items).toHaveLength(80);
  });

  it("stops early when a page comes back empty", async () => {
    let n = 0;
    const { rm, calls } = client((call) => {
      if (call.url.includes("wp-login.php")) return loginOk();
      n += 1;
      return html(n === 1 ? listHtml : searchEmptyHtml);
    });
    await rm.listAllRecipes({});
    expect(calls.filter((c) => c.url.includes("page=recipes")).length).toBeLessThan(4);
  });

  it("honours the page cap", async () => {
    const { rm, calls } = client((call) =>
      call.url.includes("wp-login.php") ? loginOk() : html(listHtml),
    );
    await rm.listAllRecipes({}, 2);
    expect(calls.filter((c) => c.url.includes("page=recipes"))).toHaveLength(2);
  });
});
