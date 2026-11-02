import test from "node:test";
import assert from "node:assert/strict";
import { buildProjection } from "../../src/services/scripts/external-presence/observe.mjs";

const now=1793494000000;
function fixture() {
  const ids=["ses_root1234567890","ses_child1234567890","ses_last1234567890"];
  const sessions=[
    {id:ids[0],metadata:{source:"ztop-compaction-recovery-20261031"},time_updated:now-500000,time_idle:now-490000},
    {id:ids[1],metadata:{source:"ztop-local-guard",guardParent:ids[0]},time_updated:now-250000,time_idle:now-240000},
    {id:ids[2],metadata:{source:"ztop-local-guard",guardParent:ids[1]},time_updated:now-3000,time_idle:null},
  ];
  const events=[{event:"successor_dispatched",old:ids[0],new:ids[1]},
    {event:"successor_dispatched",old:ids[1],new:ids[2]}];
  return {state:{original:ids[0],active:ids[2],phase:"watch",rotation_count:2},
    original:ids[0],events,sessions,serverVerified:true,now,ids};
}
function run(f) {
  const {ids,...args}=f;
  return buildProjection(args);
}

test("stable external identity across exact committed handoffs",()=>{
  const f=fixture();
  const x=run(f);
  assert.equal(x.status,"observed_active");
  assert.equal(x.stableExternalId,"external/mac-pro/ztop/maya-l-medium");
  assert.deepEqual(x.sessionLineage,f.ids);
  assert.equal(x.paperclipRunId,null);
  assert.equal(x.paperclipTaskCheckout,false);
  assert.equal(x.committedHandoffCount,2);
});
test("forged different-tab pointer fails without recorded handoff",()=>{
  const f=fixture();
  f.state.active="ses_stranger1234567890";
  assert.throws(()=>run(f),/committed lineage/);
});
test("native metadata must independently attest exact guardParent",()=>{
  const f=fixture();
  f.sessions[2].metadata.guardParent=f.ids[0];
  assert.throws(()=>run(f),/native successor provenance/);
});
test("duplicate, foreign or cyclic handoff receipts refuse",()=>{
  const f=fixture();
  f.events.push(f.events[1]);
  assert.throws(()=>run(f),/duplicate\/foreign/);
  const g=fixture();
  g.events[1].new=g.ids[0];
  assert.throws(()=>run(g),/cycle/);
});
test("process loss cannot be labeled running even with recent native update",()=>{
  const f=fixture();
  f.serverVerified=false;
  assert.equal(run(f).status,"unverified");
});
test("idle, stale and uncertain phase are separate from actual work",()=>{
  const f=fixture();
  f.sessions[2].time_idle=now-10;
  assert.equal(run(f).status,"idle");
  f.sessions[2].time_idle=null;
  f.sessions[2].time_updated=now-130000;
  assert.equal(run(f).status,"stale");
  f.state.phase="rotating";
  assert.equal(run(f).status,"handoff");
});
test("handoff rotation ceiling is explicitly exposed",()=>{
  const f=fixture();
  const next="ses_next1234567890";
  f.events.push({event:"successor_dispatched",old:f.ids[2],new:next});
  f.sessions.push({id:next,metadata:{source:"ztop-local-guard",guardParent:f.ids[2]},
    time_updated:now-1000,time_idle:null});
  f.state.active=next; f.state.rotation_count=3;
  const x=run(f);
  assert.equal(x.handoffLimitReached,true);
  assert.equal(x.status,"observed_active");
});
