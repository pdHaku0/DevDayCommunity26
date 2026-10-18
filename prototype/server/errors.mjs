const codes = new Set([
  "forbidden", "wrong_relay", "invalid_proof", "limit", "invalid_input", "conflict",
  "closed", "not_connected", "not_found", "consumed", "invalid_operation",
  "invalid_subscription", "callback_rejected", "invalid_secret", "invalid_ttl",
  "method_not_allowed", "unsupported_media_type", "request_too_large", "invalid_json",
  "unauthenticated", "unknown_method", "internal_error",
  "delivery_timeout", "delivery_network", "delivery_redirect", "delivery_http_error",
  "delivery_rate_limited", "delivery_remote_unavailable", "delivery_invalid_response",
  "delivery_response_too_large", "delivery_remote_rejected",
  "callback_timeout", "callback_network", "callback_redirect", "callback_http_error",
  "callback_no_echo", "callback_invalid_response", "callback_response_too_large",
]);
const stages = new Set(["mcp.request", "mcp.auth", "mcp.account", "mcp.register", "mcp.unregister", "mcp.updates", "mcp.exchange",
  "mcp.events", "mcp.skills", "federation.request", "federation.receive", "federation.transport",
  "events.verify", "events.delivery", "updates.request", "updates.transport", "updates.delivery"]);
export class LinkError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = "LinkError";
    this.code = code;
    this.meta = meta;
  }
}
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function remoteMetadata(body, status) {
  const result = { remote_status: status };
  if (codes.has(body?.error?.code)) result.remote_code = body.error.code;
  if (uuid(body?.error?.request_id)) result.remote_request_id = body.error.request_id;
  return result;
}
export function diagnostic(error, requestId, stage, status = 500) {
  const known = error instanceof LinkError && codes.has(error.code);
  const invalid = error?.name === "ZodError" || /^(Invalid|Wrong|Expired|Identity|Message|Cannot connect|Noncanonical|Expected Sites)/.test(error?.message || "");
  const meta = known ? error.meta : {};
  const detail = {
    code: known ? error.code : invalid ? "invalid_input" : "internal_error",
    message: known ? error.message : invalid ? "Request arguments or signatures are invalid" : "Request failed",
    stage: stages.has(meta.stage) ? meta.stage : stage,
    retryable: typeof meta.retryable === "boolean" ? meta.retryable : known ? error.code === "limit" : !invalid,
    request_id: requestId,
  };
  if (Number.isInteger(meta.remote_status) && meta.remote_status >= 100 && meta.remote_status <= 599) detail.remote_status = meta.remote_status;
  if (codes.has(meta.remote_code)) detail.remote_code = meta.remote_code;
  if (uuid(meta.remote_request_id)) detail.remote_request_id = meta.remote_request_id;
  const errorClass = ["LinkError", "Error", "TypeError", "SyntaxError", "ZodError", "TimeoutError", "AbortError"].includes(error?.name) ? error.name : "Error";
  console.warn(JSON.stringify({ request_id: requestId, stage: detail.stage, code: detail.code, status, error_class: errorClass }));
  return detail;
}
export function transportFailure(error, stage, prefix, signal) {
  if (error instanceof LinkError) return error;
  const timeout = error?.name === "TimeoutError" || signal?.aborted;
  return new LinkError(`${prefix}_${timeout ? "timeout" : "network"}`,
    prefix === "delivery" ? "Delivery was not confirmed; keep the original packet for retry" : "Event callback request did not complete",
    {stage, retryable:true});
}
export async function responseJson(response, {stage, prefix, maxBytes = 8192}) {
  const reader = response.body?.getReader();
  if (!reader) throw new LinkError(`${prefix}_invalid_response`, "Response did not contain valid JSON", {stage,retryable:true,remote_status:response.status});
  const parts = []; let length = 0;
  for (;;) {
    const {value,done} = await reader.read(); if (done) break;
    length += value.length;
    if (length > maxBytes) {
      await reader.cancel();
      throw new LinkError(`${prefix}_response_too_large`, "Response exceeded the allowed size", {stage,retryable:true,remote_status:response.status});
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) {bytes.set(part,offset);offset += part.length;}
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new LinkError(`${prefix}_invalid_response`, "Response did not contain valid JSON", {stage,retryable:true,remote_status:response.status}); }
}
