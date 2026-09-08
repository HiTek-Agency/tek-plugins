import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";

test("replaced sockets cannot change the new handshake or resolve its calls", async () => {
  let server;
  class Server extends EventEmitter { constructor() { super(); server = this; } close() {} }
  class Socket extends EventEmitter {
    readyState = 1;
    sent = [];
    send(value, callback) { this.sent.push(JSON.parse(value)); callback?.(); }
    close() { this.readyState = 3; }
  }
  mock.module("ws", { namedExports: { WebSocket: { OPEN: 1 }, WebSocketServer: Server } });
  mock.module("node:fs", { namedExports: {
    ...fs, existsSync: () => true, readFileSync: () => "a".repeat(64),
    mkdirSync: () => {}, writeFileSync: () => {}, chmodSync: () => {},
  } });
  const plugin = await import("../src/index.js");
  let status;
  const tools = {};
  const events = [];
  await plugin.register({ addTool(name, tool) { tools[name] = tool; }, send(event) { events.push(event); }, addWsHandler(_name, handler) { status = handler; } });
  try {
    const old = new Socket();
    server.emit("connection", old);
    old.emit("message", JSON.stringify({ kind: "hello", extensionId: "old" }));
    const current = new Socket();
    server.emit("connection", current);
    old.emit("message", JSON.stringify({ kind: "hello", extensionId: "stale" }));
    assert.equal((await status()).connected, false);
    current.emit("message", "null");
    current.emit("message", JSON.stringify({ kind: "hello", extensionId: "new", capabilities: "malformed" }));
    assert.equal((await status()).client.extensionId, "new");
    const pending = plugin._rpc("tabs_list", {});
    const call = current.sent.find((msg) => msg.kind === "call");
    old.emit("message", JSON.stringify({ kind: "result", id: call.id, result: "wrong" }));
    current.emit("message", JSON.stringify({ kind: "result", id: call.id, result: "right" }));
    assert.equal(await pending, "right");
    const capture = tools.screenshot.execute({ tabId: 42 }, { toolCallId: "capture-42" });
    const captureCall = current.sent.at(-1);
    current.emit("message", JSON.stringify({ kind: "result", id: captureCall.id, result: { base64: "aW1hZ2U=", thumbnail: "cHJldmlldw==", width: 200, height: 100 } }));
    const result = await capture;
    assert.deepEqual(Object.keys(result).sort(), ["height", "path", "width"]);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      type: "image.generated", toolCallId: "capture-42", path: result.path,
      thumbnail: "cHJldmlldw==", provider: "chrome", model: "viewport", width: 200, height: 100,
      prompt: "Chrome screenshot (tab 42)",
    });

  } finally {
    await plugin.cleanup();
    mock.restoreAll();
  }
});
