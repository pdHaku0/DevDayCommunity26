import { mkdir, readFile, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createIdentity, seal, open as decrypt, sign } from "./crypto.mjs";
import {
  b64,
  unb64,
  digest,
  encode,
  publicIdentity,
  checkIdentity,
  verify,
  INVITE_TTL,
} from "./protocol.mjs";
export const stateDirectory = () =>
  process.env.DOT_LINK_HOME || join(homedir(), ".local", "share", "dot-link");
export async function transact(fn) {
  const dir = stateDirectory();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, ".lock");
  try {
    await mkdir(lock);
  } catch (e) {
    if (e.code === "EEXIST")
      throw new Error(
        "Another client operation owns the state lock. Retry after it finishes.",
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
  const u = new URL(relay);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw new Error("Expected HTTPS relay origin");
  return {
    identity: await createIdentity(label),
    relay: u.origin,
    peers: {},
    invites: {},
    acceptances: {},
    inbox: {},
    outbox: {},
  };
}
export const call = (operation, input) => ({
  tool: "link_exchange",
  arguments: { operation, input },
});
const inviteBytes = (t) =>
  encode([
    "dot-link",
    "invite",
    t.relay,
    t.id,
    t.secret,
    t.expires,
    publicIdentity(t.peer),
  ]);
export async function invite(state) {
  const secret = b64(crypto.getRandomValues(new Uint8Array(32))),
    id = await digest(secret);
  const token = {
    relay: state.relay,
    id,
    secret,
    expires: Date.now() + INVITE_TTL,
    peer: publicIdentity(state.identity),
  };
  token.signature = sign(state.identity, inviteBytes(token));
  const url = `${state.relay}/connect#${b64(encode(token))}`;
  state.invites[id] = { secret, url };
  return {
    request: call("invite.create", {
      peer_id: state.identity.id,
      invite_id: id,
    }),
    invitation: url,
    note: "Share the invitation only after invite.create succeeds.",
  };
}
export async function accept(state, url) {
  const u = new URL(url);
  if (u.origin !== state.relay || u.pathname !== "/connect")
    throw new Error("Invitation relay differs from configured relay");
  const t = JSON.parse(new TextDecoder().decode(unb64(u.hash.slice(1))));
  await checkIdentity(t.peer);
  unb64(t.secret, 32);
  if (
    t.relay !== state.relay ||
    t.expires <= Date.now() ||
    (await digest(t.secret)) !== t.id ||
    !(await verify(t.peer.sign, inviteBytes(t), t.signature))
  )
    throw new Error("Invalid or expired invitation");
  if (t.peer.id === state.identity.id)
    throw new Error("Cannot connect to yourself");
  const known = state.peers[t.peer.id];
  if (known && (known.box !== t.peer.box || known.sign !== t.peer.sign))
    throw new Error("Peer key mismatch");
  state.peers[t.peer.id] = { ...publicIdentity(t.peer), active: false };
  if (!state.acceptances[t.id])
    state.acceptances[t.id] = await seal(state.identity, t.peer, {
      kind: "pair",
      invite_id: t.id,
      secret: t.secret,
      peer: publicIdentity(state.identity),
    });
  return call("invite.accept", {
    peer_id: state.identity.id,
    invite_id: t.id,
    receipt: state.acceptances[t.id],
  });
}
export async function ingest(state, response) {
  const actions = [],
    errors = [];
  for (const item of response.invitations || []) {
    try {
      const saved = state.invites[item.invite_id];
      if (!saved) throw new Error("Unknown local invitation");
      await checkIdentity(item.peer);
      const payload = await decrypt(state.identity, item.peer, item.receipt);
      if (
        payload.kind !== "pair" ||
        payload.invite_id !== item.invite_id ||
        payload.secret !== saved.secret ||
        JSON.stringify(publicIdentity(payload.peer)) !==
          JSON.stringify(publicIdentity(item.peer))
      )
        throw new Error("Invitation proof mismatch");
      const previous = state.peers[item.peer.id];
      if (
        previous &&
        (previous.box !== item.peer.box || previous.sign !== item.peer.sign)
      )
        throw new Error("Peer key mismatch");
      state.peers[item.peer.id] = {
        ...publicIdentity(item.peer),
        active: false,
      };
      actions.push(
        call("invite.confirm", {
          peer_id: state.identity.id,
          invite_id: item.invite_id,
          acceptor: item.peer.id,
        }),
      );
    } catch (e) {
      errors.push({ invite_id: item.invite_id, error: e.message });
    }
  }
  for (const p of response.contacts || []) {
    const pinned = state.peers[p.id];
    if (!pinned) continue; // A server-listed contact cannot bootstrap key trust.
    if (pinned.box !== p.box || pinned.sign !== p.sign) {
      errors.push({ peer_id: p.id, error: "Peer key mismatch" });
      continue;
    }
    pinned.active = p.active === true;
  }
  const ack = [];
  for (const e of response.messages || []) {
    try {
      const peer = state.peers[e.from];
      if (!peer?.active)
        throw new Error("Sender is not a pinned active contact");
      if (state.inbox[e.id]) {
        if (JSON.stringify(state.inbox[e.id].envelope) !== JSON.stringify(e))
          throw new Error("Message ID conflict");
      } else {
        const payload = await decrypt(state.identity, peer, e);
        if (payload.kind !== "message" || !Object.hasOwn(payload, "body"))
          throw new Error("Invalid message payload");
        state.inbox[e.id] = { envelope: e, received: Date.now(), read: false };
      }
      ack.push(e.id);
    } catch (e) {
      errors.push({ message_id: e.id, error: e.message });
    }
  }
  if (ack.length)
    actions.push(call("ack", { peer_id: state.identity.id, message_ids: ack }));
  // transact persists ciphertext and pinned peers before any acknowledgment is emitted.
  return {
    actions,
    errors,
    unread: Object.values(state.inbox).filter((m) => !m.read).length,
  };
}
export async function send(state, peerId, body) {
  const peer = state.peers[peerId];
  if (!peer?.active)
    throw new Error("Contact is not connected; synchronize first");
  const envelope = await seal(state.identity, peer, { kind: "message", body });
  state.outbox[envelope.id] = envelope;
  return call("send", { envelope });
}
export async function inbox(state) {
  const messages = [];
  for (const item of Object.values(state.inbox).filter((m) => !m.read)) {
    const e = item.envelope,
      payload = await decrypt(
        state.identity,
        state.peers[e.from],
        e,
        item.received,
      );
    messages.push({
      id: e.id,
      from: e.from,
      label: state.peers[e.from].label,
      body: payload.body,
    });
  }
  return { messages };
}
