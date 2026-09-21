import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { AuthError, ReceptenmakerClient } from "./rm/client";

/**
 * How long a started sign-in stays valid. The authorization request is held server-side in
 * KV and the browser only carries an unguessable id, so nothing about the request (least of
 * all redirect_uri) can be tampered with on the way through the login form. That needs no
 * signing secret, which in turn means this Worker needs no configuration beyond its
 * bindings.
 */
const LOGIN_TTL_SECONDS = 900;

const loginKey = (id: string) => `login-request:${id}`;

async function startLogin(env: Env, request: AuthRequest): Promise<string> {
  const id = crypto.randomUUID();
  await env.OAUTH_KV.put(loginKey(id), JSON.stringify(request), {
    expirationTtl: LOGIN_TTL_SECONDS,
  });
  return id;
}

async function resumeLogin(env: Env, id: string): Promise<AuthRequest | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const stored = await env.OAUTH_KV.get(loginKey(id));
  if (!stored) return null;
  try {
    return JSON.parse(stored) as AuthRequest;
  } catch {
    return null;
  }
}

/** Sign-ins are single use: finishing one retires its id so it cannot be replayed. */
async function finishLogin(env: Env, id: string): Promise<void> {
  await env.OAUTH_KV.delete(loginKey(id));
}

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(body: string, status = 200): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receptenmaker MCP</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfaf8;
    --card: #ffffff;
    --ink: #1c1917;
    --muted: #6b6560;
    --line: #e5e0da;
    --accent: #7c8f3f;
    --error-bg: #fdf0ee;
    --error-ink: #9b2c1c;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #171614;
      --card: #211f1d;
      --ink: #f4f1ec;
      --muted: #a39d96;
      --line: #35322e;
      --accent: #a8bd5c;
      --error-bg: #2f1d19;
      --error-ink: #f0a696;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 16px; background: var(--bg); color: var(--ink);
    font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex; justify-content: center;
  }
  main { width: 100%; max-width: 27rem; }
  .card {
    background: var(--card); border: 1px solid var(--line);
    border-radius: 14px; padding: 28px;
  }
  h1 { font-size: 1.3rem; margin: 0 0 6px; letter-spacing: -0.01em; }
  p { color: var(--muted); margin: 0 0 20px; font-size: 0.925rem; }
  label { display: block; font-size: 0.8rem; font-weight: 600; margin: 16px 0 6px; }
  input[type=email], input[type=text], input[type=password] {
    width: 100%; padding: 10px 12px; font-size: 1rem; color: var(--ink);
    background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
  }
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button {
    width: 100%; margin-top: 22px; padding: 11px 14px; font-size: 1rem; font-weight: 600;
    color: #fff; background: var(--accent); border: 0; border-radius: 8px; cursor: pointer;
  }
  button:hover { filter: brightness(1.07); }
  .client { font-size: 0.875rem; color: var(--muted); }
  .client strong { color: var(--ink); }
  .error {
    background: var(--error-bg); color: var(--error-ink); border-radius: 8px;
    padding: 10px 12px; font-size: 0.875rem; margin: 0 0 4px;
  }
  .note { font-size: 0.8rem; color: var(--muted); margin: 18px 0 0; }
</style>
</head>
<body><main>${body}</main></body>
</html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function loginPage(
  loginId: string,
  clientName: string,
  username: string,
  error?: string,
): Response {
  return page(
    `<div class="card">
  <h1>Connect Receptenmaker</h1>
  <p class="client"><strong>${escape(clientName)}</strong> is asking to read and change the recipes in your Receptenmaker account.</p>
  ${error ? `<p class="error">${escape(error)}</p>` : ""}
  <form method="post" action="/authorize">
    <input type="hidden" name="login_id" value="${escape(loginId)}">
    <label for="username">Receptenmaker e-mail or username</label>
    <input id="username" name="username" type="text" autocomplete="username" required autofocus value="${escape(username)}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in and allow access</button>
  </form>
  <p class="note">Your sign-in is checked against receptenmaker.com. Approving stores your
  credentials encrypted so this connection can keep working after the site's session expires.
  Revoke it at any time by removing this connection in your client.</p>
</div>`,
    error ? 401 : 200,
  );
}

function homePage(): Response {
  return page(`<div class="card">
  <h1>Receptenmaker MCP</h1>
  <p>A Model Context Protocol server for Receptenmaker recipes and cookbooks.</p>
  <p class="note">Add <code>/mcp</code> on this host to your MCP client. Your client starts the
  sign-in itself; there is nothing to do on this page.</p>
</div>`);
}

/** Everything that is not an OAuth token endpoint or the MCP API. */
export const loginHandler: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize" && request.method === "GET") {
      const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
      return loginPage(
        await startLogin(env, authRequest),
        client?.clientName ?? "An MCP client",
        "",
      );
    }

    if (url.pathname === "/authorize" && request.method === "POST") {
      const form = await request.formData();
      const loginId = String(form.get("login_id") ?? "");
      const username = String(form.get("username") ?? "").trim();
      const password = String(form.get("password") ?? "");

      const authRequest = await resumeLogin(env, loginId);
      if (!authRequest) {
        return page(
          `<div class="card"><h1>Sign-in expired</h1><p>Start the connection again from your MCP client.</p></div>`,
          400,
        );
      }

      const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
      const clientName = client?.clientName ?? "An MCP client";

      if (!username || !password) {
        return loginPage(loginId, clientName, username, "Fill in both fields.");
      }

      try {
        await new ReceptenmakerClient({ username, password }).login();
      } catch (error) {
        if (!(error instanceof AuthError)) {
          console.error("receptenmaker sign-in failed unexpectedly", error);
        }
        const message =
          error instanceof AuthError
            ? error.message
            : "Could not reach Receptenmaker. Try again in a moment.";
        // The stored request is left in place so the form can be submitted again.
        return loginPage(loginId, clientName, username, message);
      }

      await finishLogin(env, loginId);
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: authRequest,
        userId: username,
        metadata: { label: username },
        scope: authRequest.scope,
        props: { username, password },
      });
      return Response.redirect(redirectTo, 302);
    }

    if (url.pathname === "/" || url.pathname === "") return homePage();

    return new Response("Not found", { status: 404 });
  },
};
