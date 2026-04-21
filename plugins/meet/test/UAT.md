# Tek Meet — User Acceptance Test Checklist

Full pass/fail checklist covering all 17 MEET-XX requirements plus the
non-negotiable transparency guarantees (D-18, D-19) and the cost envelope
(D-20). Takes ~30-45 minutes end-to-end.

---

**Build under test:** _(record version / commit SHA here — e.g., `v0.0.104 @ 2b66c34`)_
**Tester:** _________________
**Date:** _________________
**Bot Google account:** _________________
**Test Meet URL:** _________________
**Desktop app version:** _________________

---

## Preconditions (satisfy all before starting)

- [ ] Gateway running (`~/tek/bin/tek gateway status` reports running)
- [ ] Meet plugin installed and enabled in desktop Plugins panel
- [ ] `parent-agent` permission approved for meet plugin (confirmed in Plugins panel)
- [ ] Bot Chrome profile signed into Google at `~/.config/tek/meet/chrome-profile/`
  (completed via desktop Plugins → Google Meet → "Sign bot into Google")
- [ ] Test agent configured in desktop with a configured model (any provider —
  observer mode doesn't need an LLM, participant mode does)
- [ ] voice-tts plugin installed + enabled (required for participant TTS — Test 9)

---

## Test 1 — MEET-01: Plugin scaffold is installed

**Steps:**

1. `ls ~/.config/tek/plugins/meet/` shows `plugin.json`, `src/`, `extension/`, `test/`
2. `cat ~/.config/tek/plugins/meet/plugin.json | grep '"id": "meet"'` — present
3. `cat ~/.config/tek/plugins/meet/extension/manifest.json | grep tabCapture` — present

**Expected:** All 3 commands succeed without error.

- [ ] PASS   - [ ] FAIL — details: _______

---

## Test 2 — MEET-02: Tool approval tier asymmetry (observer=session, participant=always)

**Steps:**

1. Open desktop chat; ask an agent: "List your tools that start with meet__"
2. Verify both `meet__join_observer` and `meet__join_participant` appear
3. Invoke `meet__join_observer` TWICE in the same agent session (can be across
   different prompts — the session is per-agent-conversation). Observe:
   - **1st invocation:** approval prompt appears → approve it
   - **2nd invocation:** NO approval prompt (session tier remembers the first approval)
4. Start a NEW chat session with the same agent (or clear the session). Invoke
   `meet__join_participant` TWICE:
   - **1st invocation:** approval prompt appears → approve it
   - **2nd invocation:** approval prompt APPEARS AGAIN (always tier prompts every invocation)

**Expected:** observer = prompts once per session; participant = prompts every invocation.

- [ ] PASS   - [ ] FAIL — details: _______

---

## Test 3 — MEET-03: Dedicated Chrome profile spawns

**Steps:**

1. Call `meet__join_observer` with the test Meet URL; approve
2. A new Chrome window opens; the window title includes the Meet URL
3. `ps aux | grep "user-data-dir.*meet/chrome-profile"` shows the process
4. The bot Chrome is a DIFFERENT profile than your primary Chrome (separate
   windows, separate session cookies — your primary tabs are not visible
   in the bot's window)

**Expected:** Bot Chrome spawns with its own profile at `~/.config/tek/meet/chrome-profile/`.

- [ ] PASS   - [ ] FAIL — details: _______

---

## Test 4 — MEET-04: Audio capture active (tabCapture + offscreen)

**Steps:**

1. After join, speak into your own device's mic during the meeting for ≥5 seconds
2. Watch `~/.config/tek/gateway.log` for `[meet]` entries (audio-frame / chunk)
3. Expected: audio frames arriving at approximately 8/second (or whisper chunks
   every 1-2 seconds)

**Expected:** Audio frames are being received; gateway log shows `[meet]` activity.

- [ ] PASS   - [ ] FAIL — details: _______

---

## Test 5 — MEET-05: Mirror-back — user/bot still hear the call

**Steps:**

1. Have another participant in the meeting speak
2. Audio from the remote participant is AUDIBLE through the bot Chrome's
   speakers (the tab is not silently muted by tabCapture)

**Expected:** The bot's tab plays the remote audio back through the bot machine's speakers.

- [ ] PASS   - [ ] FAIL — details: _______

---

## Test 6 — MEET-06: Local whisper transcription

**Steps:**

1. Speak a distinctive sentence clearly: "The quick brown fox jumps over the lazy dog"
2. Within ~5 seconds, check `~/.config/tek/meet-transcripts/<date>_<code>_*/raw.jsonl`
3. Verify: a line exists with `text` containing at least "brown fox" or "lazy dog"
   (case-insensitive match acceptable)

**Expected:** Whisper transcribed your sentence locally; raw.jsonl grew.

- [ ] PASS   - [ ] FAIL — details: _______

---

## Test 7 — MEET-07: Speaker attribution via DOM

**Steps:**

1. Join the meeting as a second participant (use a different device / browser /
   Google account so you appear as a distinct participant with a display name)
2. Speak as that second participant for ≥5 seconds
3. Check `raw.jsonl` — chunks captured during your second-participant speech
   should have `speakerGuess` set to your display name (not null)

**Graceful-fail note:** if Meet's DOM selectors broke (drift), this test fails
gracefully with `speakerGuess: null`; the backup is MEET-13 (post-meeting API
reconciliation). A hard fail here is only concerning if MEET-13 also fails.

- [ ] PASS   - [ ] FAIL — details: _______

---

## Test 8 — MEET-08: getUserMedia monkey-patch (participant mode)

**Steps:**

1. Call `meet__join_participant` with the test URL and approve
2. In the bot Chrome's DevTools console on the Meet tab, run:
   ```javascript
   await navigator.mediaDevices.enumerateDevices()
   ```
3. Verify the returned list includes:
   `{deviceId: "tek-synth-mic", kind: "audioinput", label: "Tek Agent Voice", groupId: "tek"}`

**Expected:** Synthetic mic device visible in `enumerateDevices()` output.

- [ ] PASS   - [ ] FAIL — details: _______

---

## Test 9 — MEET-09: Wake-word triggers voice response

**Preconditions:** meeting in participant mode (Test 8 complete). voice-tts
plugin installed + enabled. Test agent has a model configured.

**Steps:**

1. Have another participant say clearly into their mic: "Hey Tek, what is the current time?"
2. Within ~10 seconds, the bot unmutes (or joins via its synthetic mic) and
   speaks an English-language response (it should mention the current time).
3. The response audio is AUDIBLE to all participants through the Meet audio.

**Expected:** Wake-word fires → LLM generates a reply → TTS plays through the
synthetic mic → remote participants hear the bot's voice.

- [ ] PASS   - [ ] FAIL — details: _______

---

## Test 10 — MEET-10: Transparency chat post on join

**Steps:**

1. Join a meeting via `meet__join_observer`
2. Within 20 seconds of the bot appearing in the participant list, check
   Meet's built-in chat panel (open it with the chat icon in the toolbar)
3. Verify a message from the bot reads:
   "Tek assistant is attending on behalf of <user>. I'm recording a local
   transcript for note-taking."

**Expected:** Transparency message visible to all participants.

- [ ] PASS   - [ ] FAIL — details: _______

---

## Test 11 — MEET-11: Desktop status chip + kick-bot

**Steps:**

1. While bot is in meeting, check the desktop app titlebar (right side)
2. Verify the chip shows: `🎙️ Meet: <code> (<mode>)` with a visible "Kick bot" button
3. Click "Kick bot"
4. Within 5 seconds: chip disappears; bot leaves the meeting; bot Chrome window
   closes; a toast notification confirms "Bot left the meeting"

**Expected:** Chip is always visible while in meeting; one-click kick works.

- [ ] PASS   - [ ] FAIL — details: _______

---

## Test 12 — MEET-12: Archive files materialize post-meeting

**Steps:**

1. After bot leaves (via Test 11 kick OR natural meeting end)
2. Check `~/.config/tek/meet-transcripts/<date>_<code>_*/`
3. Verify all 4 files exist: `raw.jsonl`, `transcript.md`, `summary.md`, `meta.json`
4. `transcript.md` has speaker-grouped markdown content (not empty)
5. `meta.json` has a `reconciliation` field valued one of: `pending` / `unavailable`
   / `reconciled` / `timeout`
6. If on Workspace Business+: a Google Doc was created — its link should be in
   `meta.json` (check for a `docUrl` or similar key), or in the summary chat
   message posted to Meet chat

**Expected:** 4-file archive exists + Google Doc created (Workspace tier only).

- [ ] PASS   - [ ] FAIL — details: _______

---

## Test 13 — MEET-13: Reconciler runs in background

**Steps:**

1. After meeting end, watch gateway logs for up to 5 minutes (reconciler polls
   every 60s for up to 60 min)
2. Expected log line: `[meet] reconciliation: <status>` with status:
   - `unavailable` on a free Gmail account (API transcripts gated to Business+)
   - `reconciled` on a Workspace Business+ account with native transcription enabled
3. If `reconciled`: inspect `transcript.md` again — `speakerGuess` values should
   now be real participant names (not `null` or best-guess DOM names)

**Conditional:** This test is **conditional pass** on free Gmail accounts (status
= `unavailable` is an expected outcome there). Hard-fail only on Workspace tier.

- [ ] PASS   - [ ] FAIL — details: _______   - [ ] N/A (free Gmail tier — unavailable is expected)

---

## Test 14 — MEET-14: Meet OAuth scope added

**Steps:**

1. Open desktop Settings → Google Workspace
2. Verify a Meet permission control exists (dropdown or toggle with values
   `off` / `read`)
3. Set Meet to `read` and click re-authenticate. When the OAuth consent screen
   loads, verify `meetings.space.readonly` appears in the granted-scopes list
4. After completing OAuth, check `~/.config/tek/google.json` — the `scope`
   field contains `meetings.space.readonly`

**Expected:** Meet permission control exists + OAuth scope correctly requested.

- [ ] PASS   - [ ] FAIL — details: _______

---

## Test 15 — MEET-15: meet tool group excluded from local profile

**Steps:**

1. Open desktop Settings → Tool Profiles → "Local" profile
2. Verify: meet tools (`meet__join_observer`, `meet__join_participant`) are
   NOT listed. (Chrome tools should also be absent — this is a consistency
   check that the exclusion pattern is working.)
3. Switch an agent to the Local profile; in chat, ask the agent to list its
   tools; meet tools must be absent from its response

**Expected:** meet group excluded from Local tool profile.

- [ ] PASS   - [ ] FAIL — details: _______

---

## Test 16 — MEET-16: Agent manual has google-meet topic

**Steps:**

1. Open desktop chat with any agent
2. Ask the agent: "Use the manual_lookup tool to fetch the google-meet topic and show me its content"
3. Verify the returned content:
   - Mentions "observer" and "participant" modes
   - Mentions the approval tier asymmetry (observer=session, participant=always)
   - Mentions the archive path (`~/.config/tek/meet-transcripts/`)

**Expected:** Manual topic exists and documents the capability.

- [ ] PASS   - [ ] FAIL — details: _______

---

## Test 17 — MEET-17: Full E2E green

**Steps:**

1. Ensure all preconditions at the top of this file are satisfied
2. Export `TEK_MEET_URL` to a live test Meet URL:
   ```bash
   export TEK_MEET_URL="https://meet.google.com/<your-test-code>"
   ```
3. Run the scripted E2E:
   ```bash
   node ../tek-plugins/plugins/meet/test/e2e.mjs
   ```
4. Expected: exits 0 with final line `[E2E] PASSED`

**Expected:** Full scripted E2E green.

- [ ] PASS   - [ ] FAIL — details: _______

---

## Transparency non-negotiables (D-18, D-19)

**Test 18 — Bot never joins silently:**
Bot posts the transparency chat message on EVERY join (observer AND
participant). No way to suppress it in the UI or config.

- [ ] PASS   - [ ] FAIL — details: _______

**Test 19 — Desktop chip is always visible:**
The desktop chip is shown for the entire duration the bot is in a meeting.
It cannot be hidden, minimized, or closed except by kicking the bot. Not
behind any setting / pref.

- [ ] PASS   - [ ] FAIL — details: _______

**Test 20 — User can kick in ≤2 clicks:**
At any time during a meeting, the user can kick the bot with no more than
two clicks (chip → Kick bot = 2 clicks; one is acceptable too). No
confirmation dialog required — clicking Kick is the confirmation.

- [ ] PASS   - [ ] FAIL — details: _______

---

## Cost envelope (D-20)

**Test 21 — Passive observer produces zero cloud calls:**

**Steps:**

1. Before the meeting: note current LLM cost via desktop CostsView (or the
   cost audit log at `~/.config/tek/cost-audit.log`)
2. Join as observer (`meet__join_observer`), run for 5 minutes, speak during
   the meeting. **Do NOT use wake-word phrases.**
3. After 5 minutes, kick the bot
4. Check cost again: it must be UNCHANGED from the pre-meeting baseline
   (local whisper = $0, no LLM calls made, no TTS calls made)

**Expected:** Passive observer = $0 cloud cost for the full 5 minutes.

- [ ] PASS   - [ ] FAIL — details: _______

---

## Summary

| Category | Count | Passed |
|----------|-------|--------|
| Core requirements (MEET-01..MEET-17) | 17 | __ / 17 |
| Transparency non-negotiables (D-18/D-19) | 3 | __ / 3 |
| Cost envelope (D-20) | 1 | __ / 1 |
| **Total** | **21** | **__ / 21** |

**Overall phase verdict:**

- [ ] **PASS** (all 21 green)
- [ ] **CONDITIONAL PASS** (MEET-13 = `unavailable` on free Gmail tier, all other 20 green)
- [ ] **FAIL** (any other failure)

**Notes and carry-over items:**

_____________________________________________
_____________________________________________
_____________________________________________

---

**Known limitations (not failures — documented boundaries):**

- **macOS only.** tabCapture offscreen-doc flow + Chrome profile spawning is
  tested on macOS only. Windows / Linux are out of scope for this phase.
- **English wake words.** Default phrases are `"hey tek"` and `"tek join in"`.
  Users can customise via `cfg.wakeWordPhrases` but multi-language + i18n is
  deferred.
- **Workspace Business+ required for API reconciliation (MEET-13).** Free
  Gmail accounts will always see `meta.reconciliation = "unavailable"`. This
  is a Google API tier limitation, not a Tek bug.
- **Per-meeting Meet v2 API reconciliation latency 7–45+ min.** The reconciler
  polls every 60s for up to 60 min after meeting end. On Workspace tier, if
  the API transcript never materialises within the 60-min window, the status
  flips to `timeout` and the archive stays with live-DOM speaker attribution.
- **One active meeting at a time.** The plugin manages a single Meet session.
  Calling `meet__join_*` while already in a meeting will error (or replace
  the current session — verify behaviour in Test 3 if important).

---

*Phase 104 — Google Meet Observer and Participant*
*UAT checklist generated 2026-04-20, revision 1*
