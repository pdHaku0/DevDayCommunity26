import { digest, encode } from "../skills/dot-link/scripts/protocol.mjs";
import { requireThat } from "./service.mjs";
export const eventName = "link.inbox_changed";
export const eventDefinition = {
  name: eventName,
  description:
    "Encrypted mail or a connection request is waiting for your registered peer. Use the dot-link skill to synchronize; the event contains no message content.",
  delivery: ["webhook"],
  inputSchema: {
    type: "object",
    properties: { peer_id: { type: "string" } },
    required: ["peer_id"],
    additionalProperties: false,
  },
  payloadSchema: {
    type: "object",
    properties: { peer_id: { type: "string" } },
    required: ["peer_id"],
    additionalProperties: false,
  },
};
export function validateCallback(value) {
  const u = new URL(value);
  // Only OpenAI-owned callback hosts are supported. Never accept arbitrary webhook destinations.
  requireThat(
    u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.hash &&
      (!u.port || u.port === "443") &&
      ["chatgpt.com", "openai.com"].some(
        (d) => u.hostname === d || u.hostname.endsWith("." + d),
      ),
    "callback_rejected",
    "Expected an HTTPS OpenAI callback URL",
  );
  return u.href;
}
function secretBytes(value) {
  requireThat(
    typeof value === "string" && /^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value),
    "invalid_secret",
    "Invalid webhook secret",
  );
  let bytes;
  try {
    bytes = Uint8Array.from(atob(value.slice(6)), (c) => c.charCodeAt(0));
  } catch {
    throw new Error("Invalid webhook secret");
  }
  requireThat(
    bytes.length >= 24 && bytes.length <= 64,
    "invalid_secret",
    "Invalid webhook secret size",
  );
  return bytes;
}
async function signedPost(subscription, event, fetcher = fetch) {
  const url = validateCallback(subscription.url),
    body = JSON.stringify(event);
  const id = event.eventId || crypto.randomUUID(),
    timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes(subscription.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  const base64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return fetcher(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
    headers: {
      "Content-Type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${base64}`,
      "X-MCP-Subscription-Id": subscription.id,
    },
    body,
  });
}
export async function subscribe(service, owner, p, fetcher = fetch) {
  requireThat(
    p?.name === eventName && p.delivery?.mode === "webhook",
    "invalid_subscription",
    "Unsupported event or delivery",
  );
  await service.owned(owner, p.arguments?.peer_id);
  const url = validateCallback(p.delivery.url);
  secretBytes(p.delivery.secret);
  const id = await digest(encode([owner, url, eventName, p.arguments.peer_id]));
  const subscription = {
    id,
    owner,
    peer: p.arguments.peer_id,
    url,
    secret: p.delivery.secret,
  };
  const challenge = crypto.randomUUID();
  let response;
  try {
    response = await signedPost(
      subscription,
      { type: "verification", challenge },
      fetcher,
    );
  } catch {
    requireThat(false, "callback_failed", "Callback verification failed");
  }
  const body = await response.json().catch(() => null);
  requireThat(
    response.ok && body?.challenge === challenge,
    "callback_failed",
    "Callback challenge failed",
  );
  requireThat(
    p.ttlMs === undefined ||
      p.ttlMs === null ||
      (Number.isSafeInteger(p.ttlMs) && p.ttlMs >= 60000),
    "invalid_ttl",
    "TTL must be at least one minute",
  );
  const expires = service.now() + Math.min(p.ttlMs ?? 86400000, 86400000);
  await service.run(
    "INSERT INTO subscriptions(id,owner,peer,url,secret,expires) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,expires=excluded.expires",
    id,
    owner,
    subscription.peer,
    url,
    subscription.secret,
    expires,
  );
  // A fresh subscription also signals mail already waiting; events are hints, sync is authoritative.
  const pending = await service.one(
    "SELECT id FROM messages WHERE recipient=? AND envelope IS NOT NULL AND expires>? LIMIT 1",
    subscription.peer,
    service.now(),
  );
  const invitation = await service.one(
    "SELECT id FROM invites WHERE inviter=? AND receipt IS NOT NULL AND confirmed=0 AND expires>? LIMIT 1",
    subscription.peer,
    service.now(),
  );
  const connection = await service.one(
    "SELECT id FROM connection_requests WHERE peer=? AND status='queued' AND expires>? LIMIT 1",
    subscription.peer,
    service.now(),
  );
  if (pending || invitation || connection)
    await service.notify(subscription.peer);
  return {
    id,
    refreshBefore: new Date(expires).toISOString(),
    cursor: null,
    truncated: false,
  };
}
export async function unsubscribe(service, owner, p) {
  requireThat(
    p?.name === eventName && p.delivery?.mode === "webhook",
    "invalid_subscription",
    "Unsupported event",
  );
  await service.owned(owner, p.arguments?.peer_id);
  const id = await digest(
    encode([
      owner,
      validateCallback(p.delivery.url),
      eventName,
      p.arguments.peer_id,
    ]),
  );
  await service.db.batch([
    service.q("DELETE FROM deliveries WHERE subscription=?", id),
    service.q("DELETE FROM subscriptions WHERE id=? AND owner=?", id, owner),
  ]);
  return {};
}
export async function dispatch(service, fetcher = fetch) {
  const jobs = await service.all(
    "SELECT d.*,s.url,s.secret,s.expires FROM deliveries d JOIN subscriptions s ON s.id=d.subscription WHERE d.status='pending' AND d.next<=? AND s.expires>? ORDER BY d.occurred LIMIT 8",
    service.now(),
    service.now(),
  );
  await Promise.all(
    jobs.map(async (job) => {
      let status = 0;
      try {
        const r = await signedPost(
          { ...job, id: job.subscription },
          {
            eventId: job.id,
            name: eventName,
            timestamp: new Date(job.occurred).toISOString(),
            data: { peer_id: job.peer },
            cursor: null,
          },
          fetcher,
        );
        status = r.status;
        await r.body?.cancel();
      } catch {}
      if (status >= 200 && status < 300) {
        await service.run("DELETE FROM deliveries WHERE id=?", job.id);
        return;
      }
      if (status === 410) {
        await service.db.batch([
          service.q(
            "DELETE FROM deliveries WHERE subscription=?",
            job.subscription,
          ),
          service.q("DELETE FROM subscriptions WHERE id=?", job.subscription),
        ]);
        return;
      }
      const attempts = job.attempts + 1;
      await service.run(
        "UPDATE deliveries SET attempts=?,next=?,status=? WHERE id=?",
        attempts,
        service.now() + Math.min(3600000, 1000 * 2 ** attempts),
        status === 413 || attempts >= 6 ? "failed" : "pending",
        job.id,
      );
    }),
  );
}
export async function drain(service, fetcher = fetch) {
  for (const delay of [0, 2000, 4000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    await dispatch(service, fetcher);
    const remaining = await service.one(
      "SELECT id FROM deliveries WHERE status='pending' LIMIT 1",
    );
    if (!remaining) break;
  }
}
