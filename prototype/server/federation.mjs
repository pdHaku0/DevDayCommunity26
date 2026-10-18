import { Service } from "./service.mjs";
import { LinkError, diagnostic } from "./errors.mjs";
import { drain } from "./events.mjs";
import { MAX_BODY } from "../skills/dot-link/scripts/protocol.mjs";
/** Public transport: Sites user headers confer no authority here. */
export async function handleFederation(request, db, ctx, { fetcher = fetch } = {}) {
  const requestId = crypto.randomUUID();
  let stage = "federation.request";
  const json = (data,status = 200) => Response.json(data,{status,headers:{
    "Cache-Control":"no-store","X-Content-Type-Options":"nosniff","X-Request-ID":requestId,
  }});
  const fail = (error,status = 400) => json({ok:false,error:diagnostic(error,requestId,stage,status)},status);
  if (request.method !== "POST") return fail(new LinkError("method_not_allowed","POST required"),405);
  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json"))
    return fail(new LinkError("unsupported_media_type","JSON required"),415);
  try {
    const reader = request.body?.getReader();
    if (!reader) return fail(new LinkError("invalid_json","JSON required"));
    const parts = []; let length = 0;
    for (;;) {
      const {value,done} = await reader.read(); if (done) break;
      length += value.length;
      if (length > MAX_BODY) {await reader.cancel();return fail(new LinkError("request_too_large","Request too large"),413);}
      parts.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const part of parts) {bytes.set(part,offset);offset += part.length;}
    let packet;
    try {packet = JSON.parse(new TextDecoder().decode(bytes));}
    catch {return fail(new LinkError("invalid_json","Invalid JSON"));}
    stage = "federation.receive";
    const service = new Service(db,{origin:new URL(request.url).origin,fetcher,requestId});
    const result = await service.receive(packet);
    ctx?.waitUntil(drain(service,fetcher).catch(error => {diagnostic(error,requestId,"events.delivery",500);}));
    return json({ok:true,...result});
  } catch (error) {
    return fail(error,error instanceof LinkError || /^(Invalid|Wrong|Expired|Identity|Message|Cannot connect)/.test(error?.message || "") ? 400 : 500);
  }
}
