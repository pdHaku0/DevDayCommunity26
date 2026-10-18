import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdentity, registration, seal, open as decrypt, makePacket, sign } from "../skills/dot-link/scripts/crypto.mjs";
import { initialize, invite, accept, ingest, send, inbox, transact, disconnect, retry } from "../skills/dot-link/scripts/state.mjs";
import { Service } from "../server/service.mjs";
import { subscribe, unsubscribe, dispatch, validateCallback, eventName } from "../server/events.mjs";
import { handleMcp } from "../server/mcp.mjs";
import { handleFederation } from "../server/federation.mjs";
import { publicIdentity, readInvitation, validateRelay, envelopeBytes } from "../skills/dot-link/scripts/protocol.mjs";

const ORIGIN_A = "https://a.test.chatgpt.site";
const ORIGIN_B = "https://b.test.chatgpt.site";
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
const networkFailure = (error) => {
  assert.equal(error.code, "delivery_network");
  assert.equal(error.meta.stage, "federation.transport");
  assert.equal(error.meta.retryable, true);
  return true;
};


test("endpoint cryptography rejects altered ciphertext, identity, expiry and invitation relay", async () => {
  const a = await createIdentity("A", ORIGIN_A), b = await createIdentity("B", ORIGIN_B), c = await createIdentity("C", ORIGIN_B);
  const message = await seal(a, b, { text: "秘密の内容" });
  assert.deepEqual(await decrypt(b, a, message), { text: "秘密の内容" });
  await assert.rejects(() => decrypt(c, a, message));
  for (const patch of [
    { ciphertext: (message.ciphertext[0] === "A" ? "B" : "A") + message.ciphertext.slice(1) },
    { from: c.id }, { to: c.id }, { expires: message.expires + 1 },
  ]) await assert.rejects(() => decrypt(b, a, { ...message, ...patch }));
  await assert.rejects(() => decrypt(b, a, message, message.expires + 1));
  const state = await initialize("A", ORIGIN_A), issued = await invite(state);
  await readInvitation(issued.invitation);
  await assert.rejects(() => readInvitation(issued.invitation.replace(ORIGIN_A, ORIGIN_B)));
  for (const url of ["http://a.test.chatgpt.site", "https://chatgpt.site.evil.test", "https://a.test.chatgpt.site/path", "https://a.test.chatgpt.site:444", "https://user@a.test.chatgpt.site"])
    assert.throws(() => validateRelay(url));
});

test("independent Sites pair and exchange E2EE durably; retries, owner isolation and revocation preserve trust", async () => {
  const da = await database(), db = await database();
  const databases = new Map([[ORIGIN_A, da.adapter], [ORIGIN_B, db.adapter]]);
  let loseNextKind;
  const transport = async (url, init) => {
    const target = new URL(url);
    assert.equal(target.pathname, "/api/federation");
    assert.equal(init.redirect, "manual");
    assert.equal(new Headers(init.headers).has("authorization"), false);
    const adapter = databases.get(target.origin);
    assert.ok(adapter, "Only the explicitly pinned destination is contacted");
    const response = await handleFederation(new Request(url, init), adapter, undefined, { fetcher: transport });
    const packet = JSON.parse(init.body);
    if (loseNextKind === packet.kind && response.ok) {
      loseNextKind = undefined;
      throw new Error("Simulated lost response after remote commit");
    }
    return response;
  };
  const sa = new Service(da.adapter, { origin: ORIGIN_A, fetcher: transport });
  const sb = new Service(db.adapter, { origin: ORIGIN_B, fetcher: transport });
  const a = await initialize("Alice", ORIGIN_A), b = await initialize("Bob", ORIGIN_B), c = await initialize("Eve", ORIGIN_B);
  const sync = (s, owner, state) => s.call(owner, "sync", { peer_id: state.identity.id });
  const runActions = async (s, owner, result) => {
    assert.deepEqual(result.errors, []);
    for (const request of result.actions) await execute(s, owner, request);
  };
  const receive = (origin, packet) => handleFederation(new Request(origin + "/api/federation", {
    method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-id": "alice" }, body: JSON.stringify(packet),
  }), databases.get(origin), undefined, { fetcher: transport });
  try {
    await sa.register("alice", registration(a.identity));
    await sb.register("bob", registration(b.identity));
    await sb.register("eve", registration(c.identity));
    await assert.rejects(() => sa.register("eve", registration(a.identity)));
    await assert.rejects(() => sb.register("eve", registration(a.identity)));
    await assert.rejects(() => sb.call("eve", "sync", { peer_id: b.identity.id }));
    const unauth = await handleMcp(new Request(ORIGIN_A + "/mcp", {
      method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "link_account" } }),
    }), da.adapter);
    assert.equal(unauth.status, 401);

    const invitation = await invite(a);
    await execute(sa, "alice", invitation.request);
    const accepting = await accept(b, invitation.invitation);
    loseNextKind = "accept";
    await assert.rejects(() => execute(sb, "bob", accepting), networkFailure);
    assert.deepEqual(await retry(b, accepting.arguments.input.packet.id), accepting);
    await execute(sb, "bob", accepting);
    await assert.rejects(() => execute(sb, "eve", accepting));
    const incoming = await sync(sa, "alice", a);
    assert.equal(incoming.invitations.length, 1);
    const forged = structuredClone(incoming);
    forged.invitations[0].receipt = await seal(b.identity, a.identity, {
      kind: "pair", invite_id: incoming.invitations[0].invite_id, secret: "wrong", peer: publicIdentity(b.identity),
    });
    const rejected = await ingest(a, forged);
    assert.equal(rejected.actions.length, 0);
    assert.ok(rejected.errors.length);
    const accepted = await ingest(a, incoming);
    assert.deepEqual(accepted.errors, []);
    const confirming = accepted.actions.find((r) => r.arguments.input.packet?.kind === "confirm");
    assert.ok(confirming);
    loseNextKind = "confirm";
    await assert.rejects(() => execute(sa, "alice", confirming), networkFailure);
    await execute(sa, "alice", await retry(a, confirming.arguments.input.packet.id));
    await runActions(sa, "alice", await ingest(a, await sync(sa, "alice", a)));
    await runActions(sb, "bob", await ingest(b, await sync(sb, "bob", b)));

    const outbound = await send(a, b.identity.id, { text: "PRIVATE SENTINEL" });
    const packet = outbound.arguments.input.packet;
    await assert.rejects(() => execute(sa, "eve", outbound));
    assert.equal((await receive(ORIGIN_B, { ...packet, from: { ...packet.from, relay: ORIGIN_B } })).ok, false);
    const outsider = await makePacket(c.identity, b.identity, "message", {
      connection_id: packet.body.connection_id,
      envelope: await seal(c.identity, b.identity, { kind: "message", connection_id: packet.body.connection_id, body: "intrusion" }),
    });
    assert.equal((await receive(ORIGIN_B, outsider)).ok, false);
    const moved = await makePacket({ ...a.identity, relay: ORIGIN_B }, b.identity, "message", packet.body);
    assert.equal((await receive(ORIGIN_B, moved)).ok, false);
    loseNextKind = "message";
    await assert.rejects(() => execute(sa, "alice", outbound), networkFailure);
    await execute(sa, "alice", await retry(a, packet.id));
    const bobIncoming = await sync(sb, "bob", b);
    assert.equal(bobIncoming.messages.length, 1);
    assert.ok(!JSON.stringify(bobIncoming).includes("PRIVATE SENTINEL"));

    const dir = await mkdtemp(join(tmpdir(), "dot-link-federation-")), prior = process.env.DOT_LINK_HOME;
    process.env.DOT_LINK_HOME = dir;
    try {
      const received = await transact(async () => ({ state: b, output: await ingest(b, bobIncoming) }));
      const restored = await transact(async (state) => ({ output: await inbox(state) }));
      assert.equal(restored.messages[0].body.text, "PRIVATE SENTINEL");
      await runActions(sb, "bob", received);
      await execute(sa, "alice", outbound);
      assert.equal((await sync(sb, "bob", b)).messages.length, 0, "Acknowledged ciphertext must never be resurrected by retry");
      const replacement = await seal(a.identity, b.identity, { kind: "message", connection_id: packet.body.connection_id, body: "replacement" });
      replacement.id = packet.body.envelope.id;
      replacement.signature = sign(a.identity, envelopeBytes(replacement));
      const collision = await makePacket(a.identity, b.identity, "message", { connection_id: packet.body.connection_id, envelope: replacement });
      assert.equal((await receive(ORIGIN_B, collision)).ok, false, "An acknowledged ID cannot be reused for different signed ciphertext");
    } finally {
      if (prior === undefined) delete process.env.DOT_LINK_HOME; else process.env.DOT_LINK_HOME = prior;
      await rm(dir, { recursive: true, force: true });
    }
    const reply = await send(b, a.identity.id, { text: "PRIVATE REPLY" });
    await execute(sb, "bob", reply);
    await runActions(sa, "alice", await ingest(a, await sync(sa, "alice", a)));
    assert.equal((await inbox(a)).messages[0].body.text, "PRIVATE REPLY");

    const closed = await disconnect(b, a.identity.id);
    loseNextKind = "disconnect";
    await assert.rejects(() => execute(sb, "bob", closed), networkFailure);
    await execute(sb, "bob", await retry(b, closed.arguments.input.packet.id));
    await assert.rejects(() => execute(sa, "alice", outbound));
    assert.equal((await receive(ORIGIN_B, packet)).ok, false);
    assert.equal((await receive(ORIGIN_B, confirming.arguments.input.packet)).ok, false);
    await assert.rejects(() => execute(sa, "alice", confirming));
    await runActions(sa, "alice", await ingest(a, await sync(sa, "alice", a)));
    const newInvitation = await invite(a);
    await execute(sa, "alice", newInvitation.request);
    await execute(sb, "bob", await accept(b, newInvitation.invitation));
    await runActions(sa, "alice", await ingest(a, await sync(sa, "alice", a)));
    await runActions(sa, "alice", await ingest(a, await sync(sa, "alice", a)));
    await runActions(sb, "bob", await ingest(b, await sync(sb, "bob", b)));
    await execute(sa, "alice", await send(a, b.identity.id, { text: "new consent" }));
    assert.equal((await sync(sb, "bob", b)).messages.length, 1);
    assert.equal((await receive(ORIGIN_B, confirming.arguments.input.packet)).ok, false, "Old confirmation cannot attach to the new connection");
  } finally { da.db.close(); db.db.close(); }
});

test("MCP diagnostics separate transport failures without reflecting remote bodies or secrets", async (t) => {
  const { db, adapter } = await database();
  const a = await initialize("Alice", ORIGIN_A), b = await initialize("Bob", ORIGIN_B);
  const accepting = await accept(b, (await invite(a)).invitation);
  await new Service(adapter, { origin: ORIGIN_B }).register("bob", registration(b.identity));
  const secret = a.identity.signSecret, sentinel = "REMOTE_PRIVATE_SENTINEL", logs = [];
  t.mock.method(console, "warn", (line) => logs.push(line));
  const remoteRequestId = crypto.randomUUID();
  const cases = [
    [403, () => Response.json({ ok: false, error: { code: "not_connected", message: sentinel + secret, request_id: remoteRequestId } }, { status: 403 }), "delivery_http_error", false],
    [503, () => Response.json({ ok: false, error: { code: secret, message: sentinel, request_id: secret } }, { status: 503 }), "delivery_remote_unavailable", true],
    [200, () => new Response(sentinel + secret), "delivery_invalid_response", true],
    [200, () => new Response((sentinel + secret).repeat(200)), "delivery_response_too_large", true],
    [302, () => new Response(sentinel + secret, { status: 302, headers: { location: "https://outside.example/" } }), "delivery_redirect", false],
  ];
  const requestIds = new Set();
  try {
    for (const [status, respond, code, retryable] of cases) {
      let fetches = 0;
      const response = await handleMcp(new Request(ORIGIN_B + "/mcp", {
        method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-id": "bob" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "link_exchange", arguments: accepting.arguments } }),
      }), adapter, undefined, { fetcher: async () => { fetches++; return respond(); } });
      const rpc = await response.json();
      assert.equal(rpc.result.isError, true);
      const body = JSON.parse(rpc.result.content[0].text), error = body.error;
      assert.deepEqual(rpc.result.structuredContent, body);
      assert.equal(error.code, code);
      assert.equal(error.stage, "federation.transport");
      assert.equal(error.retryable, retryable);
      assert.equal(error.remote_status, status);
      assert.match(error.request_id, /^[0-9a-f-]{36}$/i);
      requestIds.add(error.request_id);
      assert.equal(fetches, 1, "A redirect must never be followed");
      if (status === 403) {
        assert.equal(error.remote_code, "not_connected");
        assert.equal(error.remote_request_id, remoteRequestId);
      } else {
        assert.equal(error.remote_code, undefined);
        assert.equal(error.remote_request_id, undefined);
      }
      const exposed = JSON.stringify([rpc, logs]);
      assert.ok(!exposed.includes(sentinel));
      assert.ok(!exposed.includes(secret));
      assert.ok(logs.some(line => JSON.parse(line).request_id === error.request_id));
    }
    assert.equal(requestIds.size, cases.length);
  } finally { db.close(); }
});

test("event subscription binds ownership, verifies callback, signs notifications, and keeps retry identity", async () => {
  const { db, adapter } = await database();
  let now = Date.now();
  const s = new Service(adapter, { origin: ORIGIN_A, now: () => now });
  const a = await createIdentity("A", ORIGIN_A);
  await s.register("alice", registration(a));
  const secret = Buffer.alloc(32, 7),
    seen = [];
  let fail = true, arriveDuringDelivery = false;
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
    if (arriveDuringDelivery) {
      arriveDuringDelivery = false;
      await s.notify(a.id); // A new arrival after the current event started processing.
    }
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
    arriveDuringDelivery = true;
    await s.notify(a.id);
    await dispatch(s, fetcher);
    assert.equal(db.prepare("SELECT count(*) AS n FROM f_deliveries").get().n, 1,
      "Completing an in-flight notification must retain a concurrent arrival");
    await dispatch(s, fetcher);
    assert.notEqual(seen[2].eventId, seen[3].eventId);
    assert.equal(db.prepare("SELECT count(*) AS n FROM f_deliveries").get().n, 0);
    await assert.rejects(() => unsubscribe(s, "eve", params));
    await unsubscribe(s, "alice", params);
    await s.notify(a.id);
    assert.equal(db.prepare("SELECT count(*) AS n FROM f_deliveries").get().n, 0);
  } finally {
    db.close();
  }
});
