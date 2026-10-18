import { LinkError, diagnostic } from "./errors.mjs";
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
        ["id", "label", "box", "sign", "relay", "proof"].map((k) => [
          k,
          { type: "string" },
        ]),
      ),
      required: ["id", "label", "box", "sign", "relay", "proof"],
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
/** Authenticated owner API. Every failure carries a content-free trace ID. */
export async function handleMcp(request, db, ctx, options = {}) {
  const { fetcher = fetch, skillMethod } = options;
  const requestId = crypto.randomUUID();
  let rpc, stage = "mcp.request";
  const json = (value, status = 200) => Response.json(value, {status,headers:{
    "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff", "X-Request-ID":requestId,
  }});
  const result = value => json({jsonrpc:"2.0",id:rpc?.id ?? null,result:value});
  const fail = (error, status = 400, rpcCode = -32602) => {
    const detail = diagnostic(error,requestId,stage,status);
    return json({jsonrpc:"2.0",id:rpc?.id ?? null,error:{code:rpcCode,message:detail.message,data:{error:detail}}},status);
  };
  if (request.method !== "POST") return fail(new LinkError("method_not_allowed","POST required"),405);
  try {
    const reader = request.body?.getReader();
    if (!reader) return fail(new LinkError("invalid_json","JSON required"));
    const chunks = []; let length = 0;
    for (;;) {
      const {value,done} = await reader.read(); if (done) break;
      length += value.length;
      if (length > MAX_BODY) {await reader.cancel(); return fail(new LinkError("request_too_large","Request too large"),413);}
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) {bytes.set(chunk,offset);offset += chunk.length;}
    rpc = JSON.parse(new TextDecoder().decode(bytes));
  } catch { return fail(new LinkError("invalid_json","Invalid JSON"),400,-32700); }
  if (!rpc || Array.isArray(rpc) || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string")
    return fail(new LinkError("invalid_input","Invalid request"),400,-32600);
  if (rpc.method === "server/discover") return result({
    resultType:"complete",supportedVersions:["2026-07-28"],
    capabilities:{tools:{},events:{},...(skillMethod ? {extensions:{"io.modelcontextprotocol/skills":{}}} : {})},
  });
  if (skillMethod && ["skills/list","skills/get","resources/read"].includes(rpc.method)) {
    stage = "mcp.skills";
    try { return result(await skillMethod(rpc.method,rpc.params || {})); }
    catch { return fail(new LinkError("not_found","Unknown skill resource")); }
  }
  if (rpc.method === "tools/list") return result({tools});
  if (rpc.method === "events/list") return result({events:[eventDefinition]});
  stage = "mcp.auth";
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner) return fail(new LinkError("unauthenticated","Sign in with ChatGPT required"),401,-32001);
  const p = rpc.params || {};
  try {
    const service = new Service(db,{origin:new URL(request.url).origin,fetcher,requestId});
    const background = () => ctx?.waitUntil(drain(service,fetcher).catch(error => {
      diagnostic(error,requestId,"events.delivery",500);
    }));
    let answer;
    if (rpc.method === "tools/call") {
      const a = p.arguments || {};
      if (p.name === "link_account") {stage = "mcp.account"; answer = await service.account(owner);}
      else if (p.name === "link_register") {stage = "mcp.register"; answer = await service.register(owner,a);}
      else if (p.name === "link_exchange") {stage = "mcp.exchange"; answer = await service.call(owner,a.operation,a.input);}
      else throw new LinkError("invalid_operation","Unknown tool");
      background();
      return result({content:[{type:"text",text:JSON.stringify(answer)}],structuredContent:answer});
    }
    stage = "mcp.events";
    if (rpc.method === "events/subscribe") answer = await subscribe(service,owner,p,fetcher);
    else if (rpc.method === "events/unsubscribe") answer = await unsubscribe(service,owner,p);
    else return fail(new LinkError("unknown_method","Unknown method"),400,-32601);
    background();
    return result(answer);
  } catch (error) {
    if (rpc.method === "tools/call") {
      const body = {error:diagnostic(error,requestId,stage,200)};
      return result({isError:true,content:[{type:"text",text:JSON.stringify(body)}],structuredContent:body});
    }
    return fail(error,400,stage === "mcp.events" ? -32015 : -32602);
  }
}
