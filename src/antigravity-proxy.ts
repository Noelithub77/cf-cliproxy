import { API_BASE, USER_AGENT } from "./antigravity-auth.ts";
import { isObject, type Json } from "./claude-responses.ts";

// Only Gemini models are exposed until Claude's signature replay is ported and tested.
export const MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash-high"] as const;

export function antigravityRequest(model: string, body: string, headers: Headers, action: string): Request {
  const project = headers.get("x-antigravity-project") ?? "";
  if (!project) throw new Error("Antigravity login has no project");
  const value: unknown = JSON.parse(body);
  if (!isObject(value)) throw new Error("Antigravity request must be a JSON object");
  const request: Json = { ...value };
  request.sessionId ??= `-${(crypto.getRandomValues(new BigUint64Array(1))[0] ?? 0n) & ((1n << 63n) - 1n)}`;
  headers.delete("x-antigravity-project");
  headers.delete("x-goog-api-key");
  headers.set("user-agent", USER_AGENT);
  headers.set("content-type", "application/json");
  const stream = action === "streamGenerateContent";
  return new Request(`${API_BASE}/v1internal:${action}${stream ? "?alt=sse" : ""}`, { method: "POST", headers, body: JSON.stringify({ model, project, userAgent: "antigravity", requestType: "agent", requestId: `agent-${crypto.randomUUID()}`, request }) });
}

function unwrapped(value: unknown): unknown {
  if (!isObject(value) || !isObject(value.response)) throw new Error("Antigravity returned an invalid response envelope");
  return value.response;
}

export async function antigravityResponse(response: Response): Promise<Response> {
  if (!response.ok) return response;
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    if (!response.body) throw new Error("Antigravity returned an empty stream");
    let pending = "";
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const line = (value: string): string => {
      if (!value.startsWith("data:")) return value;
      const data = value.slice(5).trim();
      if (!data || data === "[DONE]") return value;
      const parsed: unknown = JSON.parse(data);
      return `data: ${JSON.stringify(unwrapped(parsed))}`;
    };
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        if (pending.length > 8 * 1024 * 1024) throw new Error("Antigravity stream event is too large");
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          controller.enqueue(encoder.encode(line(pending.slice(0, newline).replace(/\r$/, "")) + "\n"));
          pending = pending.slice(newline + 1);
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending) controller.enqueue(encoder.encode(line(pending)));
      },
    }));
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(body, { status: response.status, headers });
  }
  const value: unknown = await response.json();
  const result = unwrapped(value);
  return Response.json(result, { headers: { "cache-control": "no-store" } });
}

export function structuredOutput(client: Json, claude: Json): void {
  if (!isObject(client.response_format)) return;
  const format = client.response_format;
  if (format.type === "json_object") claude.gateway_json_format = { responseMimeType: "application/json" };
  if (format.type === "json_schema" && isObject(format.json_schema) && isObject(format.json_schema.schema)) {
    claude.gateway_json_format = { responseMimeType: "application/json", responseJsonSchema: format.json_schema.schema };
  }
}
