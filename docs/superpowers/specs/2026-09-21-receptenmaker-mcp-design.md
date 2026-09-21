# Receptenmaker MCP server — design

Remote MCP server exposing a Receptenmaker account (recipes, cookbooks) to MCP clients.
Runs as a Cloudflare Worker, acts as its own OAuth 2.1 authorization server.

## Discovered upstream surface

`receptenmaker.nl` redirects to `www.receptenmaker.com`: WordPress 7.1.1 with two custom
plugins, `rm_recipe` and `rm_my_cookbooks`. No custom REST namespace exists (all 16
namespaces under `/wp-json/` are third-party), so there is no JSON API for recipe CRUD.
The usable surface is session-cookie-authenticated HTML pages plus form POSTs, and one
small JSON endpoint pair used by the plugin's own JavaScript.

Auth: `POST /wp-login.php` with `log`, `pwd`, `rememberme=forever`. Success is a 302 to
`/wp-admin/` plus `wordpress_logged_in_<hash>`, `wordpress_sec_<hash>` and
`wfwaf-authcookie-<hash>` cookies. Failure returns 200 with `div#login_error`.

| Operation | Request |
| --- | --- |
| List / search | `GET /wp-admin/admin.php?page=recipes` + `s`, `paged`, `orderby`, `order`, `cookbook_id` |
| Read one | `GET /wp-admin/admin.php?page=rm_recipe&action=editRecipe&recipeId=<id>` |
| Blank create form | `GET /wp-admin/admin.php?page=rm_recipe` |
| Create / update | `POST` same URL + `&save-recipe=true`, body `rm_recipe_options[...]` + `plugin_settings_nonce` |
| Delete | `POST …&delete-recipe=true`, body `deleteRecipeId`, `deleteRecipe`, nonce |
| Share | `POST …&share-recipe=true`, body `shareRecipeId` + one of `sharePrivate` / `sharePublic` / `removeShare` |
| Cookbooks | `GET /wp-admin/admin.php?page=cookbooks` |
| Import from URL | `POST /php/functions.php`, body `function=getContentsFromSiteAndSave&version=18&url=<url>` |
| Photos | `POST /php/photoFunctions.php`, `function` in `savePhoto` / `setPhotoAsHead` / `deletePhoto` |

The recipe list is a standard `WP_List_Table`: 20 rows per page, total in
`span.displaying-num`, sortable on `receptNaam`, `soortGerecht`, `bTijd`, `tags`, `bron`,
`aanmaakdatum`. Search (`s`) matches ingredients as well as titles.

`getContentsFromSiteAndSave` returns JSON `{status, objectID?, photoStorageId?, photoUrl?,
imagesRootUrl?}`. `status` is `ok`, `noURLSpecified`, or `site_unsubscribed` (the source
site opted out of being saved). It creates the recipe server-side and returns its id.

Images are public objects at
`https://s3.nl-ams.scw.cloud/nl.mobielbekeken.receptenmaker/recepten/images/<key>/<size>/image.jpg`
with sizes `200x150`, `400x300`, `1024x768`.

### Recipe fields

`rm_recipe_options[...]`, Dutch keys mapped to English tool parameters:

| Upstream | Tool | Notes |
| --- | --- | --- |
| `id` | `id` | omitted when creating |
| `receptNaam` | `name` | required |
| `ingredienten` | `ingredients` | newline-separated free text |
| `bWijze` | `instructions` | newline-separated free text |
| `opmerkingen` | `notes` | |
| `bron`, `bronURL` | `source`, `source_url` | |
| `tags` | `tags` | single hidden input, comma-separated (confirmed in `rm_recipe/js/custom.js`) |
| `aantalPersonen`, `aantalStuks` | `servings`, `pieces` | numeric |
| `vbTijd`, `bTijd`, `ovenTijd`, `ovenTemperatuur` | `prep_time`, `cook_time`, `oven_time`, `oven_temp` | numeric, minutes / °C |
| `energy`, `protein`, `carbohydrate`, `sugars`, `fat`, `saturatedFat`, `natrium`, `salt`, `dietaryFiber` | `nutrition.*` | numeric |
| `soortGerecht[]` | `categories` | checkboxes, 17 fixed values |
| `cookbook[]` | `cookbook_ids` | checkboxes, numeric cookbook ids |
| `openbaar`, `www` | — | share state, read-only; written via the share form |

The 17 categories are fixed: Algemeen, Amuse, Bijgerecht, Brunch, Hoofdgerecht, Lunch,
Nagerecht, Ontbijt, Ovenschotel, Patisserie, Salade, Saus & Dressings, Snacks & Drinks,
Soep, Tussengerecht, Vegetarisch, Voorgerecht.

### Details confirmed by capturing real requests

Three inferences from reading the markup were wrong and were corrected against captured
browser traffic:

- The forms use `action="?save-recipe=true"`, which a browser resolves against `admin.php`
  **without** the `page` parameter. All three actions post to `admin.php?<action>=true`.
- Opening the blank create form **reserves** the id the new recipe will take, and that id is
  posted back with the fields. The save response then redirects to
  `?page=rm_recipe&recipe-updated=success&recipeId=<id>`, which is how a created recipe's id
  is recovered.
- The delete form carries **no** nonce, only `deleteRecipeId` and the submit button's label
  `deleteRecipe=Recept verwijderen`. Deletion is confirmed by the redirect carrying
  `recipe-deleted=success`.

The importer also leaves fetching the photo to a second call: when it returns a `photoUrl`,
the site posts `savePhoto` and then `setPhotoAsHead` to `/php/photoFunctions.php`.
`import_recipe_from_url` does the same, so imported recipes keep their image.

### Not in scope

Creating and editing cookbooks has no web surface — the page states they are managed in
the mobile app. The shopping list and meal calendar are likewise app-only. Recipes can
still be assigned to existing cookbooks. Reverse-engineering the Android APK to reach
those features is out of scope.

## Architecture

```
MCP client ──OAuth 2.1──> Worker (OAuthProvider)
                            ├── /authorize  login form + consent (login-ui.ts)
                            ├── /token, /register (provider built-ins, KV-backed)
                            └── /mcp  ──> ReceptenmakerMCP (Durable Object)
                                            └── ReceptenmakerClient ──HTTP──> receptenmaker.com
```

`@cloudflare/workers-oauth-provider` handles the OAuth endpoints, dynamic client
registration and token storage in KV. The Worker's own `/authorize` page collects
Receptenmaker credentials and validates them with a real `wp-login.php` POST before any
grant is issued, so an invalid password never produces a token.

Credentials are stored in the grant's `props`, which the provider encrypts at rest; the
key is derived from the access token, so props are unreadable without a token the client
holds. This is what lets the Worker silently re-login when the WordPress session expires
(~2 days, or 14 with `rememberme`) instead of forcing periodic re-authorization.

Session cookies are held only in the Durable Object's memory, never persisted. A cold DO
logs in on its first upstream call.

### Modules

- `src/index.ts` — OAuthProvider wiring, `ReceptenmakerMCP` McpAgent export.
- `src/login-ui.ts` — `/authorize` login + consent form, credential validation.
- `src/rm/client.ts` — `ReceptenmakerClient`: cookie jar, nonce fetch, form encoding, transparent re-login with one retry.
- `src/rm/parse.ts` — HTML extraction with `node-html-parser` (list table, recipe form, cookbooks).
- `src/shims/ai.ts` — stub aliased over the optional `ai` package; `agents` reaches for it lazily in a code path only an MCP *client* uses.
- `src/rm/fields.ts` — bidirectional Dutch/English field mapping, category constants.
- `src/tools.ts` — MCP tool registration with zod schemas.

`node-html-parser` is chosen over the Workers-native `HTMLRewriter`. `HTMLRewriter` needs no
dependency, but it is a streaming callback API available only inside workerd, which made the
parsers state machines and forced the test suite into `@cloudflare/vitest-pool-workers`.
A pure-TypeScript parser runs in both Node and Workers, so the parsers are ordinary CSS
selector queries and the tests are plain Vitest. It also sidesteps a genuine hazard: the
recipe form's markup makes HTML parsers unwrap `form#recipe-options-form`, so fields are
located by name across the document instead.

### Tools

Read: `search_recipes`, `get_recipe`, `list_cookbooks`, `list_categories`, `list_tags`.
Write: `create_recipe`, `update_recipe`, `delete_recipe`, `set_recipe_cookbooks`,
`share_recipe`, `import_recipe_from_url`.

`update_recipe` reads the current recipe, merges the caller's partial changes and posts the
full field set, so unspecified fields are never cleared by a partial update.

Receptenmaker has no category filter, so `search_recipes` implements `category` by walking
every page and filtering locally; the result says so, and the tool description warns that it
costs more requests than a text query.

## Error handling

- Wrong credentials at `/authorize` → form re-rendered with an error; no grant issued.
- Session expired mid-request (upstream redirects to `wp-login.php`) → re-login once and
  retry; a second failure surfaces as an MCP error telling the user to re-authorize.
- Recipe id not found → the edit form comes back without an `id` value → explicit
  `RecipeNotFoundError`.
- Parse failure → throw a descriptive error naming the selector that failed. An empty
  result set and a changed WordPress template must never look alike, because the failure
  mode that matters is "you have no recipes" when in fact the page changed shape.
- `site_unsubscribed` from the import endpoint → returned to the caller as a clear,
  non-retryable message.

## Testing

Plain `vitest` in the Node environment, which the pure-TypeScript parser makes possible.

- Parser unit tests against sanitized fixtures captured from the live account
  (`test/fixtures/`): 20-row list page with a 69-item total, a 9-hit search page, a recipe
  with a category set, a recipe with none, and the cookbooks page.
- Client tests with a stubbed `fetch`: login success and failure, cookie propagation,
  nonce extraction, re-login-on-expiry, form encoding of array fields.
- Field-mapping round-trip tests.
- A live integration test, skipped unless `RM_USER` / `RM_PASS` are present, so it never
  runs in CI against a real account. Its write half additionally requires `RM_LIVE_WRITE=1`.

Unit tests inject a `fetch` stub, which cannot catch everything: the Workers runtime rejects
the global `fetch` called as an instance method ("Illegal invocation"), which only surfaced
when the Worker was booted and driven through a real OAuth flow. A boot-and-drive pass over
`wrangler dev` is therefore part of verifying a change, not an optional extra.

## Deployment

GitHub `lennertcc/receptenmaker-mcp` (public). Cloudflare Workers Builds watches the
repository and deploys on push to `main`, so no Cloudflare credential is needed outside
the dashboard.

One-time manual setup, documented in the README: connect the repo in the Cloudflare
dashboard, create the `OAUTH_KV` namespace and put its id in `wrangler.jsonc`, and set the
`COOKIE_ENCRYPTION_KEY` secret. The Durable Object is created automatically by the
migration on first deploy.

## Security notes

- The repository is public and contains no credentials; the fixtures are sanitized.
- Storing a user's Receptenmaker password (encrypted, token-derived key) is a deliberate
  tradeoff accepted in exchange for not re-authorizing every two days. Dropping it means
  falling back to cookie-only sessions.
- `delete_recipe` is irreversible upstream, so its description states that plainly for the
  benefit of the calling model.
