# Capture dispatch and manual Chrome invocation

Gateway `meet.start-capture {tabId,meetingId}` and `meet.stop-capture {expectedMeetingId?}` now route through the extension's actual control WebSocket. Previously these names were implemented only as runtime-message handlers and control WS requests fell into the scaffold error.

The controller returns `{ok:true,meetingId}` only after the existing offscreen audio document acknowledges capture. Failures return `{ok:false,code,error,...}`. The extension broadcasts `meet.capture.state` with the requested meeting ID and `starting`, `active`, `stopped`, `needs-user`, or `failed`. No token, stream ID or captured audio is returned through these status messages. Existing PCM16 conversion, audible passthrough, suppression and room-event handling remain in the existing audio/content modules.

Chrome requires invocation of the extension on the target tab / an activeTab grant. A Gateway WS command cannot supply this authorization. See [Chrome tabCapture API](https://developer.chrome.com/docs/extensions/reference/api/tabCapture) and [Chrome's service-worker/offscreen example](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture#record-audio-and-video-in-the-background). A matching `https://meet.google.com/<meetingId>` URL identifies the intended tab; it does not prove the bot has been admitted to the room.

When Chrome denies capture for lack of invocation/permission, state becomes `needs-user` with code `MEET_CAPTURE_USER_GESTURE_REQUIRED`. Other API failures remain `failed`; no capture or successful Google sign-in is inferred.

To enable a pending meeting's audio:

1. Select that meeting's tab in the dedicated bot Chrome window.
2. Open the **Tek Meet** extension.
3. Click **Start audio**. The popup may only retry the tab/meeting already requested by the Gateway. It cannot select a different recording target.
4. Check for **Audio capture active**. **Stop audio** stops media and clears the pending target; another backend start request is needed before it can restart.

Cancellation invalidates pending capture starts and recovery. Stop acknowledges only after the offscreen document is confirmed closed. Failed cleanup retains the target and requires a stop retry, blocking replacement. Reset/re-pairing first detaches the old control owner and stops capture; delayed old socket callbacks cannot reconnect or restart it. Pairing is cleared only after cleanup succeeds. Concurrent popup pairing mutations are rejected until storage completes; metadata writes are serialized. Control-socket loss stops capture and clears its pending target; reconnect does not authorize restarting cached media. A fresh backend start is required. Initial and startup metadata reads are fenced against reset/re-pair. Tab navigation away from the exact room, tab removal, or confirmed Chrome capture termination invalidates the owned target; delayed events cannot stop a replacement generation.

Thirty focused capture/dispatch/popup/keepalive/sign-in tests pass. Verification is entirely synthetic: controller tests stub Chrome permission/stream/document results; actual background dispatch tests stub WebSocket and Chrome, including popup recovery, room/target checks, state/result correlation, reset cancellation and no credential/stream-ID status leakage. These checks do not satisfy real Chrome permission, account or meeting UAT.
