import { Service, LinkError } from "./service.mjs";
import { drain } from "./events.mjs";
import { MAX_BODY } from "../skills/dot-link/scripts/protocol.mjs";
const json = (data, status = 200) => Response.json(data, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});
/** Public transport: Sites user headers confer no authority here. */
export async function handleFederation(request, db, ctx, { fetcher = fetch } = {}) {
  if (request.method !== "POST") return json({ok:false,error:"POST required"},405);
  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json"))
    return json({ok:false,error:"JSON required"},415);
  try {
    const reader = request.body?.getReader();
    if (!reader) return json({ok:false,error:"JSON required"},400);
    const parts = []; let length = 0;
    for (;;) {
      const {value,done} = await reader.read(); if (done) break;
      length += value.length;
      if (length > MAX_BODY) { await reader.cancel(); return json({ok:false,error:"Request too large"},413); }
      parts.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const part of parts) { bytes.set(part,offset); offset += part.length; }
    const packet = JSON.parse(new TextDecoder().decode(bytes));
    const service = new Service(db, {origin:new URL(request.url).origin,fetcher});
    const result = await service.receive(packet);
    ctx?.waitUntil(drain(service,fetcher).catch(() => {}));
    return json({ok:true,...result});
  } catch (error) {
    if (error instanceof LinkError) return json({ok:false,error:error.code},400);
    return json({ok:false,error:"Invalid federation packet"},400);
  }
}
