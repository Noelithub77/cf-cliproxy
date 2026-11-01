import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const ACCOUNT = "75bb6d35925d6493575a3e2d6deac186";
const WORKER = "infer-cf";
const ORIGIN = "https://infer-cf.allpyq.in";
const [command = "help", ...flags] = process.argv.slice(2);
const apply = flags.includes("--apply");
const allowed = new Set(["--prod", "--apply"]);
if (flags.some((flag) => !allowed.has(flag))) throw new Error("Unknown flag; use pnpm ops help");
if (command !== "help" && !flags.includes("--prod")) throw new Error("Select the production endpoint with --prod");
if (apply && !["deploy", "secrets", "configure", "refresh"].includes(command)) throw new Error("This command is read-only");

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Missing required input field");
  return value.trim();
}
function input(): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(0, "utf8"));
  return record(value);
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 12); }
function auth(): string {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (token) return token;
  const value: unknown = JSON.parse(readFileSync(`${homedir()}/.config/cloudflare/config/default.json`, "utf8"));
  return text(record(value).oauth_token);
}
function wrangler(args: string[], stdin?: string): void {
  const result = spawnSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", ...args], { encoding: "utf8", input: stdin, env: { ...process.env, CLOUDFLARE_API_TOKEN: auth(), CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, stdio: ["pipe", "pipe", "pipe"] });
  if (result.status !== 0) {
    // CLI input can contain credentials; never echo it or an unbounded provider response.
    process.stderr.write(result.stderr.slice(-3000));
    throw new Error(`Wrangler ${args[0]} failed; no credential input was logged`);
  }
  if (command === "deploy") process.stderr.write(result.stdout);
}
async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(ORIGIN + path, { ...init, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Endpoint ${path.split("?")[0]} returned HTTP ${response.status}`); }
  return response;
}
async function main(): Promise<unknown> {
  if (command === "help") return { commands: ["doctor --prod", "deploy --prod [--apply]", "secrets --prod [--apply] < protected-input.json", "configure --prod [--apply] < protected-input.json", "status --prod < protected-input.json", "refresh --prod [--apply] < protected-input.json", "probe --prod < protected-input.json", "quota --prod < protected-input.json"], target: ORIGIN, note: "secrets/configure inputs are JSON on stdin only; previews never mutate. No plan upgrades or container resources." };
  if (command === "doctor") {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts`, { headers: { authorization: `Bearer ${auth()}` } });
    if (!response.ok) throw new Error(`Cloudflare authentication failed (HTTP ${response.status})`);
    const value: unknown = await response.json();
    const result = record(value).result;
    if (!Array.isArray(result)) throw new Error("Cloudflare returned an invalid script list");
    return { authenticated: true, workerExists: result.some((item: unknown) => record(item).id === WORKER) };
  }
  if (command === "deploy") { wrangler(["deploy", ...(apply ? [] : ["--dry-run"])]); return { applied: apply, worker: WORKER }; }
  const data = input();
  if (command === "secrets") {
    const secrets = record(data.secrets);
    const allowedSecrets = new Set(["MANAGEMENT_KEY", "ANTIGRAVITY_CLIENT_SECRET"]);
    if (Object.keys(secrets).some((name) => !allowedSecrets.has(name))) throw new Error("Unexpected secret name");
    for (const value of Object.values(secrets)) text(value);
    if (apply) wrangler(["secret", "bulk"], JSON.stringify(secrets));
    return { applied: apply, secretNames: Object.keys(secrets) };
  }
  const key = text(data.apiKey);
  const management = text(data.managementKey);
  if (command === "configure") {
    const authFiles = data.authFiles ?? [];
    if (!Array.isArray(authFiles)) throw new Error("authFiles must be a list");
    const names = authFiles.map((item: unknown) => text(record(item).name));
    if (names.some((name) => !/^[\w.@+-]+\.json$/.test(name))) throw new Error("Invalid auth-file name");
    for (const item of authFiles) {
      const file = record(item); const fileData = record(file.data);
      if (!["antigravity", "codex", "claude", "kimi", "kimi-ai", "vertex"].includes(text(fileData.type))) throw new Error("Unsupported auth-file provider");
    }
    if (apply) {
      const headers = { authorization: `Bearer ${management}`, "content-type": "application/json" };
      await api("/v8/management/config/access/api-keys", { method: "PUT", headers, body: JSON.stringify([key]) });
      for (const item of authFiles) {
        const file = record(item);
        await api(`/v8/management/credentials?name=${encodeURIComponent(text(file.name))}`, { method: "POST", headers, body: JSON.stringify(record(file.data)) });
      }
    }
    return { applied: apply, apiKeyHash: hash(key), managementKeyHash: hash(management), importedFiles: names.length };
  }
  if (command === "refresh") {
    if (!apply) return { applied: false, action: "refresh configured provider credentials" };
    const response = await api("/v8/management/credentials/refresh", { method: "POST", headers: { authorization: `Bearer ${management}` } });
    const value: unknown = await response.json();
    return { applied: true, refreshed: record(value).refreshed };
  }
  if (command === "status") {
    const publicModels = await fetch(ORIGIN + "/v1/models");
    const response = await api("/v1/models", { headers: { authorization: `Bearer ${key}` } });
    const value: unknown = await response.json();
    const models = record(value).data;
    const config = await api("/v8/management/config", { headers: { authorization: `Bearer ${management}` } });
    const settings: unknown = await config.json();
    const keys = record(record(settings).access).apiKeys ?? record(record(settings).access)["api-keys"];
    return { publicModelsStatus: publicModels.status, models: Array.isArray(models) ? models.map((model: unknown) => text(record(model).id)) : [], managementStatus: config.status, configuredApiKeys: Array.isArray(keys) ? keys.length : null, apiKeyHash: hash(key), managementKeyHash: hash(management) };
  }
  if (command === "quota") {
    const headers = { authorization: `Bearer ${management}`, "content-type": "application/json" };
    const listed: unknown = await (await api("/v8/management/credentials", { headers })).json();
    const files = record(listed).files;
    if (!Array.isArray(files)) throw new Error("Invalid credential listing");
    const accounts = [];
    for (const item of files.slice(0, 20)) {
      const file = record(item);
      if (file.provider !== "antigravity" || file.disabled === true) continue;
      const payload = { authIndex: text(file.auth_index), method: "POST", url: "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", header: { Authorization: "Bearer $TOKEN$" }, data: JSON.stringify({ project: text(file.project_id) }) };
      const value: unknown = await (await api("/v8/management/requests/api-call", { method: "POST", headers, body: JSON.stringify(payload) })).json();
      const response = record(value);
      if (response.status_code !== 200) throw new Error(`Google quota returned HTTP ${String(response.status_code)}`);
      const raw: unknown = JSON.parse(text(response.body));
      const groups = record(raw).groups;
      if (!Array.isArray(groups) || !groups.length) throw new Error("Google quota response has no groups");
      accounts.push({ provider: "antigravity", http: response.status_code, quotaGroups: groups.length });
    }
    if (!accounts.length) throw new Error("No Antigravity account is configured");
    return { accounts };
  }
  if (command === "probe") {
    const model = typeof data.model === "string" ? data.model : "gemini-3.5-flash-lite";
    const image = typeof data.imageDataUrl === "string" ? data.imageDataUrl : "";
    const content = image ? [{ type: "text", text: "Read the two digits in this image. Reply with only those digits." }, { type: "image_url", image_url: { url: image } }] : "Reply with exactly OK.";
    const response = await api("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content }], reasoning_effort: "low", max_tokens: 128 }) });
    const value: unknown = await response.json(); const choices = record(value).choices;
    if (!Array.isArray(choices) || !choices.length) throw new Error("No completion choice returned");
    const answer = text(record(record(choices[0]).message).content);
    if (answer !== (image ? "47" : "OK")) throw new Error("Probe output did not match the expected fixture");
    return { model, kind: image ? "vision" : "text", expectedOutputVerified: true };
  }
  throw new Error("Unknown command; use pnpm ops help");
}
main().then((summary: unknown) => console.log(JSON.stringify({ ok: true, target: "prod", endpoint: ORIGIN, summary }))).catch((error: unknown) => { console.error(JSON.stringify({ ok: false, target: "prod", error: error instanceof Error ? error.message : "Operation failed" })); process.exitCode = 1; });
