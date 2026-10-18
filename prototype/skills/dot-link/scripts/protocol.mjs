export const PROTOCOL = "dot-link";
export const MAX_BODY = 192 * 1024;
export const MAX_PLAINTEXT = 64 * 1024;
export const MESSAGE_TTL = 24 * 60 * 60 * 1000;
export const INVITE_TTL = 7 * MESSAGE_TTL;
export const utf8 = new TextEncoder();
export const b64 = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
export function unb64(text, length) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/.test(text))
    throw new Error("Invalid base64url");
  const bytes = Uint8Array.from(
    atob(text.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  if (b64(bytes) !== text || (length && bytes.length !== length))
    throw new Error("Invalid key or encoding");
  return bytes;
}
export const digest = async (data) =>
  b64(
    await crypto.subtle.digest(
      "SHA-256",
      typeof data === "string" ? utf8.encode(data) : data,
    ),
  );
export const encode = (value) => utf8.encode(JSON.stringify(value));
export const publicIdentity = (identity) => ({
  id: identity.id,
  label: identity.label,
  box: identity.box,
  sign: identity.sign,
});
export const identityBytes = (p) =>
  encode([PROTOCOL, "identity", p.id, p.label, p.box, p.sign]);
export const envelopeBytes = (e) =>
  encode([
    PROTOCOL,
    "message",
    e.id,
    e.from,
    e.to,
    e.created,
    e.expires,
    e.ciphertext,
  ]);
export async function verify(publicKey, bytes, signature) {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      unb64(publicKey, 32),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      unb64(signature, 64),
      bytes,
    );
  } catch {
    return false;
  }
}
export async function checkIdentity(p) {
  if (
    !p ||
    typeof p.label !== "string" ||
    !p.label.trim() ||
    p.label.length > 64
  )
    throw new Error("Invalid identity");
  unb64(p.box, 32);
  unb64(p.sign, 32);
  if (p.id !== (await digest(encode([p.box, p.sign]))))
    throw new Error("Identity does not match its keys");
}
export async function checkEnvelope(e, sender, recipient, now = Date.now()) {
  if (
    !e ||
    Object.keys(e).sort().join(",") !==
      "ciphertext,created,expires,from,id,signature,to"
  )
    throw new Error("Invalid envelope");
  unb64(e.id, 24);
  if (e.from !== sender.id || e.to !== recipient.id)
    throw new Error("Wrong peer");
  if (
    !Number.isSafeInteger(e.created) ||
    !Number.isSafeInteger(e.expires) ||
    e.created > now + 60000 ||
    e.expires <= now ||
    e.expires <= e.created ||
    e.expires - e.created > MESSAGE_TTL
  )
    throw new Error("Expired or invalid message time");
  const cipher = unb64(e.ciphertext);
  if (cipher.length < 48 || cipher.length > MAX_PLAINTEXT + 48)
    throw new Error("Invalid ciphertext size");
  if (!(await verify(sender.sign, envelopeBytes(e), e.signature)))
    throw new Error("Invalid signature");
}
