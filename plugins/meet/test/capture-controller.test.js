import { test } from "node:test";
import assert from "node:assert/strict";
import { createCaptureController } from "../extension/capture-controller.js";
import { startRequestedAudio, mountCapturePopup } from "../extension/capture-popup.js";
const args = {tabId:7,meetingId:"abc-defg-hij"};
function fixture(initialDoc = false) {
	let doc = initialDoc;
	const events = [], effects = [];
	const api = {
		tabs:{get:async id=>{effects.push("tab");return {id,url:"https://meet.google.com/abc-defg-hij"};}},
		tabCapture:{getCapturedTabs:async()=>[{tabId:7,status:"active"}],getMediaStreamId:async()=>{effects.push("stream");return "synthetic-stream";}},
		runtime:{sendMessage:async msg=>{effects.push(msg.kind);return {ok:true};}},
		alarms:{create:async()=>{effects.push("alarm");},clear:async()=>{}},
		offscreen:{closeDocument:async()=>{effects.push("close");doc=false;}},
	};
	const controller = createCaptureController({chromeApi:api,loadMeta:async()=>({fixture:true}),ensureOffscreen:async()=>{effects.push("document");doc=true;},hasOffscreen:async()=>doc,onState:s=>events.push(s),alarmName:"test",periodInMinutes:.5});
	return {controller,api,events,effects,hasDoc:()=>doc};
}
const deferred = () => {let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
test("starts exact Meet tab, publishes active only after acknowledgement, then stops and clears target", async()=>{
	const f=fixture(); assert.deepEqual(await f.controller.start(args),{ok:true,meetingId:args.meetingId});
	assert.deepEqual(f.effects, ["tab","document","tab","stream","tab","start-capture","alarm"]);
	assert.equal(f.events.at(-1).state,"active");
	assert.deepEqual(await f.controller.stop({expectedMeetingId:args.meetingId}),{ok:true});
	assert.equal(f.events.at(-1).meetingId,args.meetingId);assert.equal(f.events.at(-1).state,"stopped");
	assert.equal(f.controller.snapshot().meetingId,null);assert.equal(f.hasDoc(),false);
});
test("rejects invalid arguments and nonmatching/cross-origin tabs before capture",async()=>{
	const f=fixture();
	for(const input of [null,{}, {...args,tabId:null},{...args,meetingId:""},{...args,url:"https://example.com"}]) assert.equal((await f.controller.start(input)).ok,false);
	assert.deepEqual(f.effects,[]);
	for(const url of ["https://example.com/abc-defg-hij","https://meet.google.com.evil/abc-defg-hij","https://meet.google.com/other-meet-id","about:blank"]) {
		f.api.tabs.get=async()=>({url});assert.equal((await f.controller.start(args)).code,"MEET_CAPTURE_TARGET");
	}
	assert.ok(!f.effects.includes("stream"));
});
test("Chrome invocation denial leaves a retryable requested target without false active/alarms",async()=>{
	const f=fixture();f.api.tabCapture.getMediaStreamId=async()=>{throw new Error("Extension has not been invoked (activeTab permission)");};
	const result=await f.controller.start(args);
	assert.equal(result.ok,false);assert.equal(result.code,"MEET_CAPTURE_USER_GESTURE_REQUIRED");assert.equal(result.state,"needs-user");
	assert.equal(f.controller.snapshot().meetingId,args.meetingId);assert.equal(f.hasDoc(),false);assert.ok(!f.effects.includes("alarm"));
	f.api.tabCapture.getMediaStreamId=async()=>"synthetic-stream";
	assert.equal((await f.controller.start(args)).ok,true);assert.equal(f.events.at(-1).state,"active");
});
test("offscreen failure cleans up; a different meeting cannot replace a pending target",async()=>{
	const f=fixture();f.api.runtime.sendMessage=async()=>({ok:false,error:"not available"});
	assert.equal((await f.controller.start(args)).ok,false);assert.equal(f.hasDoc(),false);assert.equal(f.events.at(-1).state,"failed");
	assert.equal((await f.controller.start({...args,meetingId:"other-room"})).code,"MEET_CONFLICT");
});
test("stop cancels an in-flight start before media activation and rejects stale stop targets",async()=>{
	const f=fixture(),d=deferred();f.api.tabCapture.getMediaStreamId=()=>d.promise;
	const start=f.controller.start(args);await new Promise(r=>setImmediate(r));assert.equal(f.controller.snapshot().state,"starting");
	assert.equal((await f.controller.stop({expectedMeetingId:"different"})).code,"MEET_CONFLICT");
	const stop=f.controller.stop({expectedMeetingId:args.meetingId});
	assert.equal((await f.controller.start(args)).code,"MEET_BUSY");
	d.resolve("synthetic-stream");assert.equal((await start).code,"MEET_CANCELLED");assert.equal((await stop).ok,true);
	assert.ok(!f.effects.includes("start-capture"));assert.equal(f.controller.snapshot().meetingId,null);
});
test("failed cleanup retains identity, blocks replacement/start, and allows an explicit stop retry",async()=>{
	const f=fixture();await f.controller.start(args);const close=f.api.offscreen.closeDocument;f.api.offscreen.closeDocument=async()=>{throw new Error("close failed");};
	assert.equal((await f.controller.stop()).code,"MEET_CAPTURE_CLEANUP_FAILED");assert.equal(f.controller.snapshot().meetingId,args.meetingId);
	assert.equal((await f.controller.start(args)).code,"MEET_BUSY");
	f.api.offscreen.closeDocument=close;
	assert.equal((await f.controller.stop({expectedMeetingId:args.meetingId})).ok,true);
	assert.equal(f.controller.snapshot().meetingId,null);assert.equal(f.hasDoc(),false);
});
test("stop invalidates recovery so keepalive cannot resurrect capture",async()=>{
	const f=fixture();await f.controller.start(args);const d=deferred();f.api.tabCapture.getMediaStreamId=()=>d.promise;
	const recovery=f.controller.recover();await new Promise(r=>setImmediate(r));assert.equal(f.controller.snapshot().state,"starting");const stop=f.controller.stop({expectedMeetingId:args.meetingId});d.resolve("synthetic-stream");
	assert.equal((await recovery).code,"MEET_CANCELLED");assert.equal((await stop).ok,true);assert.equal(f.controller.snapshot().meetingId,null);
});
test("popup only starts the Gateway-requested meeting when its target tab is selected",async()=>{
	const calls=[];let selected=99;let state={...args,state:"needs-user"};
	const api={runtime:{sendMessage:async msg=>{calls.push(msg);return msg.kind==="meet.capture.status"?state:{ok:true};}},tabs:{query:async()=>[{id:selected}]}};
	assert.equal((await startRequestedAudio(api)).ok,false);assert.equal(calls.length,1);
	selected=7;assert.equal((await startRequestedAudio(api)).ok,true);assert.deepEqual(calls.at(-1),{kind:"meet.start-capture",...args});
	state={state:"stopped",meetingId:null,tabId:null};const count=calls.length;assert.equal((await startRequestedAudio(api)).ok,false);assert.equal(calls.length,count+1);
});

test("popup renders status without starting audio until its explicit button is clicked",async t=>{
	const elements=new Map();
	for(const id of ["capture-status","capture-message","capture-start","capture-stop"])elements.set(id,{textContent:"",disabled:false,listeners:{},addEventListener(event,fn){this.listeners[event]=fn;}});
	let state={...args,state:"needs-user"};const calls=[];
	const api={runtime:{sendMessage:async msg=>{calls.push(msg);if(msg.kind==="meet.capture.status")return state;if(msg.kind==="meet.start-capture")state={...args,state:"active"};else state={meetingId:null,tabId:null,state:"stopped"};return {ok:true};}},tabs:{query:async()=>[{id:7}]}};
	const timer=mountCapturePopup({getElementById:id=>elements.get(id)},api);t.after(()=>clearInterval(timer));
	await new Promise(r=>setImmediate(r));assert.match(elements.get("capture-status").textContent,/Chrome needs your permission/);
	assert.ok(calls.every(msg=>msg.kind==="meet.capture.status"));assert.equal(elements.get("capture-start").disabled,false);
	elements.get("capture-start").listeners.click();await new Promise(r=>setImmediate(r));
	assert.equal(calls.filter(msg=>msg.kind==="meet.start-capture").length,1);assert.match(elements.get("capture-status").textContent,/Audio capture active/);assert.equal(elements.get("capture-start").disabled,true);
	elements.get("capture-stop").listeners.click();await new Promise(r=>setImmediate(r));
	assert.equal(elements.get("capture-start").disabled,true);assert.equal(elements.get("capture-stop").disabled,true);
});

test("fresh controller closes unknown surviving offscreen media before starting a new target",async()=>{
	const f=fixture(true);assert.equal((await f.controller.start(args)).ok,true);
	assert.deepEqual(f.effects.slice(0,3),["stop-capture","close","tab"]);
});
test("active same-target request verifies Chrome still reports capture rather than trusting cached state",async()=>{
	const f=fixture();await f.controller.start(args);assert.equal((await f.controller.start(args)).ok,true);
	assert.equal(f.effects.filter(effect=>effect==="stream").length,1);
	f.api.tabCapture.getCapturedTabs=async()=>[];assert.equal((await f.controller.start(args)).ok,false);assert.equal(f.hasDoc(),false);
});
test("navigation during deferred stream acquisition cannot activate audio under the old meeting ID",async()=>{
	const f=fixture(),d=deferred();f.api.tabCapture.getMediaStreamId=()=>d.promise;
	const work=f.controller.start(args);await new Promise(r=>setImmediate(r));
	f.api.tabs.get=async()=>({url:"https://example.com/private"});d.resolve("synthetic-stream");
	assert.equal((await work).code,"MEET_CAPTURE_TARGET");assert.ok(!f.effects.includes("start-capture"));assert.equal(f.hasDoc(),false);
});
test("old target invalidation cannot stop replacement and current target invalidation clears media",async()=>{
	const f=fixture();await f.controller.start(args);const old=f.controller.owner();await f.controller.stop();await f.controller.start(args);
	await f.controller.invalidate(old);assert.equal(f.controller.snapshot().state,"active");
	await f.controller.invalidate(f.controller.owner());assert.equal(f.controller.snapshot().meetingId,null);assert.equal(f.hasDoc(),false);
});
