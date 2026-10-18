import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
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
