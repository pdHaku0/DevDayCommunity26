import { ClientError, safeError } from "./safe-errors.mjs";
import { mkdir, readFile, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createIdentity, seal, open as decrypt, sign, makePacket } from "./crypto.mjs";
import { PROTOCOL, b64, digest, encode, publicIdentity, checkIdentity,
  checkPacket, INVITE_TTL, inviteBytes, readInvitation } from "./protocol.mjs";
export const stateDirectory = () =>
  process.env.DOT_LINK_HOME || join(homedir(), ".local", "share", "dot-link-federated");
export async function transact(fn) {
  const dir = stateDirectory();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, ".lock");
  try {
    await mkdir(lock);
  } catch (e) {
    if (e.code === "EEXIST")
      throw new ClientError(
        "Another client operation owns the state lock. Retry after it finishes.",
        "STATE_BUSY", true,
      );
    throw e;
  }
  try {
    let state;
    try {
      state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (state && state.protocol !== PROTOCOL)
      throw new ClientError("Incompatible local state. Use a fresh DOT_LINK_HOME; old state is not migrated.");
    const result = await fn(state);
    if (result.state) {
      const tmp = join(dir, `state-${crypto.randomUUID()}.tmp`);
      const f = await open(tmp, "wx", 0o600);
      try {
        await f.writeFile(JSON.stringify(result.state));
        await f.sync();
      } finally {
        await f.close();
      }
      await rename(tmp, join(dir, "state.json"));
      const directory = await open(dir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    return result.output;
  } finally {
    await rm(lock, { recursive: true });
  }
}
export async function initialize(label, relay) {
  return {
    protocol: PROTOCOL,
    identity: await createIdentity(label, relay),
    peers: {}, invites: {}, acceptances: {}, confirmations: {}, inbox: {}, outbox: {},
  };
}
export const call = (operation, input) => ({
  tool: "link_exchange", arguments: { operation, input },
});
const diagnosticId = (value) => typeof value === "string" && /^(?:[A-Za-z0-9_-]{32}|[A-Za-z0-9_-]{43})$/.test(value) ? value : undefined;
const sameIdentity = (a, b) => JSON.stringify(publicIdentity(a)) === JSON.stringify(publicIdentity(b));
function pin(state, peer, connectionId) {
  const previous = state.peers[peer.id];
  if (previous && !sameIdentity(previous, peer)) throw new ClientError("Pinned peer identity mismatch");
  if (previous && previous.connection_id === connectionId) {
    if (previous.closed) throw new ClientError("Connection was closed; use a new invitation");
    return previous;
  }
  if (previous && !previous.closed) throw new ClientError("Peer already has a connection; disconnect first");
  return state.peers[peer.id] = { ...publicIdentity(peer), active: false, closed: false, connection_id: connectionId };
}
function dispatch(state, packet) {
  state.outbox[packet.id] = packet;
  return call("dispatch", { packet });
}
export async function invite(state) {
  const secret = b64(crypto.getRandomValues(new Uint8Array(32))), id = await digest(secret);
  const token = { relay: state.identity.relay, id, secret,
    expires: Date.now() + INVITE_TTL, peer: publicIdentity(state.identity) };
  token.signature = sign(state.identity, inviteBytes(token));
  const url = `${token.relay}/connect#${b64(encode(token))}`;
  state.invites[id] = { secret, url };
  return {
    request: call("invite.create", { peer_id: state.identity.id, invite_id: id }),
    invitation: url, note: "Share the invitation only after invite.create succeeds.",
  };
}
export async function accept(state, url) {
  const t = await readInvitation(url);
  if (t.peer.id === state.identity.id) throw new ClientError("Cannot connect to yourself");
  pin(state, t.peer, t.id);
  if (state.acceptances[t.id]) return retry(state, state.acceptances[t.id]);
  const receipt = await seal(state.identity, t.peer, {
    kind: "pair", invite_id: t.id, secret: t.secret, peer: publicIdentity(state.identity),
  });
  const packet = await makePacket(state.identity, t.peer, "accept", { invite_id: t.id, receipt });
  state.acceptances[t.id] = packet.id;
  return dispatch(state, packet);
}
export async function ingest(state, response) {
  const actions = [], errors = [];
  // Apply the server snapshot before new invitations replace a closed connection.
  for (const p of response.contacts || []) {
    const pinned = state.peers[p.id];
    if (!pinned) continue; // Server contacts cannot bootstrap key trust.
    if (!sameIdentity(pinned, p) || pinned.connection_id !== p.connection_id) {
      errors.push({ peer_id: diagnosticId(p.id), ...safeError(new ClientError("Pinned connection mismatch"), "ingest.contacts") });
      continue;
    }
    if (p.closed === true) { pinned.closed = true; pinned.active = false; }
    if (pinned.closed) continue;
    pinned.active = p.active === true;
  }
  for (const item of response.invitations || []) {
    try {
      const saved = state.invites[item.invite_id];
      if (!saved) throw new ClientError("Unknown local invitation");
      await checkIdentity(item.peer);
      const payload = await decrypt(state.identity, item.peer, item.receipt);
      if (payload.kind !== "pair" || payload.invite_id !== item.invite_id ||
          payload.secret !== saved.secret || !payload.peer || !sameIdentity(payload.peer, item.peer))
        throw new ClientError("Invitation proof mismatch");
      if (saved.acceptor && saved.acceptor !== item.peer.id) throw new ClientError("Invitation already accepted by another peer");
      pin(state, item.peer, item.invite_id);
      saved.acceptor = item.peer.id;
      let packet;
      if (state.confirmations[item.invite_id]) {
        actions.push(await retry(state, state.confirmations[item.invite_id]));
      } else {
        packet = await makePacket(state.identity, item.peer, "confirm", { invite_id: item.invite_id });
        state.confirmations[item.invite_id] = packet.id;
        actions.push(dispatch(state, packet));
      }
    } catch (e) { errors.push({ invite_id: diagnosticId(item?.invite_id), ...safeError(e, "ingest.invitation") }); }
  }
  const ack = [];
  for (const envelope of response.messages || []) {
    try {
      const peer = state.peers[envelope.from];
      if (!peer?.active || peer.closed) throw new ClientError("Sender is not a pinned active contact");
      const payload = await decrypt(state.identity, peer, envelope);
      if (payload.kind !== "message" || !Object.hasOwn(payload, "body") || payload.connection_id !== peer.connection_id)
        throw new ClientError("Invalid message payload or connection");
      const previous = state.inbox[envelope.id];
      if (previous) {
        if (JSON.stringify(previous.envelope) !== JSON.stringify(envelope)) throw new ClientError("Message ID conflict");
      } else {
        state.inbox[envelope.id] = { envelope, sender: publicIdentity(peer), received: Date.now(), read: false };
      }
      ack.push(envelope.id);
    } catch (e) { errors.push({ message_id: diagnosticId(envelope?.id), ...safeError(e, "ingest.message") }); }
  }
  if (ack.length) actions.push(call("ack", { peer_id: state.identity.id, message_ids: ack }));
  let update = null;
  if (response.update != null) {
    const u = response.update;
    if (u.repository === "https://github.com/pdHaku0/DevDayCommunity26/tree/prototype/dot-link" &&
        Number.isSafeInteger(u.version) && Number.isSafeInteger(u.installed_version) &&
        u.installed_version >= 0 && u.version > u.installed_version) {
      update = {version:u.version, installed_version:u.installed_version, repository:u.repository,
        next_action:"apply_update",
        instructions:"AUTO_UPDATE.md"};
    } else errors.push(safeError(new ClientError("Invalid update notice"), "ingest.update"));
  }
  // transact persists ciphertext and pins before any acknowledgment or dispatch is emitted.
  const update_registration = typeof response.update_registration?.registered === "boolean"
    ? {registered:response.update_registration.registered} : null;
  return { actions, errors, update, update_registration, unread: Object.values(state.inbox).filter((m) => !m.read).length };
}
export async function send(state, peerId, body) {
  const peer = state.peers[peerId];
  if (!peer?.active || peer.closed) throw new ClientError("Contact is not connected; synchronize first");
  const envelope = await seal(state.identity, peer, { kind: "message", connection_id: peer.connection_id, body });
  return dispatch(state, await makePacket(state.identity, peer, "message", { connection_id: peer.connection_id, envelope }));
}
export async function retry(state, packetId) {
  const packet = state.outbox[packetId];
  if (!packet) throw new ClientError("Unknown outgoing packet");
  await checkPacket(packet);
  const peer = state.peers[packet.to.id];
  if (!peer || peer.connection_id !== (packet.body.invite_id ?? packet.body.connection_id) ||
      (peer.closed && packet.kind !== "disconnect")) throw new ClientError("Outgoing connection is no longer current");
  return call("dispatch", { packet });
}
export async function disconnect(state, peerId) {
  const peer = state.peers[peerId];
  if (!peer) throw new ClientError("Unknown contact");
  if (peer.disconnect_packet) return retry(state, peer.disconnect_packet);
  const packet = await makePacket(state.identity, peer, "disconnect", { connection_id: peer.connection_id });
  peer.active = false;
  peer.closed = true;
  peer.disconnect_packet = packet.id;
  return dispatch(state, packet);
}
export async function inbox(state) {
  const messages = [];
  for (const item of Object.values(state.inbox).filter((m) => !m.read)) {
    const e = item.envelope, payload = await decrypt(state.identity, item.sender, e, item.received);
    messages.push({ id: e.id, from: e.from, label: item.sender.label, body: payload.body });
  }
  return { messages };
}
