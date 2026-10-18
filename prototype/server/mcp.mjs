import { Service, operations } from "./service.mjs";
import { eventDefinition, subscribe, unsubscribe, drain } from "./events.mjs";
import { MAX_BODY } from "../skills/dot-link/scripts/protocol.mjs";
const object = { type: "object", properties: {}, additionalProperties: false };
const tools = [
  {
    name: "link_account",
    description:
      "Read this authenticated account's registered Dot Link endpoints. Never returns private keys or email.",
    inputSchema: object,
    annotations: { readOnlyHint: true },
  },
  {
    name: "link_register",
    description:
      "Register a client-generated public identity for this signed-in user. Pass the output of the dot-link client init command; never pass private keys.",
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        ["id", "label", "box", "sign", "proof"].map((k) => [
          k,
          { type: "string" },
        ]),
      ),
      required: ["id", "label", "box", "sign", "proof"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: "link_exchange",
    description:
      "Execute a Dot Link client request. Use the dot-link skill and pass the client's operation and input unchanged. Send only signed ciphertext, never message plaintext. sync returns ciphertext to verify/decrypt locally; ack means durable endpoint receipt, not that a human has read it.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: operations },
        input: { type: "object" },
      },
      required: ["operation", "input"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
];
const json = (value, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
function safeError(e) {
  if (e.code) return { code: e.code, message: e.message };
  if (e.name === "ZodError")
    return {
      code: "invalid_input",
      message: "Arguments do not match the operation schema",
    };
  if (/^(Invalid|Wrong|Expired|Identity|Message)/.test(e.message || ""))
    return { code: "invalid_input", message: e.message };
  return { code: "internal_error", message: "Request failed" };
}
/**
 * @param {Request} request
 * @param {any} db
 * @param {{waitUntil: (promise: Promise<unknown>) => void} | undefined} ctx
 * @param {{fetcher?: typeof fetch, skillMethod?: (method: string, params: any) => Promise<any>}} options
 */
export async function handleMcp(request, db, ctx, options = {}) {
  const { fetcher = fetch, skillMethod } = options;
  if (request.method !== "POST") return json({ error: "POST required" }, 405);
  let rpc;
  try {
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "JSON required" }, 400);
    const chunks = [];
    let n = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > MAX_BODY) {
        await reader.cancel();
        return json({ error: "Request too large" }, 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(n);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    rpc = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Invalid JSON" },
      },
      400,
    );
  }
  if (
    !rpc ||
    Array.isArray(rpc) ||
    rpc.jsonrpc !== "2.0" ||
    typeof rpc.method !== "string"
  )
    return json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid request" },
      },
      400,
    );
  const result = (value) =>
    json({ jsonrpc: "2.0", id: rpc.id ?? null, result: value });
  if (rpc.method === "server/discover")
    return result({
      resultType: "complete",
      supportedVersions: ["2026-07-28"],
      capabilities: {
        tools: {},
        events: {},
        ...(skillMethod
          ? { extensions: { "io.modelcontextprotocol/skills": {} } }
          : {}),
      },
    });
  if (
    skillMethod &&
    ["skills/list", "skills/get", "resources/read"].includes(rpc.method)
  ) {
    try {
      return result(await skillMethod(rpc.method, rpc.params || {}));
    } catch {
      return json({
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        error: { code: -32602, message: "Unknown skill resource" },
      });
    }
  }
  if (rpc.method === "tools/list") return result({ tools });
  if (rpc.method === "events/list")
    return result({ events: [eventDefinition] });
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner)
    return json(
      {
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        error: { code: -32001, message: "Sign in with ChatGPT required" },
      },
      401,
    );
  const service = new Service(db),
    p = rpc.params || {};
  try {
    let answer;
    if (rpc.method === "tools/call") {
      const a = p.arguments || {};
      if (p.name === "link_account") answer = await service.account(owner);
      else if (p.name === "link_register")
        answer = await service.register(owner, a);
      else if (p.name === "link_exchange")
        answer = await service.call(owner, a.operation, a.input);
      else
        return json({
          jsonrpc: "2.0",
          id: rpc.id ?? null,
          error: { code: -32602, message: "Unknown tool" },
        });
      ctx?.waitUntil(drain(service, fetcher).catch(() => {}));
      return result({
        content: [{ type: "text", text: JSON.stringify(answer) }],
        structuredContent: answer,
      });
    }
    if (rpc.method === "events/subscribe")
      answer = await subscribe(service, owner, p, fetcher);
    else if (rpc.method === "events/unsubscribe")
      answer = await unsubscribe(service, owner, p);
    else
      return json({
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        error: { code: -32601, message: "Unknown method" },
      });
    ctx?.waitUntil(drain(service, fetcher).catch(() => {}));
    return result(answer);
  } catch (e) {
    const err = safeError(e);
    if (rpc.method === "tools/call")
      return result({
        isError: true,
        content: [{ type: "text", text: JSON.stringify(err) }],
      });
    return json({
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      error: {
        code: err.code === "callback_failed" ? -32015 : -32602,
        message: err.message,
        data: { reason: err.code },
      },
    });
  }
}
