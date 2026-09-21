/**
 * Stub for the optional `ai` package.
 *
 * `agents` reaches for it with a lazy `await import("ai")` in the code path that converts
 * remote MCP tool schemas — only used when an agent acts as an MCP *client*. This server is
 * only ever the MCP server, so the import is aliased here instead of pulling in the AI SDK.
 * It throws rather than returning a stub value, so a future code path that genuinely needs
 * it fails loudly instead of misbehaving.
 */
const unavailable = (name: string) => () => {
  throw new Error(
    `the optional "ai" package is not bundled in this Worker, but ${name}() was called; add "ai" as a dependency and drop the alias in wrangler.jsonc`,
  );
};

export const jsonSchema = unavailable("jsonSchema");
export const tool = unavailable("tool");
export default { jsonSchema, tool };
