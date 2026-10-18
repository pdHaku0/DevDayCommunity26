import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
export const peers = sqliteTable(
  "peers",
  {
    id: text().primaryKey(),
    owner: text().notNull(),
    label: text().notNull(),
    box: text().notNull(),
    sign: text().notNull(),
    created: integer().notNull(),
  },
  (t) => [index("peers_owner").on(t.owner)],
);
export const invites = sqliteTable("invites", {
  id: text().primaryKey(),
  inviter: text().notNull(),
  expires: integer().notNull(),
  acceptor: text(),
  receipt: text(),
  confirmed: integer().notNull().default(0),
});
export const contacts = sqliteTable(
  "contacts",
  { a: text().notNull(), b: text().notNull(), active: integer().notNull() },
  (t) => [primaryKey({ columns: [t.a, t.b] })],
);
export const messages = sqliteTable(
  "messages",
  {
    id: text().primaryKey(),
    sender: text().notNull(),
    recipient: text().notNull(),
    envelope: text(),
    fingerprint: text().notNull(),
    created: integer().notNull(),
    expires: integer().notNull(),
  },
  (t) => [
    index("messages_recipient").on(t.recipient),
    index("messages_sender").on(t.sender),
  ],
);
export const subscriptions = sqliteTable("subscriptions", {
  id: text().primaryKey(),
  owner: text().notNull(),
  peer: text().notNull(),
  url: text().notNull(),
  secret: text().notNull(),
  expires: integer().notNull(),
});
export const deliveries = sqliteTable("deliveries", {
  id: text().primaryKey(),
  subscription: text().notNull(),
  peer: text().notNull(),
  occurred: integer().notNull(),
  attempts: integer().notNull().default(0),
  next: integer().notNull(),
  status: text().notNull().default("pending"),
});
export const connectionRequests = sqliteTable(
  "connection_requests",
  {
    id: text().primaryKey(),
    peer: text().notNull(),
    ciphertext: text(),
    created: integer().notNull(),
    expires: integer().notNull(),
    status: text().notNull().default("queued"),
    other: text(),
  },
  (t) => [index("connection_requests_peer").on(t.peer)],
);

// Federated storage is intentionally separate; legacy runtime data is never read.
export const federatedPeers = sqliteTable("f_peers", {
  id: text().primaryKey(), owner: text().notNull(), label: text().notNull(),
  box: text().notNull(), sign: text().notNull(), relay: text().notNull(), created: integer().notNull(),
}, t => [index("f_peers_owner").on(t.owner)]);
export const federatedInvites = sqliteTable("f_invites", {
  id: text().primaryKey(), inviter: text().notNull(), expires: integer().notNull(),
  acceptor: text(), receipt: text(), acceptance: text(), confirmed: integer().notNull().default(0),
});
export const federatedConnections = sqliteTable("f_connections", {
  local: text().notNull(), remote: text().notNull(), connection_id: text().notNull(),
  identity: text().notNull(), status: text().notNull(), created: integer().notNull(),
}, t => [primaryKey({columns:[t.local,t.remote,t.connection_id]}), uniqueIndex("f_connection_open").on(t.local,t.remote).where(sql`${t.status} <> 'closed'`)]);
export const federatedMessages = sqliteTable("f_messages", {
  id: text().primaryKey(), sender: text().notNull(), recipient: text().notNull(),
  connection_id: text().notNull(), envelope: text(), fingerprint: text().notNull(),
  created: integer().notNull(), expires: integer().notNull(),
}, t => [index("f_messages_recipient").on(t.recipient), index("f_messages_sender").on(t.sender)]);
export const federatedPackets = sqliteTable("f_packets", {
  id: text().notNull(), direction: text().notNull(), sender: text().notNull(),
  fingerprint: text().notNull(), created: integer().notNull(), expires: integer().notNull(),
}, t => [primaryKey({columns:[t.id,t.direction]}),index("f_packets_sender").on(t.sender,t.created)]);
export const federatedSubscriptions = sqliteTable("f_subscriptions", {
  id: text().primaryKey(), owner: text().notNull(), peer: text().notNull(),
  url: text().notNull(), secret: text().notNull(), expires: integer().notNull(),
});
export const federatedDeliveries = sqliteTable("f_deliveries", {
  id: text().primaryKey(), subscription: text().notNull(), peer: text().notNull(),
  occurred: integer().notNull(), attempts: integer().notNull().default(0),
  next: integer().notNull(), status: text().notNull().default("pending"),
});

export const updatePreferences = sqliteTable("f_update_preferences", {
  peer: text().primaryKey(),
  notified_version: integer().notNull(),
  automatic: integer().notNull().default(0),
});
export const updateSubscribers = sqliteTable("f_update_subscribers", {
  origin: text().primaryKey(),
  last_version: integer().notNull(),
  lease_until: integer().notNull().default(0),
  retry_after: integer().notNull().default(0),
});
