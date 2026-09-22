# receptenmaker-mcp

A remote [MCP](https://modelcontextprotocol.io) server for
[Receptenmaker](https://www.receptenmaker.com), the Dutch recipe app, so an AI assistant can
search, read and edit the recipes and cookbooks in your account.

Ask which of your recipes use up the courgettes you have left, have a recipe from a blog
saved to your collection with its photo, sort a stack of untagged recipes into cookbooks, or
tidy up the notes on the twelve variations of banana bread you have accumulated.

It runs as a single Cloudflare Worker and is its own OAuth 2.1 authorization server, so any
MCP client that supports remote servers can connect and sign in with Receptenmaker
credentials. Each user's data stays their own.

> Unofficial and not affiliated with Receptenmaker. Receptenmaker publishes no API, so this
> server drives its website the way a browser does. That works today and could break
> whenever the site changes.

## Tools

| Tool | What it does |
| --- | --- |
| `search_recipes` | Search or browse recipes; text matches names and ingredients |
| `get_recipe` | One recipe in full, including times, nutrition and cookbooks |
| `list_cookbooks` | The cookbooks in the account |
| `list_categories` | The 17 dish categories Receptenmaker accepts |
| `list_tags` | Tags defined on the account |
| `create_recipe` | Add a recipe |
| `update_recipe` | Change a recipe; fields left out keep their value |
| `delete_recipe` | Delete a recipe, permanently |
| `set_recipe_cookbooks` | Replace the cookbooks a recipe belongs to |
| `share_recipe` | Share publicly, share by link, or stop sharing |
| `import_recipe_from_url` | Hand a recipe page to Receptenmaker's own importer, photo included |

## Connecting a client

Point your client at `/mcp` on the deployed Worker. In Claude Code:

```sh
claude mcp add --transport http receptenmaker https://<your-worker>.workers.dev/mcp
```

Or, for clients configured by file:

```json
{
  "mcpServers": {
    "receptenmaker": { "url": "https://<your-worker>.workers.dev/mcp" }
  }
}
```

The client registers itself, a browser window asks for your Receptenmaker e-mail and
password, and that is the whole setup. Disconnecting the server in your client revokes the
grant and discards the stored credentials.

## Deploy your own

You need a Cloudflare account. There are no secrets to manage.

1. Fork this repository.
2. **Create a KV namespace** — Cloudflare dashboard → Storage & Databases → KV → *Create
   namespace*. Put its id in `kv_namespaces[0].id` in `wrangler.jsonc`, replacing the id
   that is there, and commit. It holds OAuth clients, grants and tokens.
3. **Connect the repository** — Workers & Pages → Create → Workers → *Import a repository*.
   Build command `npm run deploy`, no build output directory.

Every push to `main` then deploys. The Durable Object that holds each MCP session is created
by the migration in `wrangler.jsonc` on the first deploy.

Deploying from a machine with Wrangler works too: `npm install && npx wrangler deploy`.

## How it works

Receptenmaker's web app is a WordPress plugin that renders server-side HTML and exposes no
JSON API, so the client here signs in through `wp-login.php`, reads the pages it needs and
posts the same forms a browser would. The exact request shapes were established by capturing
real browser traffic rather than guessed from markup — several plausible-looking assumptions
turned out to be wrong. [`docs/design.md`](docs/design.md) documents the whole surface.

Session cookies live only in the Durable Object's memory. Recipe pages are parsed with CSS
selectors, and a parser that no longer recognises a page raises an error naming what it
looked for, so a changed template can never be mistaken for an empty recipe collection.

`update_recipe` reads the recipe, merges your changes and posts the complete field set, so a
partial update cannot silently blank the fields it did not mention.

## Credentials

The Worker stores your Receptenmaker username and password in the OAuth grant, which
[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
encrypts at rest under a key derived from your access token — unreadable without a token
your client holds. It keeps them because the upstream WordPress session lapses after about
two weeks and has to be renewed without asking you again. Storing a password is a real
tradeoff, taken deliberately: the alternative is keeping only a session cookie and having
every connection break every couple of days.

A sign-in in progress is held server-side in KV under a single-use random id, so the browser
never carries the authorization request and there is no signing secret to configure.

## Development

```sh
npm install
npm run dev        # serves /mcp on localhost:8787 with local KV and Durable Objects
npm test           # parsers, field mapping, client; no network
npm run typecheck
```

The parser tests run against HTML fixtures captured from a real account. The markup is
untouched, so the parsers face the real page structure — including a quirk that makes HTML
parsers unwrap the recipe form — but recipe titles, ingredients, sources and image keys have
been replaced with invented ones.

Live tests need credentials and are read-only unless you opt in:

```sh
RM_USER=you@example.com RM_PASS=... npm test
RM_USER=... RM_PASS=... RM_LIVE_WRITE=1 npm test   # also creates and deletes a scratch recipe
```

Booting the Worker is part of verifying a change: the Workers runtime rejects the global
`fetch` called as an instance method, and no amount of stubbed-`fetch` unit testing catches
that.

## Limitations

- **Cookbooks cannot be created, renamed or deleted.** The website offers no interface for
  it, so there is nothing here to drive. Recipes can still be assigned to cookbooks that
  already exist. The mobile app's private API does support it —
  [`docs/app-api.md`](docs/app-api.md) documents that surface.
- **There is no shopping list or meal calendar to expose,** and this is not a gap in this
  server: neither exists on Receptenmaker's servers. The app collects ingredients and hands
  them to a share sheet, and "put in agenda" opens the phone's own calendar app. An
  assistant can build a shopping list from `get_recipe` output directly.
- **Categories are a fixed list of 17**; Receptenmaker rejects anything else. Ask
  `list_categories`.
- **Filtering by category costs several requests.** Receptenmaker has no category filter, so
  `search_recipes` fetches every page and filters locally. A text query is much cheaper.
- **Some sites refuse to be imported.** Site owners can opt out of Receptenmaker's importer,
  and `import_recipe_from_url` says so plainly when they have.
- Recipe content is generally Dutch. Ingredients and instructions are line-separated text,
  and an ingredient line starting with `--` is a heading within the list.

## Implementation notes

- The KV namespace id in `wrangler.jsonc` is a resource identifier, not a credential: it
  grants nothing without Cloudflare API credentials for the account, and Workers Builds needs
  it at build time. The same is true of the Durable Object binding.
- `.npmrc` pins `legacy-peer-deps=true`. The `agents` package declares peer dependencies it
  does not use here, React among them, that npm cannot resolve strictly; without this a
  clean `npm ci` fails, and so does the Workers build.
- `src/shims/ai.ts` is aliased over the optional `ai` package, which `agents` reaches for
  lazily in a code path only an MCP *client* uses. It throws if ever called, so a future need
  for it fails loudly rather than quietly.
