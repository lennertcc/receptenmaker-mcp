# receptenmaker-mcp

A remote [MCP](https://modelcontextprotocol.io) server for
[Receptenmaker](https://www.receptenmaker.com), the Dutch recipe app. It lets an MCP client
read and manage the recipes and cookbooks in one Receptenmaker account.

Runs as a Cloudflare Worker and is its own OAuth 2.1 authorization server, so any MCP client
that supports remote servers can connect to it and sign in with Receptenmaker credentials.

## Tools

| Tool | What it does |
| --- | --- |
| `search_recipes` | Search or browse recipes; text matches names and ingredients |
| `get_recipe` | One recipe in full, including nutrition and cookbooks |
| `list_cookbooks` | The account's cookbooks |
| `list_categories` | The 17 dish categories Receptenmaker accepts |
| `list_tags` | Tags defined on the account |
| `create_recipe` | Add a recipe |
| `update_recipe` | Change a recipe; omitted fields keep their value |
| `delete_recipe` | Delete a recipe, permanently |
| `set_recipe_cookbooks` | Replace the cookbooks a recipe belongs to |
| `share_recipe` | Share publicly, share by link, or stop sharing |
| `import_recipe_from_url` | Hand a recipe page to Receptenmaker's importer, photo included |

### Not supported

Creating or renaming cookbooks, the shopping list and the meal calendar exist only in the
Receptenmaker mobile app — the website has no interface for them, so this server cannot
offer them either. Recipes can still be assigned to cookbooks that already exist.

## How it works

Receptenmaker has no public API. Its web app is a WordPress plugin that renders server-side
HTML, so this server signs in the way a browser does, reads the pages it needs and posts the
same forms. Request shapes were confirmed by capturing real browser traffic;
`docs/superpowers/specs/` documents the surface in detail, and the parsers are tested against
HTML captured from a live account.

Credentials are stored in the OAuth grant, which
[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
encrypts at rest with a key derived from the access token. The Worker needs them because the
upstream WordPress session expires after roughly two weeks and has to be renewed without
prompting the user again. Revoking the connection in your MCP client discards them.

## Deploying

Cloudflare Workers Builds watches this repository and deploys on every push to `main`. Three
one-time steps in the Cloudflare dashboard:

1. **Connect the repository.** Workers & Pages → Create → Workers → *Import a repository*,
   pick this repo. Build command `npm run deploy`, no build output directory.
2. **Create the KV namespace.** Storage & Databases → KV → *Create namespace*, name it
   `receptenmaker-mcp-oauth`. Copy its id into `kv_namespaces[0].id` in `wrangler.jsonc`,
   replacing `REPLACE_WITH_KV_NAMESPACE_ID`, and commit. This namespace holds OAuth clients,
   grants and tokens.
3. **Set the signing secret,** after the first deploy has created the Worker:

   ```sh
   npx wrangler login     # once, if this machine has no Cloudflare credentials
   openssl rand -base64 32 | npx wrangler secret put COOKIE_ENCRYPTION_KEY
   ```

   Piping it keeps the value off your screen and out of your shell history. The dashboard
   equivalent is the Worker's Settings → Variables and Secrets → Add.

   Add it as an encrypted **Secret**, not a plain-text Variable: a deploy can clear
   dashboard-set variables that are absent from `wrangler.jsonc`, while secrets survive.
   Until it is set, `/authorize` answers 503 with a page saying so; everything else works.

   The key signs the authorization request while it round-trips through the login form, so
   a tampered `redirect_uri` cannot come back from the browser. Rotating it is safe: it
   invalidates only sign-ins that are mid-flight, never connections that already exist,
   because stored credentials are encrypted with token-derived keys instead.

The Durable Object that keeps each MCP session is created automatically by the migration in
`wrangler.jsonc` on the first deploy.

Then point your MCP client at `https://<your-worker>.workers.dev/mcp`. The client registers
itself, you sign in with your Receptenmaker e-mail and password, and that's it.

## Local development

```sh
npm install
echo "COOKIE_ENCRYPTION_KEY=$(openssl rand -base64 32)" > .dev.vars
npm run dev
```

The Worker serves `/mcp` on `http://localhost:8799` with local KV and Durable Object
emulation, so the whole OAuth flow can be exercised without deploying.

## Tests

```sh
npm test          # parser, field-mapping and client tests; no network
npm run typecheck
```

The parser tests run against HTML fixtures captured from a real account: the markup is
unchanged, so the parsers are tested against the real page structure, but recipe titles,
ingredients, sources and image keys have been replaced with invented ones.

Live tests are skipped unless credentials are supplied, and are read-only by default:

```sh
RM_USER=you@example.com RM_PASS=... npm test
RM_USER=... RM_PASS=... RM_LIVE_WRITE=1 npm test   # also creates and deletes a scratch recipe
```

## Notes

- The KV namespace id committed in `wrangler.jsonc` is a resource identifier, not a
  credential: it grants nothing without Cloudflare API credentials for the account, and
  Workers Builds needs it at build time. The same goes for the Durable Object binding.

- Recipe content is generally Dutch. Ingredients and instructions are line-separated text,
  and an ingredient line starting with `--` is a heading within the list.
- Categories are a fixed list; Receptenmaker rejects anything else.
- Receptenmaker offers no category filter, so `search_recipes` implements one by fetching
  every page and filtering locally. It is slower than a text query.
- Some sites opt out of being imported; `import_recipe_from_url` reports that clearly.
