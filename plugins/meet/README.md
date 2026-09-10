# Google Meet Plugin

Join Google Meet as an observer (silent transcription + notes) or a wake-word participant (listens passively, speaks only when a wake-word fires). Local whisper transcription, DOM-based speaker attribution, post-meeting Google Doc + chat summary + on-disk archive.

> **0.1.2:** Exact HTTPS Meet room validation and extension/plugin version checks added.

> **0.1.1:** Desktop control and cleanup race coverage is available. Live Google sign-in, admission, audio, and post-meeting delivery still require separate acceptance; unit tests do not establish that those external flows work.

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

## Tools

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

## Desktop control contract (0.1.1)

`plugin.meet.status` advertises `conditionalControlsVersion: 1` and `operation`
(`null`, `join`, `signin`, `end`, `stop`, or `stop-failed`). `connected` describes
the control service worker; the offscreen audio connection does not replace it.
The displayed meeting ID/mode remain present while stopping or after an
unconfirmed stop, so an empty connection is not mistaken for completed cleanup.

- `plugin.meet.kick` accepts optional `expectedMeetingId` (string or null). A
  mismatch returns correlated `ok: false, code: "MEET_CONFLICT"` before effects.
  Omitted identity preserves the legacy emergency-stop action.
- `plugin.meet.open-signin` accepts `expectedMeetingId: null` from the Desktop.
  Active meetings and pending join/cleanup reject the action. A connected bot
  uses the fixed, no-argument extension route `meet.open-signin`; general Meet
  navigation does not gain an arbitrary URL exception.
- Join/sign-in/cleanup are mutually exclusive. Kick can cancel a pending join or
  sign-in immediately, initiates browser termination before a slow transcription
  flush, and holds the operation gate until older setup/cleanup settles.
- Old callbacks cannot send TTS, navigate, clear a new meeting, or append into a
  new archive. Already accepted transcription drains into its captured archive.
  A natural end drains that transcription before finalizing the archive.
- Re-registration during cleanup fails clearly; repeated cleanup is coalesced,
  and stale registration handlers cannot stop or close a newer registration.

Chrome stop remains best effort at the operating-system boundary. A force-kill
signal without observed process exit reports failure and retains the process
handle and meeting evidence for an explicit stop retry. The plugin does not
claim that an already dispatched Google request was undone. Setup or cleanup
that never settles keeps new operations blocked; Chrome stop still starts
immediately. An emergency kick preserves raw transcript chunks but does not
implicitly create a Google Doc or start reconciliation.

### Capture readiness and Chrome invocation

Chrome permits tab capture only after the user invokes the extension for the
target tab; opening Chrome through a Gateway request does not grant that
permission. See [Chrome tabCapture documentation](https://developer.chrome.com/docs/extensions/reference/api/tabCapture).
When Chrome denies the start request, focus the Meet tab in the dedicated bot
Chrome profile, open the Tek Meet extension, and click **Start audio**. The popup
can retry only the tab and meeting already requested by the Gateway. Stop clears
that pending target; it cannot be silently reused for a different meeting.

The join tool sends one capture request. It reports `ok: false` for a missing,
failed, or wrong-meeting acknowledgement, and also when local Whisper setup is
unavailable. The bot window may already be open in that case: the meeting remains
identifiable so the user can explicitly stop it. The tool does not retry or claim
that capture or transcription is ready merely because navigation succeeded.

Status includes `capture: { state, error?, code? }`, where state is `idle`,
`starting`, `active`, `needs-user`, `failed`, `stopped`, or `unknown`, and a separate
`transcriptionReady` flag with optional `transcriptionError`. Only a successful
capture acknowledgement or an owned extension state update establishes active
capture. A matching manual recovery updates status without rerunning the join;
late RPC responses cannot overwrite newer capture evidence. Connection loss
makes previously active delivery unknown. Stop/failed-stop evidence takes
precedence over capture readiness.

A natural meeting end requests `meet.stop-capture` with the exact expected meeting
ID before draining transcription and finalizing the archive. Unconfirmed capture
cleanup keeps the meeting available for explicit emergency Stop and blocks a new
join. These local protocol checks do not verify Google admission or real media
permission; live acceptance remains separate.

### Updating an existing bot extension

After updating the plugin to **0.1.2**, open `chrome://extensions` in the dedicated
bot profile and **Reload** the unpacked Tek Meet extension. It must also show
version **0.1.2** to support the fixed sign-in route. An older running extension
rejects that route and the Desktop reports the failure; update/reload it rather
than treating the failed action as success. The bot profile/account is preserved.

The registry installs `plugins/meet` from this repository's default Git branch.
Publishing this version means merging/pushing the tested source and the matching
`registry.json`, plugin/package, and extension manifest versions. There is no
separate npm/CDN build or registry-publish workflow in this repository. Updating
and enabling an installed plugin remain separate actions.

### Verification limits

`npm test` exercises real registration/tool/WS handlers with stubbed browser,
socket, filesystem, transcription, and Google boundaries. It includes delayed
setup, stop, finalization, reload, audio/control coexistence, and stale callback
regressions without launching Chrome or sending network requests. The entry point
is JavaScript source (`src/index.js`), so no separate compilation is required.
The scripted live Meet test is opt-in and was not run for this release.

## Related

- Phase 101 (chrome-control) — same dual-surface (MV3 extension + gateway WS) pattern; reference for the scaffold.
- voice-input-stt plugin — supplies the `@fugood/whisper.node` lazy-load that this plugin will reuse in plan 104-03.
- voice-conversation plugin — supplies the state machine that participant-mode wake-word flows map into in plan 104-05.
