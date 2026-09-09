import { test } from "node:test";
import assert from "node:assert/strict";
import { observeCaptureTarget } from "../extension/capture-guards.js";
function fixture(){
	let owner={revision:1,tabId:7,meetingId:"abc-defg-hij"};const invalidations=[];const listeners={};
	const api={tabs:{get:async()=>({url:"https://meet.google.com/abc-defg-hij"}),onUpdated:{addListener:fn=>{listeners.updated=fn;}},onRemoved:{addListener:fn=>{listeners.removed=fn;}}},tabCapture:{getCapturedTabs:async()=>[{tabId:7,status:"active"}],onStatusChanged:{addListener:fn=>{listeners.status=fn;}}}};
	observeCaptureTarget(api,{owner:()=>owner,isCleaning:()=>false,invalidate:async expected=>{if(expected.revision===owner.revision)invalidations.push(expected);}});
	return {api,listeners,invalidations,replace:()=>{owner={...owner,revision:2};}};
}
test("queued old navigation cannot invalidate a currently valid replacement room",async()=>{
	const f=fixture();await f.listeners.updated(7,{url:"https://example.com/old"});assert.deepEqual(f.invalidations,[]);
	f.api.tabs.get=async()=>({url:"https://example.com/current"});await f.listeners.updated(7,{});assert.equal(f.invalidations.length,1);
});
test("pending departure invalidates owned room, while unrelated tab updates do not",async()=>{
	const f=fixture();f.api.tabs.get=async()=>({url:"https://meet.google.com/abc-defg-hij",pendingUrl:"https://example.com"});
	await f.listeners.updated(99,{});assert.equal(f.invalidations.length,0);await f.listeners.updated(7,{});assert.equal(f.invalidations.length,1);
});
test("replacement during a delayed tab read is fenced, and capture-ended rechecks live Chrome state",async()=>{
	const f=fixture();let release;f.api.tabs.get=()=>new Promise(resolve=>{release=resolve;});const update=f.listeners.updated(7,{});f.replace();release({url:"https://example.com"});await update;assert.deepEqual(f.invalidations,[]);
	await f.listeners.status({tabId:7,status:"stopped"});assert.deepEqual(f.invalidations,[]);
	f.api.tabCapture.getCapturedTabs=async()=>[];await f.listeners.status({tabId:7,status:"error"});assert.equal(f.invalidations.length,1);
});
