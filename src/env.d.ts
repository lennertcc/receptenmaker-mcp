import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

declare global {
  /** Added to the bindings Wrangler generates: a secret and the provider's own helpers. */
  interface Env {
    /** Signing key for the authorization request carried through the login form. */
    COOKIE_ENCRYPTION_KEY: string;
    OAUTH_PROVIDER: OAuthHelpers;
  }
}
