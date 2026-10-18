import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createIdentity,
  registration,
  seal,
  open as decrypt,
} from "../skills/dot-link/scripts/crypto.mjs";
import {
  initialize,
  invite,
  accept,
  ingest,
  send,
  inbox,
  transact,
} from "../skills/dot-link/scripts/state.mjs";
import { Service } from "../server/service.mjs";
import {
  subscribe,
  unsubscribe,
  dispatch,
  validateCallback,
  eventName,
} from "../server/events.mjs";
import { handleMcp } from "../server/mcp.mjs";

async function database() {
  const db = new DatabaseSync(":memory:");
  for (const f of (
    await readdir(new URL("../drizzle/", import.meta.url))
  ).filter((f) => f.endsWith(".sql")))
    db.exec(
      await readFile(new URL("../drizzle/" + f, import.meta.url), "utf8"),
    );
  const adapter = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              return db.prepare(sql).get(...args) || null;
            },
            async all() {
              return { results: db.prepare(sql).all(...args) };
            },
            async run() {
              const r = db.prepare(sql).run(...args);
              return { meta: { changes: Number(r.changes) } };
            },
          };
        },
      };
    },
    async batch(queries) {
      db.exec("BEGIN");
      try {
        const r = [];
        for (const q of queries) r.push(await q.run());
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { db, adapter };
}
const execute = (service, owner, request) =>
  service.call(owner, request.arguments.operation, request.arguments.input);

test("only the recipient decrypts; changes to ciphertext, sender, recipient, or time are rejected", async () => {
  const a = await createIdentity("A"),
    b = await createIdentity("B"),
    c = await createIdentity("C");
  const message = await seal(a, b, { text: "秘密の内容" });
  assert.deepEqual(await decrypt(b, a, message), { text: "秘密の内容" });
  await assert.rejects(() => decrypt(c, a, message));
  for (const patch of [
    {
      ciphertext:
        (message.ciphertext[0] === "A" ? "B" : "A") +
        message.ciphertext.slice(1),
    },
    { from: c.id },
    { to: c.id },
    { expires: message.expires + 1 },
  ])
    await assert.rejects(() => decrypt(b, a, { ...message, ...patch }));
  await assert.rejects(() => decrypt(b, a, message, message.expires + 1));
});

test("two authenticated peers pair, persist verified ciphertext, acknowledge once, and reject cross-account access", async () => {
  const { db, adapter } = await database(),
    s = new Service(adapter),
    relay = "https://example.chatgpt.site";
  const a = await initialize("Alice", relay),
    b = await initialize("Bob", relay),
    c = await initialize("Eve", relay);
  try {
    await s.register("alice", registration(a.identity));
    await s.register("bob", registration(b.identity));
    await s.register("eve", registration(c.identity));
    await assert.rejects(() => s.register("eve", registration(a.identity)));
    await assert.rejects(() =>
      s.call("eve", "sync", { peer_id: b.identity.id }),
    );
    const invitation = await invite(a);
    await execute(s, "alice", invitation.request);
    const accepted = await accept(b, invitation.invitation);
    await execute(s, "bob", accepted);
    const incoming = await s.call("alice", "sync", { peer_id: a.identity.id });
    // A forged pairing response has a valid sender key but cannot prove possession of the invitation secret.
    const forged = structuredClone(incoming);
    forged.invitations[0].receipt = await seal(b.identity, a.identity, {
      kind: "pair",
      invite_id: incoming.invitations[0].invite_id,
      secret: "forged",
      peer: b.identity,
    });
    assert.equal((await ingest(a, forged)).actions.length, 0);
    const confirmed = await ingest(a, incoming);
    assert.equal(confirmed.errors.length, 0);
    for (const action of confirmed.actions) await execute(s, "alice", action);
    await ingest(a, await s.call("alice", "sync", { peer_id: a.identity.id }));
    await ingest(b, await s.call("bob", "sync", { peer_id: b.identity.id }));
    const outbound = await send(a, b.identity.id, {
      text: "PRIVATE SENTINEL",
      thread: "example",
    });
    await execute(s, "alice", outbound);
    assert.equal((await execute(s, "alice", outbound)).duplicate, true);
    assert.equal(db.prepare("SELECT * FROM messages").all().length, 1);
    assert.ok(
      !JSON.stringify(db.prepare("SELECT * FROM messages").all()).includes(
        "PRIVATE SENTINEL",
      ),
    );
    const dir = await mkdtemp(join(tmpdir(), "dot-link-test-")),
      prior = process.env.DOT_LINK_HOME;
    process.env.DOT_LINK_HOME = dir;
    try {
      const response = await s.call("bob", "sync", { peer_id: b.identity.id });
      const ingested = await transact(async () => ({
        state: b,
        output: await ingest(b, response),
      }));
      // Before acknowledging, a new client invocation must be able to read the saved message.
      const restored = await transact(async (state) => ({
        output: await inbox(state),
      }));
      assert.equal(restored.messages[0].body.text, "PRIVATE SENTINEL");
      for (const action of ingested.actions) await execute(s, "bob", action);
      assert.equal(
        db.prepare("SELECT envelope FROM messages").get().envelope,
        null,
      );
      assert.equal((await execute(s, "alice", outbound)).stored, false);
      assert.equal(
        (await s.call("bob", "sync", { peer_id: b.identity.id })).messages
          .length,
        0,
      );
      // A valid batch can exceed a single-message input limit. Exercise the
      // actual CLI and its durable state, not only the in-memory receiver.
      for (let i = 0; i < 4; i++)
        await execute(s, "alice", await send(a, b.identity.id, "x".repeat(60000)));
      const batch = await s.call("bob", "sync", { peer_id: b.identity.id });
      const received = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("../skills/dot-link/scripts/cli.mjs", import.meta.url)), "ingest"],
        { input: JSON.stringify(batch), encoding: "utf8" },
      );
      assert.equal(received.status, 0, received.stderr);
      const result = JSON.parse(received.stdout);
      assert.deepEqual(result.errors, []);
      const persisted = await transact(async (state) => ({ output: await inbox(state) }));
      assert.equal(persisted.messages.filter((m) => typeof m.body === "string" && m.body.length === 60000).length, 4);
      for (const action of result.actions) await execute(s, "bob", action);
    } finally {
      if (prior === undefined) delete process.env.DOT_LINK_HOME;
      else process.env.DOT_LINK_HOME = prior;
      await rm(dir, { recursive: true, force: true });
    }
    const unauth = await handleMcp(
      new Request("https://example/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "link_account" },
        }),
      }),
      adapter,
    );
    assert.equal(unauth.status, 401);
    await s.call("bob", "disconnect", {
      peer_id: b.identity.id,
      other: a.identity.id,
    });
    await assert.rejects(() => execute(s, "alice", outbound));
  } finally {
    db.close();
  }
});

test("event subscription binds ownership, verifies callback, signs notifications, and keeps retry identity", async () => {
  const { db, adapter } = await database();
  let now = Date.now();
  const s = new Service(adapter, { now: () => now });
  const a = await createIdentity("A");
  await s.register("alice", registration(a));
  const secret = Buffer.alloc(32, 7),
    seen = [];
  let fail = true;
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body),
      headers = init.headers;
    const key = await crypto.subtle.importKey(
      "raw",
      secret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    assert.equal(
      await crypto.subtle.verify(
        "HMAC",
        key,
        Buffer.from(headers["webhook-signature"].slice(3), "base64"),
        new TextEncoder().encode(
          `${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${init.body}`,
        ),
      ),
      true,
    );
    if (body.type === "verification")
      return Response.json({ challenge: body.challenge });
    seen.push(body);
    return new Response("", { status: fail ? 503 : 200 });
  };
  const params = {
    name: eventName,
    arguments: { peer_id: a.id },
    delivery: {
      mode: "webhook",
      url: "https://chatgpt.com/events/test",
      secret: "whsec_" + secret.toString("base64"),
    },
  };
  try {
    assert.throws(() =>
      validateCallback("https://chatgpt.com.evil.test/callback"),
    );
    assert.throws(() => validateCallback("http://127.0.0.1/callback"));
    await assert.rejects(() => subscribe(s, "eve", params, fetcher));
    const sub = await subscribe(s, "alice", params, fetcher);
    assert.equal((await subscribe(s, "alice", params, fetcher)).id, sub.id);
    await s.notify(a.id);
    await dispatch(s, fetcher);
    now += 5000;
    fail = false;
    await dispatch(s, fetcher);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].eventId, seen[1].eventId);
    assert.deepEqual(seen[0].data, { peer_id: a.id });
    await assert.rejects(() => unsubscribe(s, "eve", params));
    await unsubscribe(s, "alice", params);
    await s.notify(a.id);
    assert.equal(db.prepare("SELECT count(*) AS n FROM deliveries").get().n, 0);
  } finally {
    db.close();
  }
});
