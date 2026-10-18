import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import { subscribe, dispatch, eventName } from "../server/events.mjs";
import { Service } from "../server/service.mjs";
import { createIdentity, registration } from "../skills/dot-link/scripts/crypto.mjs";
import { handleUpdates, updateNotice, PUBLISHER, REPOSITORY, RELEASE } from "../server/updates.mjs";
async function database() {
  const db = new DatabaseSync(":memory:");
  for (const f of (await readdir(new URL("../drizzle/", import.meta.url))).filter(f => f.endsWith(".sql")).sort()) db.exec(await readFile(new URL("../drizzle/" + f, import.meta.url), "utf8"));
  const adapter = {
    prepare(sql) { return { bind(...args) { return {
      async first() { return db.prepare(sql).get(...args) || null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
    }; } }; },
    async batch(queries) { db.exec("BEGIN"); try { const r=[]; for(const q of queries)r.push(await q.run()); db.exec("COMMIT"); return r; } catch(e) {db.exec("ROLLBACK");throw e;} },
  };
  return { db, adapter };
}
const personal = "https://member.test.chatgpt.site";
const manifest = version => ({version,repository:REPOSITORY});
const post = (origin,path,body={}) => new Request(origin+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
test("registered endpoints automatically subscribe, persist success, safely retry failure and receive trusted releases", async t=>{
  const dp=await database(),dm=await database(),sites=new Map();
  let now=Date.now(),version=RELEASE.version,installed=RELEASE.version,failNotify=false,subscribeCalls=0,failSubscribe=true,evilManifest=false;
  t.mock.method(console,"warn",()=>{});
  const transport=async(url,init)=>{
    const target=new URL(url); assert.ok([PUBLISHER,personal].includes(target.origin)); assert.equal(init.redirect,"manual"); assert.equal(new Headers(init.headers).has("authorization"),false);
    if(target.pathname==="/api/updates/subscribe"){subscribeCalls++;if(failSubscribe)throw new Error("SECRET_SENTINEL");}
    if(target.pathname==="/api/updates/notify"&&failNotify)throw new Error("SECRET_SENTINEL");
    if(evilManifest&&target.pathname==="/api/updates/release")return Response.json({version:999,repository:"https://evil.test/SECRET_SENTINEL"});
    return handleUpdates(new Request(url,init),sites.get(target.origin),{release:manifest(target.origin===PUBLISHER?version:installed)});
  };
  const central=new Service(dp.adapter,{origin:PUBLISHER,fetcher:transport,now:()=>now}), member=new Service(dm.adapter,{origin:personal,fetcher:transport,now:()=>now});sites.set(PUBLISHER,central);sites.set(personal,member);
  const peer=await createIdentity("member",personal);
  const registered=await member.register("owner",registration(peer));
  assert.equal(registered.update_registration_error.code,"delivery_network");
  assert.equal((await member.account("owner")).update_registration_errors.length,1);
  failSubscribe=false;
  const sync=()=>member.call("owner","sync",{peer_id:peer.id});
  assert.equal((await sync()).update_registration.registered,true);
  assert.equal((await member.account("owner")).update_registration_errors.length,0);
  const calls=subscribeCalls;await sync();assert.equal(subscribeCalls,calls,"Successful registration is persisted; sync does not poll publisher");
  // Existing endpoints are enrolled on their first sync after upgrading.
  await member.run("DELETE FROM f_update_preferences WHERE peer=?",peer.id);
  assert.equal((await sync()).update_registration.registered,true);assert.equal(subscribeCalls,calls+1);
  await member.run("INSERT INTO f_subscriptions(id,owner,peer,url,secret,expires) VALUES(?,?,?,?,?,?)","subscription","owner",peer.id,"https://chatgpt.com/callback","whsec_"+Buffer.alloc(32,8).toString("base64"),now+86400000);
  const publish=async()=> (await handleUpdates(post(PUBLISHER,"/api/updates/publish"),central,{release:manifest(version)})).json();
  version++;failNotify=true;const failed=await publish();assert.equal(failed.failed,1);assert.equal(failed.complete,false);assert.ok(!JSON.stringify(failed).includes("SECRET_SENTINEL"));
  assert.equal((await publish()).attempted,0);failNotify=false;now+=60001;assert.equal((await publish()).delivered,1);
  assert.deepEqual(await updateNotice(member,peer.id),{version,repository:REPOSITORY,installed_version:RELEASE.version});
  await handleUpdates(post(personal,"/api/updates/notify"),member);await handleUpdates(post(personal,"/api/updates/notify"),member);
  assert.equal((await member.one("SELECT count(*) AS n FROM f_deliveries")).n,1);
  for(const body of [{version:999},{message:"SECRET_SENTINEL"},{url:"https://evil.test"}]){const r=await handleUpdates(post(personal,"/api/updates/notify",body),member);assert.equal(r.status,400);assert.ok(!(await r.text()).includes("SECRET_SENTINEL"));}
  evilManifest=true;const bad=await handleUpdates(post(personal,"/api/updates/notify"),member);assert.equal(bad.status,400);assert.ok(!(await bad.text()).includes("SECRET_SENTINEL"));evilManifest=false;
  assert.equal((await handleUpdates(post(personal,"/api/updates/publish"),member)).status,403);
  installed=version;now+=60001;const applied=await publish();assert.equal(applied.updated,1);assert.equal(applied.complete,true);
  version++;now+=60001;await member.unregister("owner",peer.id);
  assert.equal((await member.one("SELECT count(*) AS n FROM f_update_preferences")).n,0);assert.equal((await publish()).removed,1);
  dp.db.close();dm.db.close();
});

test("late Event subscription recovers a pending release and transient callbacks remain retryable", async t => {
  const {db,adapter}=await database();
  let now=Date.now();
  const latest=manifest(RELEASE.version+1);
  const member=new Service(adapter,{origin:personal,now:()=>now,fetcher:async url =>
    Response.json(new URL(url).pathname.endsWith("/release") ? latest : {ok:true})});
  const peer=await createIdentity("late subscriber",personal);
  t.mock.method(console,"warn",()=>{});
  try {
    await member.register("owner",registration(peer));
    assert.equal((await member.one("SELECT count(*) AS n FROM f_deliveries")).n,0);
    const params={name:eventName,arguments:{peer_id:peer.id},delivery:{mode:"webhook",url:"https://chatgpt.com/events/updates",secret:"whsec_"+Buffer.alloc(32,4).toString("base64")}};
    await subscribe(member,"owner",params,async(_url,init)=>Response.json({challenge:JSON.parse(init.body).challenge}));
    assert.equal((await member.one("SELECT count(*) AS n FROM f_deliveries")).n,1,"A newly subscribed Dot must be told about the already-stored release");
    const delivery=(await member.one("SELECT id FROM f_deliveries")).id;
    for(let i=0;i<6;i++) {await dispatch(member,async()=>new Response("",{status:503}));now+=3600000;}
    assert.equal((await member.one("SELECT status FROM f_deliveries WHERE id=?",delivery)).status,"pending");
    await dispatch(member,async()=>new Response("",{status:200}));
    assert.equal((await member.one("SELECT count(*) AS n FROM f_deliveries")).n,0);
  } finally {db.close();}
});
