export const PROTOCOL = "dot-link-federated";
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
  relay: identity.relay,
});
export const identityBytes = (p) =>
  encode([PROTOCOL, "identity", p.id, p.label, p.box, p.sign, p.relay]);
export const inviteBytes = (t) =>
  encode([
    PROTOCOL,
    "invite",
    t.relay,
    t.id,
    t.secret,
    t.expires,
    publicIdentity(t.peer),
  ]);
export function validateRelay(value) {
  if (typeof value !== "string") throw new Error("Expected own Sites HTTPS origin");
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.port ||
      u.pathname !== "/" || u.search || u.hash ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.chatgpt\.site$/.test(u.hostname))
    throw new Error("Expected Sites HTTPS origin");
  return u.origin;
}
function exact(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== fields.split(",").sort().join(","))
    throw new Error("Invalid object fields");
}
export async function readInvitation(url, now = Date.now()) {
  if (!Number.isSafeInteger(now)) throw new Error("Invalid current time");
  const u = new URL(url);
  const relay = validateRelay(u.origin);
  if (u.username || u.password || u.search || u.pathname !== "/connect" || u.hash.length > 8192)
    throw new Error("Invalid invitation URL");
  const t = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(unb64(u.hash.slice(1))));
  exact(t, "relay,id,secret,expires,peer,signature");
  exact(t.peer, "id,label,box,sign,relay");
  await checkIdentity(t.peer);
  unb64(t.secret, 32);
  if (t.relay !== relay || t.peer.relay !== relay ||
      !Number.isSafeInteger(t.expires) || t.expires <= now ||
      t.expires > now + INVITE_TTL + 60000 ||
      (await digest(t.secret)) !== t.id ||
      !(await verify(t.peer.sign, inviteBytes(t), t.signature)))
    throw new Error("Invalid or expired invitation");
  return t;
}
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
  if (validateRelay(p.relay) !== p.relay) throw new Error("Noncanonical relay origin");
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

function normalizedBody(kind, body) {
  switch (kind) {
    case "accept": return { invite_id: body.invite_id, receipt: normalizedEnvelope(body.receipt) };
    case "confirm": return { invite_id: body.invite_id };
    case "message": return { connection_id: body.connection_id, envelope: normalizedEnvelope(body.envelope) };
    case "disconnect": return { connection_id: body.connection_id };
    default: throw new Error("Invalid packet kind");
  }
}
function normalizedEnvelope(e) {
  return { id: e.id, from: e.from, to: e.to, created: e.created,
    expires: e.expires, ciphertext: e.ciphertext, signature: e.signature };
}
export const packetBytes = (p) => encode([PROTOCOL, "federation", p.id, p.kind,
  publicIdentity(p.from), publicIdentity(p.to), p.created, p.expires, normalizedBody(p.kind, p.body)]);
export async function checkPacket(p, now = Date.now()) {
  exact(p, "id,kind,from,to,created,expires,body,signature");
  if (encode(p).length > MAX_BODY) throw new Error("Packet too large");
  unb64(p.id, 24);
  for (const peer of [p.from, p.to]) {
    exact(peer, "id,label,box,sign,relay");
    await checkIdentity(peer);
  }
  if (p.from.id === p.to.id) throw new Error("Cannot connect to yourself");
  if (!Number.isSafeInteger(p.created) || !Number.isSafeInteger(p.expires) ||
      p.created > now + 60000 || p.expires <= now || p.expires <= p.created ||
      p.expires - p.created > MESSAGE_TTL)
    throw new Error("Expired or invalid packet time");
  const fields = { accept: "invite_id,receipt", confirm: "invite_id",
    message: "connection_id,envelope", disconnect: "connection_id" };
  if (!Object.hasOwn(fields, p.kind)) throw new Error("Invalid packet kind");
  exact(p.body, fields[p.kind]);
  unb64(p.body.invite_id ?? p.body.connection_id, 32);
  if (p.kind === "accept" || p.kind === "message")
    await checkEnvelope(p.body.receipt ?? p.body.envelope, p.from, p.to, now);
  if (!(await verify(p.from.sign, packetBytes(p), p.signature)))
    throw new Error("Invalid packet signature");
  return p;
}
