import { OAuthError, type Fetcher } from "./claude-oauth.ts";
import { isObject, text } from "./claude-responses.ts";

// Public desktop OAuth client and protocol from CLIProxyAPI's Antigravity adapter.
// Its client secret is supplied through the Worker secret binding.
export const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const API_BASE = "https://daily-cloudcode-pa.googleapis.com";
export const REDIRECT_URI = "http://localhost:51121/oauth-callback";
export const USER_AGENT = "antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)";
const SCOPES = ["cloud-platform", "userinfo.email", "userinfo.profile", "cclog", "experimentsandconfigs"].map((scope) => `https://www.googleapis.com/auth/${scope}`).join(" ");

export interface AntigravityOptions {
  readonly clientSecret: string;
}

export interface AntigravityLogin {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly email: string;
  readonly projectId: string;
}

export function authorizeUrl(state: string): string {
  return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", access_type: "offline", prompt: "consent", scope: SCOPES, state })}`;
}

export function loginOf(data: Record<string, unknown>): AntigravityLogin | null {
  const accessToken = text(data.access_token);
  const refreshToken = text(data.refresh_token);
  const expiresAt = typeof data.expired === "string" ? Date.parse(data.expired) / 1000 : 0;
  if (accessToken === "" && refreshToken === "") return null;
  return { accessToken, refreshToken, expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0, email: text(data.email), projectId: text(data.project_id) };
}

export function fileData(login: AntigravityLogin): Record<string, unknown> {
  return { type: "antigravity", access_token: login.accessToken, refresh_token: login.refreshToken, expired: new Date(login.expiresAt * 1000).toISOString(), email: login.email, project_id: login.projectId };
}

async function jsonResponse(response: Response, operation: string): Promise<Record<string, unknown>> {
  // Provider error bodies can contain credentials; expose only the operation and status.
  if (!response.ok) {
    await response.body?.cancel();
    throw new OAuthError(`Google ${operation} failed (HTTP ${response.status})`, response.status);
  }
  const value: unknown = await response.json();
  if (!isObject(value)) throw new OAuthError(`Google ${operation} returned invalid JSON`, 502);
  return value;
}

async function token(fetcher: Fetcher, fields: Record<string, string>, options: AntigravityOptions, now: number, previous?: AntigravityLogin): Promise<AntigravityLogin> {
  if (options.clientSecret === "") throw new OAuthError("Antigravity OAuth client secret is not configured", 503);
  const response = await fetcher(new Request(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...fields, client_id: CLIENT_ID, client_secret: options.clientSecret }), signal: AbortSignal.timeout(30_000) }));
  const data = await jsonResponse(response, "token exchange");
  const accessToken = text(data.access_token);
  const refreshToken = text(data.refresh_token) || previous?.refreshToken || "";
  const seconds = Number(data.expires_in);
  if (!accessToken || !refreshToken || !Number.isFinite(seconds) || seconds <= 0) throw new OAuthError("Google token response has no usable tokens or expiry", 502);
  return { accessToken, refreshToken, expiresAt: now + seconds, email: previous?.email ?? "", projectId: previous?.projectId ?? "" };
}

export async function projectId(fetcher: Fetcher, accessToken: string): Promise<string> {
  const response = await fetcher(new Request(`${API_BASE}/v1internal:loadCodeAssist`, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "user-agent": USER_AGENT }, body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }), signal: AbortSignal.timeout(30_000) }));
  const data = await jsonResponse(response, "project discovery");
  const project = data.cloudaicompanionProject;
  const id = typeof project === "string" ? project : isObject(project) ? text(project.id) : "";
  if (!id) throw new OAuthError("No Antigravity project is available; finish provider onboarding or import an existing CLIProxyAPI auth file", 400);
  return id;
}

export async function exchangeCode(fetcher: Fetcher, code: string, options: AntigravityOptions, now: number): Promise<AntigravityLogin> {
  const login = await token(fetcher, { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }, options, now);
  const user = await jsonResponse(await fetcher(new Request("https://www.googleapis.com/oauth2/v2/userinfo?alt=json", { headers: { authorization: `Bearer ${login.accessToken}` }, signal: AbortSignal.timeout(30_000) })), "userinfo");
  return { ...login, email: text(user.email), projectId: await projectId(fetcher, login.accessToken) };
}

export async function refresh(fetcher: Fetcher, previous: AntigravityLogin, options: AntigravityOptions, now: number): Promise<AntigravityLogin> {
  const next = await token(fetcher, { grant_type: "refresh_token", refresh_token: previous.refreshToken }, options, now, previous);
  return next.projectId ? next : { ...next, projectId: await projectId(fetcher, next.accessToken) };
}
