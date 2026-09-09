import { test } from "node:test";
import assert from "node:assert/strict";

test("actual WS capture route, user popup recovery, state pushes and terminal stop share one target", async t => {
	const priorChrome = globalThis.chrome, priorWs = globalThis.WebSocket;
	t.after(() => { globalThis.chrome = priorChrome; globalThis.WebSocket = priorWs; });
	let socket, doc = false, allowCapture = false, removed = false;
	const sends = [], runtimeListeners = [], captureCalls = [], effects = [];
	class StubSocket {
		readyState = 1;
		listeners = new Map();
		constructor() { socket = this; }
		addEventListener(type, callback) { this.listeners.set(type, callback); }
		send(json) { sends.push(JSON.parse(json)); }
		close() { this.listeners.get("close")?.(); }
	}
	const listener = { addListener() {} };
	globalThis.WebSocket = StubSocket;
	globalThis.chrome = {
		storage: { local: { get: async () => ({ tek_meet_connection: { port: 52881, token: "synthetic-only" } }), set: async () => {}, remove: async()=>{removed=true;effects.push("remove-meta");} } },
		runtime: {
			onMessage: { addListener: fn => runtimeListeners.push(fn) }, onInstalled: listener, onStartup: listener,
			getURL: path => `chrome-extension://fixture/${path}`,
			sendMessage: async msg => { effects.push(msg.kind); return {ok:true}; },
		},
		alarms: { onAlarm: listener, create: async()=>effects.push("alarm"), clear: async()=>effects.push("clear") },
		offscreen: { hasDocument: async()=>doc, createDocument: async()=>{doc=true;},closeDocument: async()=>{doc=false;} },
		tabs: { get: async id => ({id,url:"https://meet.google.com/abc-defg-hij"}) },
		tabCapture: { getMediaStreamId: async args => {captureCalls.push(args);if(!allowCapture)throw new Error("Extension has not been invoked (activeTab permission)");return "synthetic-stream";} },
	};
	await import("../extension/background.js?capture-test");
	await Promise.resolve();
	const receive = message => socket.listeners.get("message")({ data: JSON.stringify(message) });
	const popup = (message, url="chrome-extension://fixture/popup.html") => new Promise(resolve => {
		for (const fn of runtimeListeners) fn(message,{url},resolve);
	});
	await receive({kind:"call",id:1,tool:"meet.start-capture",args:{tabId:7,meetingId:"abc-defg-hij"}});
	const first = sends.find(m=>m.kind==="result"&&m.id===1);
	assert.equal(first.value.ok,false);assert.equal(first.value.code,"MEET_CAPTURE_USER_GESTURE_REQUIRED");
	assert.ok(sends.some(m=>m.kind==="meet.capture.state"&&m.state==="needs-user"&&m.meetingId==="abc-defg-hij"));
	assert.equal((await popup({kind:"meet.capture.status"})).state,"needs-user");
	assert.equal((await popup({kind:"meet.start-capture",tabId:7,meetingId:"wrong-meeting"})).code,"MEET_CONFLICT");
	assert.equal((await popup({kind:"meet.start-capture",tabId:7,meetingId:"abc-defg-hij"},"https://meet.google.com/abc-defg-hij")).code,"MEET_CAPTURE_INVALID");
	allowCapture=true;
	assert.deepEqual(await popup({kind:"meet.start-capture",tabId:7,meetingId:"abc-defg-hij"}),{ok:true,meetingId:"abc-defg-hij"});
	assert.ok(sends.some(m=>m.kind==="meet.capture.state"&&m.state==="active"));
	assert.equal(effects.filter(v=>v==="start-capture").length,1);
	await receive({kind:"call",id:2,tool:"meet.stop-capture",args:{expectedMeetingId:"different"}});
	assert.equal(sends.find(m=>m.kind==="result"&&m.id===2).value.code,"MEET_CONFLICT");assert.equal(doc,true);
	await receive({kind:"call",id:3,tool:"meet.stop-capture",args:{expectedMeetingId:"abc-defg-hij"}});
	assert.equal(sends.find(m=>m.kind==="result"&&m.id===3).value.ok,true);assert.equal(doc,false);
	assert.ok(sends.some(m=>m.kind==="meet.capture.state"&&m.state==="stopped"&&m.meetingId==="abc-defg-hij"));
	assert.equal((await popup({kind:"meet.capture.status"})).meetingId,null);
	assert.equal((await popup({kind:"meet.start-capture",tabId:7,meetingId:"abc-defg-hij"})).code,"MEET_CONFLICT");
	assert.equal(captureCalls.length,2);
	assert.ok(!JSON.stringify(sends).includes("synthetic-stream"));
	assert.ok(!JSON.stringify(sends).includes("synthetic-only"));
	// Reset closes media before forgetting pairing. The old socket must not
	// reconnect or deliver a delayed capture request after reset.
	await receive({kind:"call",id:4,tool:"meet.start-capture",args:{tabId:7,meetingId:"abc-defg-hij"}});
	assert.equal(doc,true);
	const originalTimer=globalThis.setTimeout;let reconnects=0;
	globalThis.setTimeout=()=>{reconnects++;return 0;};
	try { assert.deepEqual(await popup({kind:"reset"}),{ok:true}); }
	finally { globalThis.setTimeout=originalTimer; }
	assert.equal(doc,false);assert.equal(removed,true);assert.equal(reconnects,0);
	const count=captureCalls.length;
	await receive({kind:"call",id:5,tool:"meet.start-capture",args:{tabId:7,meetingId:"abc-defg-hij"}});
	assert.equal(captureCalls.length,count);
	assert.equal((await popup({kind:"meet.capture.status"})).meetingId,null);
	await new Promise(r=>setImmediate(r)); // let the reset gate release
	let releaseWrite;const pendingWrite=new Promise(resolve=>{releaseWrite=resolve;});
	globalThis.chrome.storage.local.set=async()=>{await pendingWrite;};
	const update=popup({kind:"update-meta",meta:{port:52881,token:"synthetic-replacement"}});
	await new Promise(r=>setImmediate(r));
	const removes=effects.filter(e=>e==="remove-meta").length;
	assert.match((await popup({kind:"reset"})).error,/pairing change is still in progress/);
	assert.equal(effects.filter(e=>e==="remove-meta").length,removes);
	releaseWrite();assert.equal((await update).ok,true);

});

test("delayed bootstrap and startup pairing reads cannot reconnect an owner after popup reset/re-pair",async t=>{
	const priorChrome=globalThis.chrome,priorWs=globalThis.WebSocket;t.after(()=>{globalThis.chrome=priorChrome;globalThis.WebSocket=priorWs;});
	let releaseRead, startup, sockets=0;
	let read=new Promise(resolve=>{releaseRead=resolve;});
	const handlers=[];const listener={addListener(){}};
	globalThis.WebSocket=class {constructor(){sockets++;}addEventListener(){}close(){}};
	globalThis.chrome={storage:{local:{get:()=>read,set:async()=>{},remove:async()=>{}}},runtime:{onMessage:{addListener:fn=>handlers.push(fn)},onInstalled:listener,onStartup:{addListener:fn=>{startup=fn;}},getURL:path=>`chrome-extension://fixture/${path}`},alarms:{onAlarm:listener,clear:async()=>{}},offscreen:{hasDocument:async()=>false},tabs:{}};
	await import("../extension/background.js?bootstrap-reset-test");
	const popup=msg=>new Promise(resolve=>{for(const handler of handlers)handler(msg,{url:"chrome-extension://fixture/popup.html"},resolve);});
	assert.equal((await popup({kind:"reset"})).ok,true);
	releaseRead({tek_meet_connection:{port:52881,token:"old-fixture"}});await new Promise(r=>setImmediate(r));assert.equal(sockets,0);
	read=new Promise(resolve=>{releaseRead=resolve;});const pendingStartup=startup();
	assert.equal((await popup({kind:"update-meta",meta:{port:52882,token:"new-fixture"}})).ok,true);
	releaseRead({tek_meet_connection:{port:52881,token:"old-fixture"}});await pendingStartup;assert.equal(sockets,1);
});
