import type { Account } from "./account.ts";
import { USER_AGENT } from "./antigravity-auth.ts";
import { isObject, text } from "./claude-responses.ts";

const HOSTS = new Set(["daily-cloudcode-pa.googleapis.com", "daily-cloudcode-pa.sandbox.googleapis.com", "cloudcode-pa.googleapis.com"]);
const PATHS = new Set(["/v1internal:retrieveUserQuotaSummary", "/v1internal:fetchAvailableModels", "/v1internal:loadCodeAssist"]);

// The official manager uses CPA's API-call contract for quota and subscription reads.
// Restrict token-bearing requests to those Google endpoints rather than an arbitrary URL.
export async function managementRequest(request: Request, account: Account): Promise<Response> {
  const payload: unknown = await request.json().catch(() => null);
  if (!isObject(payload) || text(payload.method).toUpperCase() !== "POST") return Response.json({ error: "invalid quota request" }, { status: 400 });
  let url: URL;
  try { url = new URL(text(payload.url)); } catch { return Response.json({ error: "invalid upstream URL" }, { status: 400 }); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || !HOSTS.has(url.hostname) || !PATHS.has(url.pathname)) {
    return Response.json({ error: "unsupported quota endpoint" }, { status: 400 });
  }
  const name = text(payload.authIndex) || text(payload.auth_index) || text(payload.AuthIndex);
  const file = account.vault.credentialFile(name);
  if (!file || file.provider !== "antigravity" || file.disabled) return Response.json({ error: "Antigravity credential is unavailable" }, { status: 400 });
  const login = await account.tokenFor(file);
  if (!login.ok) return Response.json({ error: login.message }, { status: login.status });
  const data = text(payload.data);
  if (data.length > 8192) return Response.json({ error: "quota request is too large" }, { status: 400 });
  let body: unknown;
  try { body = JSON.parse(data || "{}"); } catch { return Response.json({ error: "invalid quota request JSON" }, { status: 400 }); }
  if (!isObject(body)) return Response.json({ error: "quota request must be an object" }, { status: 400 });
  try {
    const upstream = await account.fetcher(new Request(url, { method: "POST", redirect: "manual", headers: { authorization: `Bearer ${login.accessToken}`, "content-type": "application/json", "user-agent": USER_AGENT }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) }));
    const headers: Record<string, string[]> = {};
    for (const name of ["date", "content-type", "retry-after"]) {
      const value = upstream.headers.get(name);
      if (value !== null) headers[name] = [value];
    }
    return Response.json({ status_code: upstream.status, header: headers, body: await upstream.text() }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Google quota service could not be reached" }, { status: 502 });
  }
}
