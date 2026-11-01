import { describe, expect, it } from "vitest";
import { Account } from "../src/account.ts";
import { API_BASE, CLIENT_ID, REDIRECT_URI, TOKEN_URL, authorizeUrl, fileData, refresh } from "../src/antigravity-auth.ts";
import { antigravityResponse } from "../src/antigravity-proxy.ts";
import { EdgeCache, handle } from "../src/app.ts";
import { Config } from "../src/config.ts";
import { handleManagement } from "../src/management.ts";
import { Vault } from "../src/vault.ts";
import { memorySql } from "./sqlite.ts";
import type { Fetcher } from "../src/claude-oauth.ts";

const NOW = 1_800_000_000;
const OPTIONS = { clientSecret: "public-desktop-client-secret-fixture" };
const LOGIN = { accessToken: "google-access-fixture", refreshToken: "google-refresh-fixture", expiresAt: NOW + 3600, projectId: "project-fixture", email: "test@example.com" };
const KEY = "inference-key-fixture";
const MANAGEMENT = "management-key-fixture-long-enough";
function setup(fetcher: Fetcher) {
  const sql = memorySql();
  const vault = new Vault(sql);
  const account = new Account(vault, fetcher, () => NOW, OPTIONS);
  const config = new Config(vault.configText());
  config.replace(["access", "api-keys"], [KEY]);
  account.saveConfig(config);
  const app = { backend: { ...account, keyValid: (hash: string) => account.keyValid(hash), token: (name?: string) => account.token(name), codexToken: (name?: string) => account.codexToken(name), loginToken: (provider: Parameters<Account["loginToken"]>[0], name?: string) => account.loginToken(provider, name), invalidate: (token: string) => account.invalidate(token), attemptAllowed: (client: string) => account.attemptAllowed(client), manage: (request: Request) => handleManagement(request, account), routing: () => account.routing(), record: (records: Parameters<Account["record"]>[0]) => account.record(records), cool: (events: Parameters<Account["cool"]>[0]) => account.cool(events) }, dashboardPassword: "", managementKey: MANAGEMENT, nowSeconds: () => NOW, upstream: fetcher, panel: async () => new Response("<html>manager</html>"), cache: new EdgeCache(), usageFlushMs: 0 };
  const request = (path: string, init: RequestInit = {}) => handle(new Request(`https://gateway.example${path}`, init), app);
  return { account, vault, sql, request };
}
function answer(text = '{"digits":"47"}') {
  return { response: { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } } };
}

describe("Antigravity OAuth", () => {
  it("uses Google's registered localhost redirect and binds a random state", () => {
    const url = new URL(authorizeUrl("state-fixture"));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("state")).toBe("state-fixture");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.has("client_secret")).toBe(false);
  });
  it("finishes an authorization code flow and preserves the project across restart", async () => {
    const { account, vault, sql } = setup(async (req) => {
      if (req.url === TOKEN_URL) return Response.json({ access_token: LOGIN.accessToken, refresh_token: LOGIN.refreshToken, expires_in: 3600 });
      if (req.url.includes("userinfo")) return Response.json({ email: LOGIN.email });
      expect(req.url).toBe(`${API_BASE}/v1internal:loadCodeAssist`);
      return Response.json({ cloudaicompanionProject: { id: LOGIN.projectId } });
    });
    const started = await account.startLogin("antigravity");
    await account.finishLogin(started.state, "code-fixture", "");
    expect(account.session(started.state)?.status).toBe("ok");
    expect(vault.credentialFiles()[0]?.data).toMatchObject({ type: "antigravity", project_id: LOGIN.projectId });
    const restarted = new Account(new Vault(sql), async () => { throw new Error("fresh tokens must not refresh"); }, () => NOW, OPTIONS);
    expect(await restarted.loginToken("antigravity")).toMatchObject({ ok: true, accessToken: LOGIN.accessToken, headers: { "x-antigravity-project": LOGIN.projectId } });
  });
  it("coalesces concurrent refreshes, keeps an unrotated refresh token and persists replacement access", async () => {
    let calls = 0;
    const { account, vault } = setup(async (req) => {
      expect(req.url).toBe(TOKEN_URL);
      const form = new URLSearchParams(await req.text());
      expect(form.get("refresh_token")).toBe(LOGIN.refreshToken);
      expect(form.get("client_secret")).toBe(OPTIONS.clientSecret);
      calls++;
      return Response.json({ access_token: "replacement-access", expires_in: 3600 });
    });
    vault.saveCredentialFile("antigravity-fixture.json", "antigravity", fileData({ ...LOGIN, expiresAt: NOW - 1 }), NOW);
    const results = await Promise.all([account.loginToken("antigravity"), account.loginToken("antigravity")]);
    expect(calls).toBe(1);
    expect(results.every((result) => result.ok && result.accessToken === "replacement-access")).toBe(true);
    expect(vault.credentialFile("antigravity-fixture.json")?.data).toMatchObject({ access_token: "replacement-access", refresh_token: LOGIN.refreshToken });
  });
  it("does not expose provider error bodies or attempt disabled credentials", async () => {
    await expect(refresh(async () => new Response("sensitive-provider-body", { status: 400 }), LOGIN, OPTIONS, NOW)).rejects.toThrow("HTTP 400");
    const { account, vault } = setup(async () => { throw new Error("disabled login used"); });
    vault.saveCredentialFile("antigravity-fixture.json", "antigravity", fileData(LOGIN), NOW);
    vault.setCredentialStatus("antigravity-fixture.json", true, "", NOW);
    expect(await account.loginToken("antigravity")).toMatchObject({ ok: false, status: 503 });
  });
});

describe("Antigravity request boundary", () => {
  it("preserves images and strict JSON schema through OpenAI translation", async () => {
    const { request, vault } = setup(async (req) => {
      expect(req.url).toBe(`${API_BASE}/v1internal:generateContent`);
      expect(req.headers.get("authorization")).toBe(`Bearer ${LOGIN.accessToken}`);
      expect(req.headers.has("x-antigravity-project")).toBe(false);
      expect(req.headers.has("cookie")).toBe(false);
      const body = await req.json() as { model: string; project: string; request: { contents: unknown[]; generationConfig: Record<string, unknown> } };
      expect(body.project).toBe(LOGIN.projectId);
      expect(body.model).toBe("gemini-3.5-flash-lite");
      expect(JSON.stringify(body.request.contents)).toContain("image/png");
      expect(body.request.generationConfig).toMatchObject({ responseMimeType: "application/json", responseJsonSchema: { type: "object", required: ["digits"] } });
      return Response.json(answer());
    });
    vault.saveCredentialFile("antigravity-fixture.json", "antigravity", fileData(LOGIN), NOW);
    const response = await request("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ model: "gemini-3.5-flash-lite", reasoning_effort: "low", messages: [{ role: "user", content: [{ type: "text", text: "Read digits" }, { type: "image_url", image_url: { url: "data:image/png;base64,cG5n" } }] }], response_format: { type: "json_schema", json_schema: { name: "digits", strict: true, schema: { type: "object", required: ["digits"], properties: { digits: { type: "string" } }, additionalProperties: false } } } }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: '{"digits":"47"}' }, finish_reason: "stop" }] });
  });
  it("unwraps split SSE frames without swallowing malformed envelopes", async () => {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(answer("hello"))}\r\n\r\ndata: [DONE]\n\n`);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice(0, 30)); controller.enqueue(bytes.slice(30)); controller.close(); } });
    const response = await antigravityResponse(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const output = await response.text();
    expect(output).toContain('"candidates"');
    expect(output).not.toContain('"response":');
    expect(output).toContain("[DONE]");
    await expect(antigravityResponse(Response.json({ unexpected: true }))).rejects.toThrow("invalid response envelope");
  });
  it("keeps provider failures explicit and lists only supported Gemini models", async () => {
    const failure = new Response("quota", { status: 429 });
    expect(await antigravityResponse(failure)).toBe(failure);
    const { request, vault } = setup(async () => Response.json(answer()));
    vault.saveCredentialFile("antigravity-fixture.json", "antigravity", fileData(LOGIN), NOW);
    const response = await request("/v1/models", { headers: { authorization: `Bearer ${KEY}` } });
    const body = await response.json() as { data: { id: string }[] };
    expect(body.data.map((model) => model.id)).toContain("gemini-3.5-flash-lite");
    expect(body.data.some((model) => model.id.startsWith("claude-"))).toBe(false);
  });
  it("uses the same single management key without exposing management data anonymously", async () => {
    const { request } = setup(async () => new Response("unused"));
    expect((await request("/")).headers.get("location")).toBe("/management.html");
    expect((await request("/management.html")).status).toBe(200);
    expect((await request("/v8/management/config")).status).toBe(401);
    expect((await request("/v8/management/config", { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(401);
    expect((await request("/v8/management/config", { headers: { authorization: `Bearer ${MANAGEMENT}` } })).status).toBe(200);
  });
});
