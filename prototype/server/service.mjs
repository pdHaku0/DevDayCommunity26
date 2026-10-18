import { updateNotice } from "./updates.mjs";
import { LinkError, remoteMetadata, responseJson, transportFailure } from "./errors.mjs";
import { z } from "zod";
import {
  checkIdentity, identityBytes, verify, publicIdentity, checkPacket, packetBytes,
  digest, envelopeBytes, validateRelay, MESSAGE_TTL, INVITE_TTL,
} from "../skills/dot-link/scripts/protocol.mjs";
const id = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const identitySchema = z.object({
  id, label: z.string().min(1).max(64), box: z.string(), sign: z.string(),
  relay: z.string(), proof: z.string(),
}).strict();
const schemas = {
  "invite.create": z.object({ peer_id: id, invite_id: id }).strict(),
  dispatch: z.object({ packet: z.any() }).strict(),
  sync: z.object({ peer_id: id }).strict(),
  ack: z.object({ peer_id: id, message_ids: z.array(z.string().max(64)).max(50) }).strict(),
};
export const operations = Object.keys(schemas);
export { LinkError } from "./errors.mjs";
export function requireThat(value, code, message) {
  if (!value) throw new LinkError(code, message);
}
function same(a, b) {
  return JSON.stringify(publicIdentity(a)) === JSON.stringify(publicIdentity(b));
}
export class Service {
  /** @param {any} db @param {{origin?: string, fetcher?: typeof fetch, now?: () => number, requestId?: string}} options */
  constructor(db, { origin, fetcher = fetch, now = () => Date.now(), requestId = crypto.randomUUID() } = {}) {
    this.db = db;
    this.requestId = requestId;
    this.origin = validateRelay(origin);
    // Worker-native fetch requires its global receiver when stored on an instance.
    this.fetcher = fetcher.bind(globalThis);
    this.now = now;
  }
  q(sql, ...args) { return this.db.prepare(sql).bind(...args); }
  async one(sql, ...args) { return this.q(sql, ...args).first(); }
  async all(sql, ...args) { return (await this.q(sql, ...args).all()).results; }
  async run(sql, ...args) { return this.q(sql, ...args).run(); }
  async owned(owner, peer) {
    const p = await this.one("SELECT * FROM f_peers WHERE id=? AND owner=?", peer, owner);
    requireThat(p, "forbidden", "Peer is not owned by this account");
    return p;
  }
  async account(owner) {
    return {
      peers: (await this.all("SELECT * FROM f_peers WHERE owner=? ORDER BY created", owner)).map(publicIdentity),
      subscriptions: await this.all("SELECT id,peer,expires FROM f_subscriptions WHERE owner=? AND expires>?", owner, this.now()),
      failed_notifications: (await this.one("SELECT count(*) AS n FROM f_deliveries d JOIN f_subscriptions s ON s.id=d.subscription WHERE s.owner=? AND d.status='failed'", owner)).n,
    };
  }
  async register(owner, args) {
    const p = identitySchema.parse(args);
    await checkIdentity(p);
    requireThat(p.relay === this.origin, "wrong_relay", "Identity must belong to this Site");
    requireThat(await verify(p.sign, identityBytes(p), p.proof), "invalid_proof", "Invalid key possession proof");
    const existing = await this.one("SELECT * FROM f_peers WHERE id=?", p.id);
    if (existing) {
      requireThat(existing.owner === owner && same(existing, p), "forbidden", "Registered identity cannot be replaced");
      return publicIdentity(existing);
    }
    requireThat((await this.one("SELECT count(*) AS n FROM f_peers WHERE owner=?", owner)).n < 4, "limit", "At most four endpoints per account");
    await this.run("INSERT INTO f_peers(id,owner,label,box,sign,relay,created) VALUES(?,?,?,?,?,?,?)", p.id, owner, p.label, p.box, p.sign, p.relay, this.now());
    return publicIdentity(p);
  }
  async unregister(owner, peerId) {
    id.parse(peerId);
    const existing = await this.one("SELECT owner FROM f_peers WHERE id=?", peerId);
    if (!existing) return { deleted: true, peer_id: peerId };
    requireThat(existing.owner === owner, "forbidden", "Peer is not owned by this account");
    await this.db.batch([
      this.q("DELETE FROM f_deliveries WHERE (peer=? OR subscription IN (SELECT id FROM f_subscriptions WHERE peer=?)) AND EXISTS(SELECT 1 FROM f_peers WHERE id=? AND owner=?)", peerId, peerId, peerId, owner),
      this.q("DELETE FROM f_subscriptions WHERE peer=? AND EXISTS(SELECT 1 FROM f_peers WHERE id=? AND owner=?)", peerId, peerId, owner),
      this.q("DELETE FROM f_update_preferences WHERE peer=? AND EXISTS(SELECT 1 FROM f_peers WHERE id=? AND owner=?)", peerId, peerId, owner),
      this.q("DELETE FROM f_messages WHERE (recipient=? OR sender=?) AND EXISTS(SELECT 1 FROM f_peers WHERE id=? AND owner=?)", peerId, peerId, peerId, owner),
      this.q("DELETE FROM f_invites WHERE (inviter=? OR json_extract(acceptor,'$.id')=?) AND EXISTS(SELECT 1 FROM f_peers WHERE id=? AND owner=?)", peerId, peerId, peerId, owner),
      this.q("DELETE FROM f_connections WHERE (local=? OR remote=?) AND EXISTS(SELECT 1 FROM f_peers WHERE id=? AND owner=?)", peerId, peerId, peerId, owner),
      this.q("DELETE FROM f_packets WHERE sender=? AND EXISTS(SELECT 1 FROM f_peers WHERE id=? AND owner=?)", peerId, peerId, owner),
      this.q("DELETE FROM f_peers WHERE id=? AND owner=?", peerId, owner),
    ]);
    return { deleted: true, peer_id: peerId };
  }
  async cleanup() {
    const now = this.now();
    await this.db.batch([
      this.q("DELETE FROM f_messages WHERE expires<=?", now),
      this.q("DELETE FROM f_invites WHERE expires<=?", now),
      this.q("DELETE FROM f_packets WHERE expires<=?", now),
      this.q("DELETE FROM f_deliveries WHERE occurred<=? OR subscription IN (SELECT id FROM f_subscriptions WHERE expires<=?)", now - MESSAGE_TTL, now),
      this.q("DELETE FROM f_subscriptions WHERE expires<=?", now),
    ]);
  }
  async notify(peer) {
    const subs = await this.all("SELECT id FROM f_subscriptions WHERE peer=? AND expires>?", peer, this.now());
    if (subs.length) await this.db.batch(subs.map(s => this.q(
      // Each change needs its own delivery: an in-flight callback may already
      // have triggered a sync before this change arrived. Completing that older
      // callback must not consume the new wake-up.
      "INSERT INTO f_deliveries(id,subscription,peer,occurred,next) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM f_subscriptions s JOIN f_peers p ON p.id=s.peer WHERE s.id=? AND s.peer=? AND s.expires>?)",
      crypto.randomUUID(), s.id, peer, this.now(), this.now(), s.id, peer, this.now(),
    )));
  }
  async connection(local, remote, connectionId) {
    return this.one("SELECT * FROM f_connections WHERE local=? AND remote=? AND connection_id=?", local, remote, connectionId);
  }
  async pin(local, remote, connectionId, status) {
    requireThat(local !== remote.id, "invalid_input", "Cannot connect an endpoint to itself");
    const old = await this.connection(local, remote.id, connectionId);
    if (old) {
      requireThat(same(JSON.parse(old.identity), remote), "conflict", "Contact identity does not match");
      requireThat(old.status !== "closed", "closed", "Connection is closed; use a new invitation");
      return old;
    }
    requireThat(!(await this.one("SELECT 1 FROM f_connections WHERE local=? AND remote=? AND status<>'closed'", local, remote.id)), "conflict", "A connection to this endpoint already exists");
    requireThat((await this.one("SELECT count(*) AS n FROM f_connections WHERE local=?", local)).n < 200, "limit", "Connection limit reached");
    await this.run("INSERT OR IGNORE INTO f_connections(local,remote,connection_id,identity,status,created) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM f_peers WHERE id=?)", local, remote.id, connectionId, JSON.stringify(publicIdentity(remote)), status, this.now(), local);
    const saved = await this.connection(local, remote.id, connectionId);
    requireThat(saved && saved.status !== "closed" && same(JSON.parse(saved.identity), remote), "conflict", "Connection changed during pairing");
    return saved;
  }
  async requireConnection(local, remote, connectionId, allowed = ["active"]) {
    const c = await this.connection(local, remote.id, connectionId);
    requireThat(c && same(JSON.parse(c.identity), remote) && allowed.includes(c.status), "not_connected", "Connection does not permit this packet");
    return c;
  }
  async remember(packet, direction) {
    const fingerprint = await digest(packetBytes(packet));
    await this.run("INSERT OR IGNORE INTO f_packets(id,direction,sender,fingerprint,created,expires) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM f_peers WHERE id=?)", packet.id, direction, packet.from.id, fingerprint, this.now(), packet.expires, packet.from.id);
    const row = await this.one("SELECT fingerprint FROM f_packets WHERE id=? AND direction=?", packet.id, direction);
    requireThat(row && row.fingerprint === fingerprint, "conflict", "Packet ID reused with different content");
  }
  async close(local, remote, connectionId) {
    await this.db.batch([
      this.q("UPDATE f_connections SET status='closed' WHERE local=? AND remote=? AND connection_id=?", local, remote, connectionId),
      this.q("UPDATE f_messages SET envelope=NULL WHERE recipient=? AND sender=? AND connection_id=?", local, remote, connectionId),
    ]);
  }
  async forward(packet) {
    const relay = validateRelay(packet.to.relay), stage = "federation.transport";
    const signal = AbortSignal.timeout(8000);
    let response;
    try {
      response = await this.fetcher(relay + "/api/federation", {
        method: "POST", redirect: "manual", signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(packet),
      });
      const status = response.status;
      if (status >= 300 && status < 400) {
        await response.body?.cancel();
        throw new LinkError("delivery_redirect", "Delivery was not confirmed: redirects are not followed", {stage,retryable:false,remote_status:status});
      }
      let result;
      try { result = await responseJson(response, {stage,prefix:"delivery"}); }
      catch (error) { if (response.ok) throw error; }
      const meta = remoteMetadata(result, status);
      if (!response.ok) {
        const code = status === 429 ? "delivery_rate_limited" : status >= 500 ? "delivery_remote_unavailable" : "delivery_http_error";
        throw new LinkError(code, "Delivery was not confirmed: the remote server returned an HTTP error", {stage,retryable:status === 408 || status === 429 || status >= 500,...meta});
      }
      if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.ok !== "boolean")
        throw new LinkError("delivery_invalid_response", "Delivery was not confirmed: invalid response format", {stage,retryable:true,...meta});
      if (!result.ok)
        throw new LinkError("delivery_remote_rejected", "Delivery was not confirmed: the remote server did not accept the packet", {stage,retryable:meta.remote_code === "limit",...meta});
      const safe = {ok:true};
      for (const key of ["connected", "pending", "disconnected", "stored", "duplicate"])
        if (typeof result[key] === "boolean") safe[key] = result[key];
      if (result.id === packet.body.envelope?.id) safe.id = result.id;
      return safe;
    } catch (error) {
      throw transportFailure(error, stage, "delivery", signal);
    }
  }
  async dispatch(owner, packet) {
    await checkPacket(packet, this.now());
    const local = await this.owned(owner, packet.from.id);
    requireThat(same(local, packet.from) && packet.from.relay === this.origin, "forbidden", "Packet sender differs from the registered endpoint");
    const b = packet.body;
    await this.remember(packet, "out");
    if (packet.kind === "accept") {
      const c = await this.pin(local.id, packet.to, b.invite_id, "outbound");
      requireThat(c.status === "outbound" || c.status === "active", "conflict", "Connection was not locally accepted");
    } else if (packet.kind === "confirm") {
      const inv = await this.one("SELECT * FROM f_invites WHERE id=? AND inviter=? AND expires>?", b.invite_id, local.id, this.now());
      requireThat(inv?.acceptor && same(JSON.parse(inv.acceptor), packet.to), "not_found", "Accepted invitation unavailable");
      await this.pin(local.id, packet.to, b.invite_id, "confirming");
    } else if (packet.kind === "message") {
      await this.requireConnection(local.id, packet.to, b.connection_id);
      requireThat((await this.one("SELECT count(*) AS n FROM f_packets WHERE direction='out' AND sender=? AND created>?", local.id, this.now() - 3600000)).n <= 100, "limit", "Hourly packet limit reached");
    } else if (packet.kind === "disconnect") {
      await this.requireConnection(local.id, packet.to, b.connection_id, ["active", "outbound", "confirming", "closed"]);
      await this.close(local.id, packet.to.id, b.connection_id);
    }
    const result = await this.forward(packet);
    if (packet.kind === "confirm") {
      // A concurrent revocation must win even when delivery completes afterwards.
      await this.db.batch([
        this.q("UPDATE f_connections SET status='active' WHERE local=? AND remote=? AND connection_id=? AND status='confirming'", local.id, packet.to.id, b.invite_id),
        this.q("UPDATE f_invites SET confirmed=1 WHERE id=? AND inviter=?", b.invite_id, local.id),
      ]);
      const c = await this.connection(local.id, packet.to.id, b.invite_id);
      requireThat(c?.status === "active", "closed", "Connection was closed during confirmation");
      return { connected: true, packet_id: packet.id };
    }
    return { ...result, packet_id: packet.id, delivered: true };
  }
  async receive(packet) {
    await checkPacket(packet, this.now());
    requireThat(packet.to.relay === this.origin, "wrong_relay", "Packet targets another Site");
    const local = await this.one("SELECT * FROM f_peers WHERE id=?", packet.to.id);
    requireThat(local && same(local, packet.to), "not_found", "Recipient endpoint unavailable");
    requireThat(packet.from.id !== packet.to.id, "invalid_input", "Cannot send to the same endpoint");
    await this.cleanup();
    const b = packet.body;
    if (packet.kind === "accept") {
      const inv = await this.one("SELECT * FROM f_invites WHERE id=? AND inviter=? AND expires>?", b.invite_id, local.id, this.now());
      requireThat(inv, "not_found", "Invitation unavailable");
      const closed = await this.connection(local.id, packet.from.id, b.invite_id);
      requireThat(closed?.status !== "closed", "closed", "Connection is closed");
      const fingerprint = await digest(packetBytes(packet));
      requireThat(!inv.acceptance || inv.acceptance === fingerprint, "consumed", "Invitation already accepted");
      await this.run("UPDATE f_invites SET acceptor=?,receipt=?,acceptance=? WHERE id=? AND acceptor IS NULL", JSON.stringify(publicIdentity(packet.from)), JSON.stringify(b.receipt), fingerprint, inv.id);
      const saved = await this.one("SELECT * FROM f_invites WHERE id=?", inv.id);
      requireThat(saved?.acceptance === fingerprint, "consumed", "Invitation already accepted; retry the original packet");
      if (!inv.acceptor && !saved.confirmed) await this.notify(local.id);
      return { pending: !saved.confirmed };
    }
    if (packet.kind === "confirm") {
      const previous = await this.requireConnection(local.id, packet.from, b.invite_id, ["outbound", "active"]);
      await this.run("UPDATE f_connections SET status='active' WHERE local=? AND remote=? AND connection_id=? AND status='outbound'", local.id, packet.from.id, b.invite_id);
      const c = await this.connection(local.id, packet.from.id, b.invite_id);
      requireThat(c?.status === "active", "closed", "Connection is closed");
      if (previous.status !== "active") await this.notify(local.id);
      return { connected: true };
    }
    if (packet.kind === "disconnect") {
      let previous = await this.connection(local.id, packet.from.id, b.connection_id);
      if (!previous) {
        // The acceptor may withdraw before the inviter has decrypted and confirmed.
        const inv = await this.one("SELECT acceptor FROM f_invites WHERE id=? AND inviter=? AND expires>?", b.connection_id, local.id, this.now());
        requireThat(inv?.acceptor && same(JSON.parse(inv.acceptor), packet.from), "not_connected", "No accepted invitation to withdraw");
        requireThat((await this.one("SELECT count(*) AS n FROM f_connections WHERE local=?", local.id)).n < 200, "limit", "Connection limit reached");
        await this.run("INSERT OR IGNORE INTO f_connections(local,remote,connection_id,identity,status,created) SELECT ?,?,?,?,'closed',? WHERE NOT EXISTS(SELECT 1 FROM f_connections WHERE local=? AND remote=? AND status<>'closed') AND EXISTS(SELECT 1 FROM f_invites WHERE id=? AND inviter=? AND acceptor=?)", local.id, packet.from.id, b.connection_id, JSON.stringify(publicIdentity(packet.from)), this.now(), local.id, packet.from.id, b.connection_id, local.id, JSON.stringify(publicIdentity(packet.from)));
        previous = await this.connection(local.id, packet.from.id, b.connection_id);
        requireThat(previous && same(JSON.parse(previous.identity), packet.from), "conflict", "Connection changed during withdrawal");
        await this.close(local.id, packet.from.id, b.connection_id);
        await this.notify(local.id);
        return { disconnected: true };
      }
      await this.requireConnection(local.id, packet.from, b.connection_id, ["active", "outbound", "confirming", "closed"]);
      await this.close(local.id, packet.from.id, b.connection_id);
      if (previous.status !== "closed") await this.notify(local.id);
      return { disconnected: true };
    }
    await this.requireConnection(local.id, packet.from, b.connection_id);
    const e = b.envelope, fingerprint = await digest(envelopeBytes(e));
    const old = await this.one("SELECT * FROM f_messages WHERE id=?", e.id);
    if (old) {
      requireThat(old.fingerprint === fingerprint && old.connection_id === b.connection_id, "conflict", "Message ID reused with different content");
      return { id: e.id, stored: old.envelope !== null, duplicate: true };
    }
    requireThat((await this.one("SELECT count(*) AS n FROM f_messages WHERE sender=? AND created>?", packet.from.id, this.now() - 3600000)).n < 100, "limit", "Hourly message limit reached");
    await this.run("INSERT OR IGNORE INTO f_messages(id,sender,recipient,connection_id,envelope,fingerprint,created,expires) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM f_connections WHERE local=? AND remote=? AND connection_id=? AND status='active')", e.id, e.from, e.to, b.connection_id, JSON.stringify(e), fingerprint, this.now(), e.expires, local.id, packet.from.id, b.connection_id);
    const saved = await this.one("SELECT * FROM f_messages WHERE id=?", e.id);
    requireThat(saved, "not_connected", "Connection was closed during delivery");
    requireThat(saved.fingerprint === fingerprint && saved.connection_id === b.connection_id, "conflict", "Message ID reused with different content");
    await this.notify(local.id);
    return { id: e.id, stored: saved.envelope !== null, duplicate: false };
  }
  async call(owner, operation, input) {
    requireThat(schemas[operation], "invalid_operation", "Unknown operation");
    const a = schemas[operation].parse(input);
    await this.cleanup();
    if (operation === "dispatch") return this.dispatch(owner, a.packet);
    const peer = await this.owned(owner, a.peer_id);
    if (operation === "invite.create") {
      const old = await this.one("SELECT * FROM f_invites WHERE id=?", a.invite_id);
      if (old) {
        requireThat(old.inviter === peer.id, "conflict", "Invitation already exists");
        return { invite_id: old.id, expires: old.expires };
      }
      requireThat((await this.one("SELECT count(*) AS n FROM f_invites WHERE inviter=?", peer.id)).n < 20, "limit", "Too many active invitations");
      const expires = this.now() + INVITE_TTL;
      await this.run("INSERT INTO f_invites(id,inviter,expires) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM f_peers WHERE id=? AND owner=?)", a.invite_id, peer.id, expires, peer.id, owner);
      requireThat(await this.one("SELECT id FROM f_invites WHERE id=? AND inviter=?", a.invite_id, peer.id), "not_found", "Endpoint was removed during invitation creation");
      return { invite_id: a.invite_id, expires };
    }
    if (operation === "ack") {
      if (a.message_ids.length) await this.db.batch(a.message_ids.map(mid => this.q("UPDATE f_messages SET envelope=NULL WHERE id=? AND recipient=?", mid, peer.id)));
      return { acknowledged: true };
    }
    const rows = await this.all("SELECT * FROM f_connections WHERE local=? ORDER BY rowid DESC", peer.id);
    const contacts = [...new Map(rows.map(c => [c.remote, c]).reverse()).values()].map(c => ({...JSON.parse(c.identity), active: c.status === "active", closed: c.status === "closed", connection_id: c.connection_id}));
    return {
      contacts,
      update: await updateNotice(this, peer.id),
      invitations: (await this.all("SELECT * FROM f_invites WHERE inviter=? AND receipt IS NOT NULL AND confirmed=0 AND NOT EXISTS(SELECT 1 FROM f_connections c WHERE c.local=f_invites.inviter AND c.connection_id=f_invites.id AND c.status='closed')", peer.id)).map(i => ({invite_id: i.id, peer: JSON.parse(i.acceptor), receipt: JSON.parse(i.receipt)})),
      messages: (await this.all("SELECT envelope FROM f_messages WHERE recipient=? AND envelope IS NOT NULL AND expires>? ORDER BY created,id LIMIT 50", peer.id, this.now())).map(m => JSON.parse(m.envelope)),
    };
  }
}
