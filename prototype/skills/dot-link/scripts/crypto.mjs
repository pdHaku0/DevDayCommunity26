import sodium from "libsodium-wrappers";
import {
  b64,
  unb64,
  digest,
  encode,
  identityBytes,
  publicIdentity,
  envelopeBytes,
  checkEnvelope,
  checkIdentity,
  MAX_PLAINTEXT,
  MESSAGE_TTL,
} from "./protocol.mjs";
await sodium.ready;
export function sign(identity, bytes) {
  return b64(
    sodium.crypto_sign_detached(bytes, unb64(identity.signSecret, 64)),
  );
}
export async function createIdentity(label) {
  const box = sodium.crypto_box_keypair(),
    pair = sodium.crypto_sign_keypair();
  const identity = {
    label,
    box: b64(box.publicKey),
    sign: b64(pair.publicKey),
    boxSecret: b64(box.privateKey),
    signSecret: b64(pair.privateKey),
  };
  identity.id = await digest(encode([identity.box, identity.sign]));
  await checkIdentity(identity);
  return identity;
}
export const registration = (identity) => ({
  ...publicIdentity(identity),
  proof: sign(identity, identityBytes(identity)),
});
export async function seal(identity, recipient, payload, now = Date.now()) {
  await checkIdentity(recipient);
  const bytes = encode(payload);
  if (bytes.length > MAX_PLAINTEXT) throw new Error("Message exceeds 64 KiB");
  const e = {
    id: b64(crypto.getRandomValues(new Uint8Array(24))),
    from: identity.id,
    to: recipient.id,
    created: now,
    expires: now + MESSAGE_TTL,
    ciphertext: b64(sodium.crypto_box_seal(bytes, unb64(recipient.box, 32))),
  };
  e.signature = sign(identity, envelopeBytes(e));
  return e;
}
export async function open(identity, sender, envelope, now = Date.now()) {
  await checkEnvelope(envelope, sender, identity, now);
  const bytes = sodium.crypto_box_seal_open(
    unb64(envelope.ciphertext),
    unb64(identity.box, 32),
    unb64(identity.boxSecret, 32),
  );
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
// Owner-authorized browser requests travel in their own authenticated queue,
// never in peer messages. Only the selected endpoint can read the invitation.
export async function sealConnectRequest(recipient, requestId, url) {
  await checkIdentity(recipient);
  const payload = encode({
    kind: "connect",
    request_id: requestId,
    peer_id: recipient.id,
    url,
  });
  if (payload.length > 12000) throw new Error("Invitation too large");
  return b64(sodium.crypto_box_seal(payload, unb64(recipient.box, 32)));
}
export function openConnectRequest(identity, request) {
  if (request.expires <= Date.now())
    throw new Error("Connection request expired");
  const bytes = sodium.crypto_box_seal_open(
    unb64(request.ciphertext),
    unb64(identity.box, 32),
    unb64(identity.boxSecret, 32),
  );
  const payload = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (
    payload.kind !== "connect" ||
    payload.request_id !== request.id ||
    payload.peer_id !== identity.id ||
    typeof payload.url !== "string"
  )
    throw new Error("Invalid owner connection request");
  return payload;
}
