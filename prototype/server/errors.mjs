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
const errorClasses = new Set([
  "LinkError", "Error", "TypeError", "SyntaxError", "ZodError", "DOMException",
  "TimeoutError", "AbortError", "AggregateError", "ConnectTimeoutError",
  "HeadersTimeoutError", "BodyTimeoutError", "SocketError",
]);
const transportCodes = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT",
  "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET", "UND_ERR_ABORTED", "UND_ERR_PRX_TLS",
]);
// Exact, documented runtime fingerprints. These describe the observed error,
// never an inferred root cause. Do not expand this into raw message logging.
// https://developers.cloudflare.com/workers/observability/errors/#runtime-errors
const platformMessages = new Map([
  ["Network connection lost", "network_connection_lost"],
  ["Network connection lost.", "network_connection_lost"],
  ["daemonDown", "daemon_down"],
  ["Illegal invocation", "illegal_invocation"],
  ["Illegal invocation: function called with incorrect this reference", "illegal_invocation"],
  ["Illegal invocation: function called with incorrect this reference.", "illegal_invocation"],
  ["Illegal invocation: function called with incorrect `this` reference. See https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors for details.", "illegal_invocation"],
]);
const platformClassifiers = new Set(platformMessages.values());
function safeTransportMeta(meta) {
  const safe = {};
  for (const key of ["source_error_class", "cause_error_class"])
    if (errorClasses.has(meta[key])) safe[key] = meta[key];
  for (const key of ["source_error_code", "cause_code"])
    if (transportCodes.has(meta[key])) safe[key] = meta[key];
  if (platformClassifiers.has(meta.platform_classifier)) safe.platform_classifier = meta.platform_classifier;
  return safe;
}
function transportMeta(error) {
  const meta = {};
  if (errorClasses.has(error?.name)) meta.source_error_class = error.name;
  if (transportCodes.has(error?.code)) meta.source_error_code = error.code;
  const seen = new Set(), pending = [error];
  // Bounded traversal also handles Node fetch's AggregateError without exposing
  // its messages, socket details, addresses, or stack.
  for (let n = 0; pending.length && n < 6; n++) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (current !== error) {
      if (!meta.cause_error_class && errorClasses.has(current.name)) meta.cause_error_class = current.name;
      if (!meta.cause_code && transportCodes.has(current.code)) meta.cause_code = current.code;
    }
    if (!meta.platform_classifier && platformMessages.has(current.message))
      meta.platform_classifier = platformMessages.get(current.message);
    if (current.cause) pending.push(current.cause);
    if (current.name === "AggregateError" && Array.isArray(current.errors)) pending.push(...current.errors.slice(0,3));
  }
  return meta;
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
  const observed = safeTransportMeta(meta);
  Object.assign(detail, observed);
  const errorClass = errorClasses.has(error?.name) ? error.name : "Error";
  console.warn(JSON.stringify({ request_id: requestId, stage: detail.stage, code: detail.code, status, error_class: errorClass, ...observed }));
  return detail;
}
export function transportFailure(error, stage, prefix, signal) {
  if (error instanceof LinkError) return error;
  const observed = transportMeta(error);
  const timeoutCodes = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
  const timeout = error?.name === "TimeoutError" || signal?.aborted ||
    timeoutCodes.has(observed.source_error_code) || timeoutCodes.has(observed.cause_code);
  return new LinkError(`${prefix}_${timeout ? "timeout" : "network"}`,
    prefix === "delivery" ? "Delivery was not confirmed; keep the original packet for retry" : "Event callback request did not complete",
    {stage, retryable:true, ...observed});
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
