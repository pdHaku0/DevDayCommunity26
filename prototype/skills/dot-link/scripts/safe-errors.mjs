// Only errors constructed here with static messages may expose a human-readable detail.
export class ClientError extends Error {
  constructor(message, code = "CLIENT_REJECTED", retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}
const transientOs = new Set(["EAGAIN", "EBUSY", "EINTR", "ETIMEDOUT"]);
const knownOs = new Set([...transientOs, "EACCES", "EPERM", "ENOENT", "EEXIST", "ENOSPC", "EIO", "EROFS"]);
export function safeError(error, stage, requestId = crypto.randomUUID()) {
  let code = "CLIENT_FAILED", message = "Client operation failed", retryable = false;
  if (error instanceof ClientError) {
    code = error.code;
    message = error.message;
    retryable = error.retryable;
  } else if (error instanceof SyntaxError) {
    code = "INVALID_DATA";
    message = "Invalid JSON data";
  } else if (knownOs.has(error?.code)) {
    code = error.code;
    message = "Local storage operation failed";
    retryable = transientOs.has(code);
  }
  return { error: message, code, stage, request_id: requestId, retryable };
}
