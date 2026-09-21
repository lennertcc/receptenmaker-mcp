import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

declare global {
  /** Added to the bindings Wrangler generates: the OAuth provider's own helpers. */
  interface Env {
    OAUTH_PROVIDER: OAuthHelpers;
  }
}
