import { z } from "zod";
import {
  checkIdentity,
  identityBytes,
  verify,
  publicIdentity,
  checkEnvelope,
  digest,
  encode,
  unb64,
  MESSAGE_TTL,
  INVITE_TTL,
} from "../skills/dot-link/scripts/protocol.mjs";
const id = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const envelope = z
  .object({
    id: z.string(),
    from: id,
    to: id,
    created: z.number(),
    expires: z.number(),
    ciphertext: z.string(),
    signature: z.string(),
  })
  .strict();
export const identitySchema = z
  .object({
    id,
    label: z.string().min(1).max(64),
    box: z.string(),
    sign: z.string(),
    proof: z.string(),
  })
  .strict();
const schemas = {
  "connect.complete": z
    .object({
      peer_id: id,
      request_id: id,
      status: z.enum(["accepted", "failed"]),
      other: id.optional(),
    })
    .strict(),
  "invite.create": z.object({ peer_id: id, invite_id: id }).strict(),
  "invite.accept": z
    .object({ peer_id: id, invite_id: id, receipt: envelope })
    .strict(),
  "invite.confirm": z
    .object({ peer_id: id, invite_id: id, acceptor: id })
    .strict(),
  sync: z.object({ peer_id: id }).strict(),
  send: z.object({ envelope }).strict(),
  ack: z
    .object({ peer_id: id, message_ids: z.array(z.string()).max(50) })
    .strict(),
  disconnect: z.object({ peer_id: id, other: id }).strict(),
};
export const operations = Object.keys(schemas);
export class LinkError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export function requireThat(value, code, message) {
  if (!value) throw new LinkError(code, message);
}
export class Service {
  constructor(db, { now = () => Date.now() } = {}) {
    this.db = db;
    this.now = now;
  }
  q(sql, ...args) {
    return this.db.prepare(sql).bind(...args);
  }
  async one(sql, ...args) {
    return this.q(sql, ...args).first();
  }
  async all(sql, ...args) {
    return (await this.q(sql, ...args).all()).results;
  }
  async run(sql, ...args) {
    return this.q(sql, ...args).run();
  }
  async owned(owner, peer) {
    const p = await this.one(
      "SELECT * FROM peers WHERE id=? AND owner=?",
      peer,
      owner,
    );
    requireThat(p, "forbidden", "Peer is not owned by this account");
    return p;
  }
  async account(owner) {
    return {
      peers: (
        await this.all(
          "SELECT * FROM peers WHERE owner=? ORDER BY created",
          owner,
        )
      ).map(publicIdentity),
      subscriptions: await this.all(
        "SELECT id,peer,expires FROM subscriptions WHERE owner=? AND expires>?",
        owner,
        this.now(),
      ),
      failed_notifications: (
        await this.one(
          "SELECT count(*) AS n FROM deliveries d JOIN subscriptions s ON s.id=d.subscription WHERE s.owner=? AND d.status='failed'",
          owner,
        )
      ).n,
    };
  }
  async register(owner, args) {
    const p = identitySchema.parse(args);
    await checkIdentity(p);
    requireThat(
      await verify(p.sign, identityBytes(p), p.proof),
      "invalid_proof",
      "Invalid key possession proof",
    );
    const existing = await this.one("SELECT * FROM peers WHERE id=?", p.id);
    if (existing) {
      requireThat(
        existing.owner === owner,
        "forbidden",
        "Identity already belongs to another account",
      );
      return publicIdentity(existing);
    }
    requireThat(
      (await this.one("SELECT count(*) AS n FROM peers WHERE owner=?", owner))
        .n < 4,
      "limit",
      "At most four endpoints per account",
    );
    await this.run(
      "INSERT INTO peers(id,owner,label,box,sign,created) VALUES(?,?,?,?,?,?)",
      p.id,
      owner,
      p.label,
      p.box,
      p.sign,
      this.now(),
    );
    return publicIdentity(p);
  }
  async cleanup() {
    const now = this.now();
    await this.db.batch([
      this.q("DELETE FROM messages WHERE expires<=?", now),
      this.q("DELETE FROM invites WHERE expires<=?", now),
      this.q(
        "DELETE FROM deliveries WHERE occurred<=? OR subscription IN (SELECT id FROM subscriptions WHERE expires<=?)",
        now - MESSAGE_TTL,
        now,
      ),
      this.q("DELETE FROM subscriptions WHERE expires<=?", now),
      this.q("DELETE FROM connection_requests WHERE expires<=?", now),
    ]);
  }
  async connectionStatus(owner, requestId) {
    const request = await this.one(
      "SELECT r.* FROM connection_requests r JOIN peers p ON p.id=r.peer WHERE r.id=? AND p.owner=?",
      requestId,
      owner,
    );
    requireThat(request, "not_found", "Connection request unavailable");
    let status = request.status;
    if (request.expires <= this.now()) status = "expired";
    else if (status === "accepted") {
      const contact = await this.one(
        "SELECT a FROM contacts WHERE a=? AND b=? AND active=1 AND EXISTS(SELECT 1 FROM contacts WHERE a=? AND b=? AND active=1)",
        request.peer,
        request.other,
        request.other,
        request.peer,
      );
      status = contact ? "connected" : "waiting";
    }
    return { id: request.id, status };
  }
  async queueConnection(owner, input) {
    const a = z
      .object({
        peer_id: id,
        request_id: id,
        ciphertext: z.string().max(18000),
      })
      .strict()
      .parse(input);
    await this.owned(owner, a.peer_id);
    const bytes = unb64(a.ciphertext);
    requireThat(
      bytes.length >= 48 && bytes.length <= 12048,
      "invalid_input",
      "Invalid encrypted request size",
    );
    const old = await this.one(
      "SELECT peer FROM connection_requests WHERE id=?",
      a.request_id,
    );
    if (old) {
      requireThat(
        old.peer === a.peer_id,
        "conflict",
        "Request ID already exists",
      );
      return this.connectionStatus(owner, a.request_id);
    }
    requireThat(
      (
        await this.one(
          "SELECT count(*) AS n FROM connection_requests WHERE peer=? AND expires>?",
          a.peer_id,
          this.now(),
        )
      ).n < 20,
      "limit",
      "Too many connection requests",
    );
    await this.run(
      "INSERT OR IGNORE INTO connection_requests(id,peer,ciphertext,created,expires) VALUES(?,?,?,?,?)",
      a.request_id,
      a.peer_id,
      a.ciphertext,
      this.now(),
      this.now() + MESSAGE_TTL,
    );
    // The database binds this owner-authorized request to the selected endpoint.
    const saved = await this.one(
      "SELECT peer FROM connection_requests WHERE id=?",
      a.request_id,
    );
    requireThat(
      saved.peer === a.peer_id,
      "conflict",
      "Request ID already exists",
    );
    await this.notify(a.peer_id);
    return this.connectionStatus(owner, a.request_id);
  }
  async notify(peer) {
    const subs = await this.all(
      "SELECT id FROM subscriptions WHERE peer=? AND expires>?",
      peer,
      this.now(),
    );
    if (subs.length)
      await this.db.batch(
        subs.map((s) =>
          this.q(
            "INSERT INTO deliveries(id,subscription,peer,occurred,next) VALUES(?,?,?,?,?)",
            crypto.randomUUID(),
            s.id,
            peer,
            this.now(),
            this.now(),
          ),
        ),
      );
  }
  async call(owner, operation, input) {
    requireThat(schemas[operation], "invalid_operation", "Unknown operation");
    const a = schemas[operation].parse(input);
    const peer = await this.owned(
      owner,
      operation === "send" ? a.envelope.from : a.peer_id,
    );
    await this.cleanup();
    switch (operation) {
      case "connect.complete": {
        const request = await this.one(
          "SELECT * FROM connection_requests WHERE id=? AND peer=?",
          a.request_id,
          peer.id,
        );
        requireThat(request, "not_found", "Connection request unavailable");
        if (request.status !== "queued") {
          requireThat(
            request.status === a.status &&
              (a.status !== "accepted" || request.other === a.other),
            "conflict",
            "Connection request already processed",
          );
          return this.connectionStatus(owner, request.id);
        }
        if (a.status === "accepted") {
          requireThat(
            a.other &&
              (await this.one(
                "SELECT id FROM invites WHERE inviter=? AND acceptor=? AND receipt IS NOT NULL",
                a.other,
                peer.id,
              )),
            "invalid_input",
            "Accept the invitation before completing its request",
          );
        }
        await this.run(
          "UPDATE connection_requests SET status=?,other=?,ciphertext=NULL WHERE id=? AND peer=? AND status='queued'",
          a.status,
          a.other || null,
          a.request_id,
          peer.id,
        );
        return this.connectionStatus(owner, request.id);
      }
      case "invite.create": {
        const old = await this.one(
          "SELECT * FROM invites WHERE id=?",
          a.invite_id,
        );
        if (old) {
          requireThat(
            old.inviter === peer.id,
            "conflict",
            "Invitation already exists",
          );
          return { invite_id: old.id, expires: old.expires };
        }
        requireThat(
          (
            await this.one(
              "SELECT count(*) AS n FROM invites WHERE inviter=?",
              peer.id,
            )
          ).n < 20,
          "limit",
          "Too many active invitations",
        );
        const expires = this.now() + INVITE_TTL;
        await this.run(
          "INSERT INTO invites(id,inviter,expires) VALUES(?,?,?)",
          a.invite_id,
          peer.id,
          expires,
        );
        return { invite_id: a.invite_id, expires };
      }
      case "invite.accept": {
        const inv = await this.one(
          "SELECT * FROM invites WHERE id=? AND expires>?",
          a.invite_id,
          this.now(),
        );
        requireThat(
          inv && inv.inviter !== peer.id,
          "not_found",
          "Invitation unavailable",
        );
        requireThat(
          !inv.acceptor || inv.acceptor === peer.id,
          "consumed",
          "Invitation already accepted",
        );
        const inviter = await this.one(
          "SELECT * FROM peers WHERE id=?",
          inv.inviter,
        );
        await checkEnvelope(a.receipt, peer, inviter, this.now());
        const receipt = JSON.stringify(a.receipt);
        if (inv.acceptor) {
          requireThat(
            inv.receipt === receipt,
            "conflict",
            "Retry the original acceptance receipt",
          );
          return { pending: !inv.confirmed };
        }
        const result = await this.run(
          "UPDATE invites SET acceptor=?,receipt=? WHERE id=? AND acceptor IS NULL",
          peer.id,
          receipt,
          inv.id,
        );
        requireThat(
          result.meta.changes === 1,
          "consumed",
          "Invitation already accepted",
        );
        await this.notify(inv.inviter);
        return { pending: true };
      }
      case "invite.confirm": {
        const inv = await this.one(
          "SELECT * FROM invites WHERE id=? AND inviter=? AND acceptor=? AND expires>?",
          a.invite_id,
          peer.id,
          a.acceptor,
          this.now(),
        );
        requireThat(inv, "not_found", "Accepted invitation unavailable");
        if (inv.confirmed) return { connected: true };
        await this.db.batch([
          this.q(
            "INSERT INTO contacts(a,b,active) VALUES(?,?,1) ON CONFLICT(a,b) DO UPDATE SET active=1",
            peer.id,
            a.acceptor,
          ),
          this.q(
            "INSERT INTO contacts(a,b,active) VALUES(?,?,1) ON CONFLICT(a,b) DO UPDATE SET active=1",
            a.acceptor,
            peer.id,
          ),
          this.q("UPDATE invites SET confirmed=1 WHERE id=?", inv.id),
        ]);
        await this.notify(a.acceptor);
        return { connected: true };
      }
      case "sync": {
        const contacts = (
          await this.all(
            "SELECT p.*,c.active FROM contacts c JOIN peers p ON p.id=c.b WHERE c.a=?",
            peer.id,
          )
        ).map((p) => ({ ...publicIdentity(p), active: !!p.active }));
        const invitations = await this.all(
          "SELECT i.id,i.receipt,i.confirmed,p.id AS peer_id,p.label,p.box,p.sign FROM invites i JOIN peers p ON p.id=i.acceptor WHERE i.inviter=? AND i.receipt IS NOT NULL AND i.confirmed=0",
          peer.id,
        );
        return {
          contacts,
          connection_requests: await this.all(
            "SELECT id,ciphertext,created,expires FROM connection_requests WHERE peer=? AND status='queued' AND expires>? ORDER BY created LIMIT 20",
            peer.id,
            this.now(),
          ),
          invitations: invitations.map((i) => ({
            invite_id: i.id,
            peer: { id: i.peer_id, label: i.label, box: i.box, sign: i.sign },
            receipt: JSON.parse(i.receipt),
          })),
          messages: (
            await this.all(
              "SELECT envelope FROM messages WHERE recipient=? AND envelope IS NOT NULL AND expires>? ORDER BY created,id LIMIT 50",
              peer.id,
              this.now(),
            )
          ).map((m) => JSON.parse(m.envelope)),
        };
      }
      case "send": {
        const e = a.envelope;
        const contact = await this.one(
          "SELECT * FROM contacts WHERE a=? AND b=? AND active=1",
          e.to,
          peer.id,
        );
        requireThat(
          contact,
          "not_connected",
          "Recipient has not permitted this connection",
        );
        const recipient = await this.one(
          "SELECT * FROM peers WHERE id=?",
          e.to,
        );
        await checkEnvelope(e, peer, recipient, this.now());
        const fingerprint = await digest(encode(e));
        const old = await this.one("SELECT * FROM messages WHERE id=?", e.id);
        if (old) {
          requireThat(
            old.sender === peer.id && old.fingerprint === fingerprint,
            "conflict",
            "Message ID reused with different content",
          );
          return { id: e.id, stored: old.envelope !== null, duplicate: true };
        }
        requireThat(
          (
            await this.one(
              "SELECT count(*) AS n FROM messages WHERE sender=? AND created>?",
              peer.id,
              this.now() - 3600000,
            )
          ).n < 100,
          "limit",
          "Hourly message limit reached",
        );
        const inserted = await this.run(
          "INSERT OR IGNORE INTO messages(id,sender,recipient,envelope,fingerprint,created,expires) VALUES(?,?,?,?,?,?,?)",
          e.id,
          e.from,
          e.to,
          JSON.stringify(e),
          fingerprint,
          e.created,
          e.expires,
        );
        if (inserted.meta.changes === 0) {
          const row = await this.one("SELECT * FROM messages WHERE id=?", e.id);
          requireThat(
            row.sender === peer.id && row.fingerprint === fingerprint,
            "conflict",
            "Message ID conflict",
          );
          return { id: e.id, stored: row.envelope !== null, duplicate: true };
        }
        await this.notify(e.to);
        return { id: e.id, stored: true, duplicate: false };
      }
      case "ack": {
        if (a.message_ids.length)
          await this.db.batch(
            a.message_ids.map((mid) =>
              this.q(
                "UPDATE messages SET envelope=NULL WHERE id=? AND recipient=?",
                mid,
                peer.id,
              ),
            ),
          );
        return { acknowledged: true };
      }
      case "disconnect": {
        await this.db.batch([
          this.q(
            "UPDATE contacts SET active=0 WHERE (a=? AND b=?) OR (a=? AND b=?)",
            peer.id,
            a.other,
            a.other,
            peer.id,
          ),
          this.q(
            "UPDATE messages SET envelope=NULL WHERE (sender=? AND recipient=?) OR (sender=? AND recipient=?)",
            peer.id,
            a.other,
            a.other,
            peer.id,
          ),
        ]);
        return { disconnected: true };
      }
    }
  }
}
