import { describe, it, expect } from "vitest";
import { AuthError, UpstreamError } from "../src/rm/client";
import { APP_FUNCTIONS_URL, ReceptenmakerAppClient } from "../src/rm/app-client";

const CREDS = { username: "testuser@example.com", password: "pw" };
/** Uppercase hex MD5 of "pw", which is what the app sends instead of the password. */
const PW_MD5 = "8FE4C11451281C094A6578E6DDBF5EED";

interface Call {
  url: string;
  method: string;
  contentType: string | null;
  body: string;
  /** The parsed contents of the single `json` form part. */
  json: Record<string, unknown>;
}

function stubFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const body = await req.text();
    const part = body.match(/name="json"[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/);
    const call: Call = {
      url: req.url,
      method: req.method,
      contentType: req.headers.get("content-type"),
      body,
      json: part ? JSON.parse(part[1]) : {},
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const LOGIN_OK = {
  status: "ok",
  user: "370985",
  username: "testuser",
  password: PW_MD5,
  email: CREDS.username,
};

/** Answers `login` and dispatches everything else to the caller's map of replies. */
function client(replies: Record<string, unknown | ((call: Call) => unknown)>) {
  const { fetchImpl, calls } = stubFetch((call) => {
    const fn = String(call.json.function);
    if (fn === "login") return json(LOGIN_OK);
    const reply = replies[fn];
    if (reply === undefined) return json({ status: "failed" });
    return json(typeof reply === "function" ? (reply as (c: Call) => unknown)(call) : reply);
  });
  return { app: new ReceptenmakerAppClient(CREDS, { fetchImpl }), calls };
}

describe("request shape", () => {
  it("posts one multipart json part to the app endpoint", async () => {
    const { app, calls } = client({ getKookboekenUser: { status: "ok", kookboeken: "[]" } });
    await app.listCookbooks();

    expect(calls[0].url).toBe(APP_FUNCTIONS_URL);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].contentType).toContain("multipart/form-data; boundary=");
    expect(calls[0].body).toContain('Content-Disposition: form-data; name="json"');
    expect(calls[0].body).toContain("Content-Type: text/plain; charset=UTF-8");
  });

  it("sends the client identification the app sends", async () => {
    const { app, calls } = client({ getKookboekenUser: { status: "ok", kookboeken: "[]" } });
    await app.listCookbooks();

    expect(calls[0].json).toMatchObject({ os: "android", language: "nl", version: "28" });
  });

  it("authenticates with an uppercase MD5 of the password, never the password", async () => {
    const { app, calls } = client({ getKookboekenUser: { status: "ok", kookboeken: "[]" } });
    await app.listCookbooks();

    expect(calls[0].json).toMatchObject({ function: "login", password: PW_MD5 });
    for (const call of calls) expect(call.body).not.toContain(CREDS.password);
  });

  it("uses the numeric account id from login for later calls", async () => {
    const { app, calls } = client({ getKookboekenUser: { status: "ok", kookboeken: "[]" } });
    await app.listCookbooks();

    expect(calls[1].json).toMatchObject({ user: "370985", password: PW_MD5 });
  });

  it("logs in once across several calls", async () => {
    const { app, calls } = client({
      getKookboekenUser: { status: "ok", kookboeken: "[]" },
      deleteKookboek: { status: "ok" },
    });
    await app.listCookbooks();
    await app.deleteCookbook("1");

    expect(calls.filter((c) => c.json.function === "login")).toHaveLength(1);
  });

  it("escapes the characters the app escapes", async () => {
    // The app rewrites these before sending and the server reverses it; a title
    // containing a plus must travel the same way or it arrives mangled.
    const { app, calls } = client({ setKookboekTitle: { status: "ok" } });
    await app.renameCookbook("42", "Zoet + zout");

    const rename = calls.find((c) => c.json.function === "setKookboekTitle")!;
    expect(rename.body).toContain("plussign");
    expect(rename.body).not.toMatch(/Zoet \+ zout/);
  });
});

describe("authentication failures", () => {
  it("raises AuthError when the credentials are rejected", async () => {
    const { fetchImpl } = stubFetch(() => json({ status: "invalidCredentials" }));
    const app = new ReceptenmakerAppClient(CREDS, { fetchImpl });
    await expect(app.listCookbooks()).rejects.toThrow(AuthError);
  });

  it("raises AuthError when login returns no account id", async () => {
    const { fetchImpl } = stubFetch(() => json({ status: "ok" }));
    const app = new ReceptenmakerAppClient(CREDS, { fetchImpl });
    await expect(app.listCookbooks()).rejects.toThrow(AuthError);
  });

  it("reports a failed operation as an upstream error", async () => {
    const { app } = client({ deleteKookboek: { status: "failed" } });
    await expect(app.deleteCookbook("42")).rejects.toThrow(UpstreamError);
  });
});

describe("listCookbooks", () => {
  it("parses the double-encoded collection and the inverted naming", async () => {
    // The app returns collections as a JSON string inside the JSON, and puts the
    // cookbook's own name in `subtitle` while `title` holds the owner's name.
    const { app } = client({
      getKookboekenUser: {
        status: "ok",
        kookboeken: JSON.stringify([
          { type: "own", id: "72181", title: "testuser", subtitle: "bijzaken ", imageUrl: "abc" },
          { type: "own", id: "69061", title: "testuser", subtitle: "avondeten", imageUrl: "def" },
        ]),
      },
    });

    expect(await app.listCookbooks()).toEqual([
      { id: "72181", name: "bijzaken", imageKey: "abc" },
      { id: "69061", name: "avondeten", imageKey: "def" },
    ]);
  });

  it("copes with an account that has no cookbooks", async () => {
    const { app } = client({ getKookboekenUser: { status: "ok", kookboeken: "[]" } });
    expect(await app.listCookbooks()).toEqual([]);
  });
});

describe("createCookbook", () => {
  it("creates then titles, because the upstream create takes no name", async () => {
    const { app, calls } = client({
      createNewKookboek: { status: "ok", kookboekID: "85234", userId: "370985" },
      setKookboekTitle: { status: "ok" },
    });

    expect(await app.createCookbook("Weekmenu")).toEqual({ id: "85234", name: "Weekmenu" });

    const order = calls.map((c) => c.json.function);
    expect(order).toEqual(["login", "createNewKookboek", "setKookboekTitle"]);
    expect(calls[2].json).toMatchObject({ kookboekID: "85234", title: "Weekmenu" });
  });

  it("surfaces the orphaned id when titling fails, so it can be cleaned up", async () => {
    const { app } = client({
      createNewKookboek: { status: "ok", kookboekID: "85234" },
      setKookboekTitle: { status: "failed" },
    });
    await expect(app.createCookbook("Weekmenu")).rejects.toThrow(/85234/);
  });

  it("fails clearly when no id comes back", async () => {
    const { app } = client({ createNewKookboek: { status: "ok" } });
    await expect(app.createCookbook("Weekmenu")).rejects.toThrow(UpstreamError);
  });
});

describe("renameCookbook", () => {
  it("sets the title on the given cookbook", async () => {
    const { app, calls } = client({ setKookboekTitle: { status: "ok" } });
    await app.renameCookbook("72181", "Bijzaken");

    expect(calls[1].json).toMatchObject({
      function: "setKookboekTitle",
      kookboekID: "72181",
      title: "Bijzaken",
    });
  });
});

describe("deleteCookbook", () => {
  it("deletes the given cookbook", async () => {
    const { app, calls } = client({ deleteKookboek: { status: "ok" } });
    await app.deleteCookbook("85234");

    expect(calls[1].json).toMatchObject({ function: "deleteKookboek", kookboekID: "85234" });
  });
});

describe("uploadPhoto", () => {
  it("posts base64 image data against the recipe and returns the storage id", async () => {
    const { app, calls } = client({ savePhoto: { status: "ok", isSquare: "0", storageID: "up1oad1d12345" } });
    expect(await app.uploadPhoto("4166830", "/9j/4AAQ+SkZJRg==")).toBe("up1oad1d12345");

    const save = calls.find((c) => c.body.includes("savePhoto"))!;
    // Base64 contains '+', which travels escaped exactly as the app sends it.
    expect(save.body).toContain("/9j/4AAQplussignSkZJRg==");
    expect(save.body).toContain('"objectID":"4166830"');
  });

  it("reports a rejected upload as an upstream error", async () => {
    const { app } = client({ savePhoto: { status: "failed" } });
    await expect(app.uploadPhoto("4166830", "AAAA")).rejects.toThrow(UpstreamError);
  });
});
