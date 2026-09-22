import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReceptenmakerClient } from "./rm/client";
import { ReceptenmakerAppClient } from "./rm/app-client";
import { registerTools } from "./tools";
import { loginHandler } from "./login-ui";

/** Stored encrypted in the OAuth grant, so the session can be renewed without the user. */
export interface Props extends Record<string, unknown> {
  username: string;
  password: string;
}

const INSTRUCTIONS = `Read and manage the recipes and cookbooks of one Receptenmaker account.

Recipe text is usually Dutch. Ingredients and instructions are line-separated free text, and
an ingredient line beginning with "--" is a heading within the list.

Categories come from a fixed list (list_categories); no other value is accepted.

Receptenmaker has no shopping list or meal calendar on its servers, so neither can be read or
written here; build a shopping list from get_recipe output instead.

To save a recipe that already exists on the web, prefer import_recipe_from_url over
create_recipe: Receptenmaker's own importer extracts the fields and the photo.`;

export class ReceptenmakerMCP extends McpAgent<Env, null, Props> {
  server = new McpServer(
    { name: "receptenmaker", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
  );

  private client?: ReceptenmakerClient;
  private appClient?: ReceptenmakerAppClient;

  private credentials(): Props {
    const props = this.props as Props | undefined;
    if (!props?.username || !props.password) {
      throw new Error("no Receptenmaker credentials in this session; re-authorize the connection");
    }
    return props;
  }

  async init(): Promise<void> {
    registerTools(this.server, {
      web: () => (this.client ??= new ReceptenmakerClient(this.credentials())),
      app: () => (this.appClient ??= new ReceptenmakerAppClient(this.credentials())),
    });
  }
}

export default new OAuthProvider({
  apiHandlers: {
    "/mcp": ReceptenmakerMCP.serve("/mcp"),
    "/sse": ReceptenmakerMCP.serveSSE("/sse"),
  },
  // The provider types its handlers' env as unknown, so the typed handler is cast here.
  defaultHandler: loginHandler as unknown as ExportedHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
