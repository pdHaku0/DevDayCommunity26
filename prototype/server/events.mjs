import { updateNotice } from "./updates.mjs";
import { LinkError, diagnostic, responseJson, transportFailure } from "./errors.mjs";
import { digest, encode } from "../skills/dot-link/scripts/protocol.mjs";
import { requireThat } from "./service.mjs";
export const eventName = "link.inbox_changed";
export const eventDefinition = {
  name: eventName,
  description:
    "Encrypted mail, a connection request, or a software update is waiting for your registered peer. Read the bundled dot-link skill at skill://dot-link/dot-link/SKILL.md, synchronize this endpoint, and follow its update instructions; the event contains no message content.",
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
    redirect: "manual",
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
  } catch (error) {
    throw transportFailure(error, "events.verify", "callback");
  }
  if (!response.ok) {
    await response.body?.cancel();
    const redirect = response.status >= 300 && response.status < 400;
    throw new LinkError(redirect ? "callback_redirect" : "callback_http_error", "Event callback verification returned an HTTP error", {
      stage:"events.verify",retryable:response.status === 408 || response.status === 429 || response.status >= 500,remote_status:response.status,
    });
  }
  let body;
  try {body = await responseJson(response,{stage:"events.verify",prefix:"callback"});}
  catch (error) {throw transportFailure(error,"events.verify","callback");}
  if (body?.challenge !== challenge)
    throw new LinkError("callback_no_echo", "Event callback did not echo the verification challenge", {stage:"events.verify",retryable:false,remote_status:response.status});
  requireThat(
    p.ttlMs === undefined ||
      p.ttlMs === null ||
      (Number.isSafeInteger(p.ttlMs) && p.ttlMs >= 60000),
    "invalid_ttl",
    "TTL must be at least one minute",
  );
  const expires = service.now() + Math.min(p.ttlMs ?? 86400000, 86400000);
  await service.run(
    "INSERT INTO f_subscriptions(id,owner,peer,url,secret,expires) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM f_peers WHERE id=? AND owner=?) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,expires=excluded.expires",
    id,
    owner,
    subscription.peer,
    url,
    subscription.secret,
    expires,
    subscription.peer,
    owner,
  );
  requireThat(await service.one("SELECT id FROM f_subscriptions WHERE id=? AND owner=?", id, owner), "not_found", "Endpoint was removed during subscription verification");
  // A fresh subscription also signals mail already waiting; events are hints, sync is authoritative.
  const pending = await service.one(
    "SELECT id FROM f_messages WHERE recipient=? AND envelope IS NOT NULL AND expires>? LIMIT 1",
    subscription.peer,
    service.now(),
  );
  const invitation = await service.one(
    "SELECT id FROM f_invites WHERE inviter=? AND receipt IS NOT NULL AND confirmed=0 AND expires>? LIMIT 1",
    subscription.peer,
    service.now(),
  );
  const update = await updateNotice(service, subscription.peer);
  if (pending || invitation || update) await service.notify(subscription.peer);
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
    service.q("DELETE FROM f_deliveries WHERE subscription=?", id),
    service.q("DELETE FROM f_subscriptions WHERE id=? AND owner=?", id, owner),
  ]);
  return {};
}
export async function dispatch(service, fetcher = fetch) {
  const jobs = await service.all(
    "SELECT d.*,s.url,s.secret,s.expires FROM f_deliveries d JOIN f_subscriptions s ON s.id=d.subscription WHERE d.status='pending' AND d.next<=? AND s.expires>? ORDER BY d.occurred LIMIT 8",
    service.now(),
    service.now(),
  );
  await Promise.all(
    jobs.map(async (job) => {
      let status = 0, failure;
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
      } catch (error) {failure = transportFailure(error,"events.delivery","callback");}
      if (status >= 200 && status < 300) {
        await service.run("DELETE FROM f_deliveries WHERE id=?", job.id);
        return;
      }
      failure ||= new LinkError(status >= 300 && status < 400 ? "callback_redirect" : "callback_http_error", "Event delivery returned an HTTP error", {
        stage:"events.delivery",retryable:status === 408 || status === 429 || status >= 500,remote_status:status,
      });
      diagnostic(failure,service.requestId,"events.delivery",status || 502);
      if (status === 410) {
        await service.db.batch([
          service.q(
            "DELETE FROM f_deliveries WHERE subscription=?",
            job.subscription,
          ),
          service.q("DELETE FROM f_subscriptions WHERE id=?", job.subscription),
        ]);
        return;
      }
      const attempts = job.attempts + 1;
      await service.run(
        "UPDATE f_deliveries SET attempts=?,next=?,status=? WHERE id=?",
        attempts,
        service.now() + Math.min(3600000, 1000 * 2 ** attempts),
        status === 413 ? "failed" : "pending",
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
      "SELECT id FROM f_deliveries WHERE status='pending' LIMIT 1",
    );
    if (!remaining) break;
  }
}
