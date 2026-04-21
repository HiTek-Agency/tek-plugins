# Google Meet Plugin

Join Google Meet as an observer (silent transcription + notes) or a wake-word participant (listens passively, speaks only when a wake-word fires). Local whisper transcription, DOM-based speaker attribution, post-meeting Google Doc + chat summary + on-disk archive.

> **Status: Scaffold — plan 104-01b only seeds the file tree.** Plans 104-02..104-08 implement behavior (WS bootstrap, audio pipeline, wake-word, TTS injection, notes delivery, desktop status chip, E2E smoke test). Do not expect the tools to do anything real yet.

The gateway-side plugin runs a local WebSocket server on `127.0.0.1:52881`. A companion MV3 Chrome extension (shipped in `extension/`) connects to that server from a dedicated Chrome profile and captures Meet tab audio via `chrome.tabCapture` + an offscreen document. Audio is streamed to the gateway as PCM16 frames and transcribed locally with `@fugood/whisper.node` (reused from the voice-input-stt plugin).

## Install the Plugin

From the Tek desktop app: **Settings → Plugins → Browse** and install **Google Meet**.

Or from the CLI:

```bash
tek plugins install meet
```

## Load the Chrome Extension

The extension ships inside this plugin's `extension/` directory (after install it lives at `~/.config/tek/plugins/meet/extension/`). Load it unpacked into the dedicated meet-bot Chrome profile:

1. Launch the dedicated meet-bot profile (desktop app handles this — **Settings → Plugins → Google Meet → Open bot profile**)
2. Open `chrome://extensions` in that profile
3. Toggle **Developer mode** (top right)
4. Click **Load unpacked** and select the `extension/` directory from your Tek plugins install
5. Sign the profile into the Google account you want the bot to use (one-time)

## Pair the Extension to the Gateway

1. Open the Tek desktop app → **Settings → Plugins → Google Meet** to copy the pairing token
2. Click the Tek Meet icon in the bot-profile Chrome toolbar
3. Paste the token into the popup and click **Save**
4. The status dot should turn green (**Connected**). Your agent can now join Meets.

## Tools (scaffolded; behavior lands in plans 104-02..104-06)

| Tool                       | Purpose                                                                     | Approval Tier            |
| -------------------------- | --------------------------------------------------------------------------- | ------------------------ |
| `meet__join_observer`      | Join a Meet silently. Transcribe tab audio only; no mic exposure.           | `session` (once/session) |
| `meet__join_participant`   | Join a Meet in wake-word mode. Silent by default; speaks when wake-word fires. Mic IS exposed when active. | `always` (approve every call) |

**Why the asymmetry?** Observer-mode transcribes only what's already being said into the call — no new data source for other participants. Session-level approval is enough once the user has green-lit the bot for this work session. Participant-mode injects a synthetic microphone back into Meet and can speak on the user's behalf; every use is an explicit, consciously-approved act. `approvalTier: "always"` forces per-call confirmation.

The tier is wired in `src/index.js` via the `ctx.addTool(..., { approvalTier })` option on each registration.

## Privacy

- Wake-word detection runs **100% locally** via whisper partial-transcript scanning. Passive listening is zero-cost and zero-cloud.
- Only **wake-word hits** produce any outbound LLM call.
- The bot **announces itself** in Meet chat on join (non-negotiable transparency — see phase 104 decision D-18).
- Transcripts are stored locally at `~/.config/tek/meet-transcripts/<date>_<meet-code>_<slug>/`. A Google Doc copy is created only if the Google Workspace integration is authorised with `meetings.space.readonly` scope AND the user's agent has `googlePermissions.meet = "read"`.

## Troubleshooting

**Popup shows "Scaffold — plan 104-02 wires connection status"**
- Expected. This is plan 104-01b (scaffold only). Real popup behavior lands in plan 104-02.

**`meet__join_observer` or `meet__join_participant` returns `{ ok: false, reason: "scaffold-only" }`**
- Also expected. The `execute()` handlers are placeholders. Real behavior lands in plans 104-02 (WS server + extension bootstrap) and 104-03/04/05 (audio pipeline, wake-word, TTS injection).

## Related

- Phase 101 (chrome-control) — same dual-surface (MV3 extension + gateway WS) pattern; reference for the scaffold.
- voice-input-stt plugin — supplies the `@fugood/whisper.node` lazy-load that this plugin will reuse in plan 104-03.
- voice-conversation plugin — supplies the state machine that participant-mode wake-word flows map into in plan 104-05.
