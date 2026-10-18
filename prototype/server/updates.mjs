import releaseFile from "../release.json" with { type: "json" };
import { validateRelay } from "../skills/dot-link/scripts/protocol.mjs";
import { LinkError, diagnostic, responseJson, transportFailure } from "./errors.mjs";

export const PUBLISHER = "https://devday-dot-link.pdhaku0.chatgpt.site";
export const REPOSITORY = "https://github.com/pdHaku0/DevDayCommunity26/tree/prototype/dot-link";
export const RELEASE = Object.freeze(releaseFile);
const BATCH = 8, MAX_SUBSCRIBERS = 256, LEASE_MS = 30000, RETRY_MS = 60000;
const json = (value, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
function requireValue(ok, code, message) { if (!ok) throw new LinkError(code, message, { retryable: false }); }
function exact(value, keys) {
  requireValue(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === keys.split(",").filter(Boolean).sort().join(","), "invalid_input", "Invalid update request fields");
}
function releaseValue(value) {
  exact(value, "version,repository");
  requireValue(Number.isSafeInteger(value.version) && value.version >= 0 && value.repository === REPOSITORY,
    "invalid_input", "Invalid release manifest");
  return { version: value.version, repository: REPOSITORY };
}
async function readBody(request) {
  requireValue(request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json",
    "unsupported_media_type", "Expected application/json");
  try { return await responseJson(new Response(request.body), { stage: "updates.request", prefix: "delivery", maxBytes: 8192 }); }
  catch { throw new LinkError("invalid_json", "Invalid or oversized update request", { retryable: false }); }
}
async function remote(service, origin, path, method = "GET", body) {
  validateRelay(origin);
  const signal = AbortSignal.timeout(8000);
  try {
    const response = await service.fetcher(origin + path, {
      method, redirect: "manual", signal, headers: { "Accept": "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 410) { await response.body?.cancel(); return { gone: true }; }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new LinkError("delivery_redirect", "Update endpoint redirected", { retryable: false, remote_status: response.status });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new LinkError("delivery_http_error", "Update endpoint did not confirm delivery", { retryable: true, remote_status: response.status });
    }
    return await responseJson(response, { stage: "updates.transport", prefix: "delivery", maxBytes: 8192 });
  } catch (error) { throw transportFailure(error, "updates.transport", "delivery", signal); }
}
async function enabled(service) {
  return !!await service.one("SELECT id FROM f_peers LIMIT 1");
}
export async function updateNotice(service, peerId, { release = RELEASE } = {}) {
  const current = releaseValue(release);
  const row = await service.one("SELECT p.notified_version FROM f_update_preferences p JOIN f_peers k ON k.id=p.peer WHERE p.peer=?", peerId);
  return row && row.notified_version > current.version
    ? { version: row.notified_version, repository: REPOSITORY, installed_version: current.version } : null;
}
async function applyNotice(service, latest, installed) {
  if (latest.version <= installed.version) return 0;
  const now = service.now();
  // Queue and advance the marker in one transaction: a crash cannot lose or duplicate a release notification.
  const results = await service.db.batch([
    service.q("INSERT INTO f_deliveries(id,subscription,peer,occurred,next) SELECT lower(hex(randomblob(16))),s.id,s.peer,?,? FROM f_subscriptions s JOIN f_peers k ON k.id=s.peer JOIN f_update_preferences p ON p.peer=s.peer WHERE s.expires>? AND p.notified_version<?", now, now, now, latest.version),
    service.q("UPDATE f_update_preferences SET notified_version=? WHERE notified_version<? AND EXISTS(SELECT 1 FROM f_peers k WHERE k.id=f_update_preferences.peer)", latest.version, latest.version),
  ]);
  return results[1]?.meta?.changes ?? 0;
}
export async function ensureUpdates(service,peerId) {
  try {
    await service.run("INSERT INTO f_update_preferences(peer,notified_version) SELECT id,? FROM f_peers WHERE id=? ON CONFLICT(peer) DO NOTHING",RELEASE.version,peerId);
    const state=await service.one("SELECT publisher_registered FROM f_update_preferences WHERE peer=?",peerId);
    if (!state || state.publisher_registered === 1) return null;
    const subscribed=await remote(service,PUBLISHER,"/api/updates/subscribe","POST",{origin:service.origin});
    requireValue(subscribed.ok === true,"delivery_remote_rejected","Update registration was not confirmed");
    const latest=releaseValue(await remote(service,PUBLISHER,"/api/updates/release"));
    await applyNotice(service,latest,RELEASE);
    await service.run("UPDATE f_update_preferences SET publisher_registered=1,registration_error=NULL WHERE peer=?",peerId);
    return null;
  } catch(error) {
    const detail=diagnostic(error,service.requestId,"updates.transport",502);
    const safe={code:detail.code,stage:detail.stage,retryable:detail.retryable,request_id:detail.request_id};
    await service.run("UPDATE f_update_preferences SET registration_error=? WHERE peer=?",JSON.stringify(safe),peerId);
    return safe;
  }
}
async function publish(service, current) {
  const candidates = await service.all("SELECT origin FROM f_update_subscribers WHERE last_version<? AND lease_until<=? AND retry_after<=? ORDER BY origin LIMIT ?", current.version, service.now(), service.now(), BATCH);
  const results = await Promise.all(candidates.map(async ({ origin }) => {
    const now = service.now(), lease = now + LEASE_MS;
    const claimed = await service.one("UPDATE f_update_subscribers SET lease_until=? WHERE origin=? AND last_version<? AND lease_until<=? AND retry_after<=? RETURNING origin", lease, origin, current.version, now, now);
    if (!claimed) return "skipped";
    try {
      const result = await remote(service, origin, "/api/updates/notify", "POST", {});
      if (result.gone) {
        await service.run("DELETE FROM f_update_subscribers WHERE origin=? AND lease_until=?", origin, lease);
        return "removed";
      }
      requireValue(result.ok === true, "delivery_remote_rejected", "Update delivery was not confirmed");
      // Site receipt and Dot execution are different. Keep revisiting until the
      // destination's deployed release confirms the update actually completed.
      const target = await remote(service,origin,"/api/updates");
      exact(target,"enabled,installed_version");
      requireValue(typeof target.enabled === "boolean" && Number.isSafeInteger(target.installed_version) && target.installed_version >= 0,"delivery_invalid_response","Invalid destination release status");
      if (target.installed_version >= current.version) {
        await service.run("UPDATE f_update_subscribers SET last_version=?,lease_until=0,retry_after=0 WHERE origin=? AND lease_until=?", current.version, origin, lease);
        return "updated";
      }
      await service.run("UPDATE f_update_subscribers SET lease_until=0,retry_after=? WHERE origin=? AND lease_until=?",service.now()+RETRY_MS,origin,lease);
      return "notified";
    } catch (error) {
      await service.run("UPDATE f_update_subscribers SET lease_until=0,retry_after=? WHERE origin=? AND lease_until=?", service.now() + RETRY_MS, origin, lease);
      diagnostic(error, service.requestId, "updates.delivery", 502);
      return "failed";
    }
  }));
  const count = kind => results.filter(value => value === kind).length;
  const remaining = (await service.one("SELECT count(*) AS n FROM f_update_subscribers WHERE last_version<?", current.version)).n;
  return { ok: count("failed") === 0, version: current.version, attempted: results.length - count("skipped"), delivered: count("notified") + count("updated"), updated: count("updated"), awaiting_update: count("notified"), removed: count("removed"), failed: count("failed"), remaining, complete: remaining === 0 };
}
export async function handleUpdates(request, service, { release = RELEASE } = {}) {
  try {
    const current = releaseValue(release), url = new URL(request.url), path = url.pathname;
    requireValue(url.origin === service.origin && !url.search, "invalid_input", "Invalid update endpoint");
    if (request.method === "GET" && path === "/api/updates") return json({ enabled: await enabled(service), installed_version: current.version });
    if (request.method === "GET" && path === "/api/updates/release") return json(current);
    requireValue(request.method === "POST", "method_not_allowed", "Expected POST");
    const body = await readBody(request);
    if (path === "/api/updates/notify") {
      exact(body, "");
      if (!await enabled(service)) return json({ ok: false, enabled: false }, 410);
      // Caller input cannot select a publisher, version, URL, or message.
      const latest = releaseValue(await remote(service, PUBLISHER, "/api/updates/release"));
      const notified = await applyNotice(service, latest, current);
      return json({ ok: true, notified });
    }
    requireValue(service.origin === PUBLISHER, "forbidden", "Only the pinned publisher accepts subscriptions or publication");
    if (path === "/api/updates/subscribe") {
      exact(body, "origin");
      const origin = validateRelay(body.origin);
      requireValue(origin === body.origin, "invalid_input", "Expected a canonical Site origin");
      const target = await remote(service, origin, "/api/updates");
      exact(target, "enabled,installed_version");
      requireValue(target.enabled === true && Number.isSafeInteger(target.installed_version) && target.installed_version >= 0, "forbidden", "The target Site has no registered endpoints");
      await service.run("INSERT INTO f_update_subscribers(origin,last_version) SELECT ?,? WHERE (SELECT count(*) FROM f_update_subscribers)<? OR EXISTS(SELECT 1 FROM f_update_subscribers WHERE origin=?) ON CONFLICT(origin) DO UPDATE SET last_version=max(f_update_subscribers.last_version,excluded.last_version)", origin, Math.min(target.installed_version, current.version), MAX_SUBSCRIBERS, origin);
      requireValue(await service.one("SELECT origin FROM f_update_subscribers WHERE origin=?", origin), "limit", "Update subscriber limit reached");
      return json({ ok: true });
    }
    if (path === "/api/updates/publish") { exact(body, ""); return json(await publish(service, current)); }
    throw new LinkError("not_found", "Unknown update endpoint", { retryable: false });
  } catch (error) {
    const status = error instanceof LinkError ? error.code === "forbidden" ? 403 : error.code === "not_found" ? 404 : error.code.startsWith("delivery_") ? 502 : 400 : 400;
    return json({ ok: false, error: diagnostic(error, service.requestId, "updates.request", status) }, status);
  }
}
