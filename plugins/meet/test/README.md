# Tek Meet Plugin — Test Guide

Four test layers, each one runs independently and catches a different class of regression.

---

## Layer 1: Unit tests (fast, no deps)

Runs under `node --test` using the built-in test runner. Covers: plugin manifest,
scope+profile cross-repo assertions, check-connection, chrome-profile, dispatch,
PCM16 worklet math, VAD, keepalive, meet-transcriber, raw.jsonl writer,
speaker-selectors, speaker-tracker, chat-post CDP commands, archive-writer,
doc-creator, meet-reconciler, wake-word-scanner, meet-fsm, mic-inject.

```bash
cd ../tek-plugins/plugins/meet
npm test
```

Expected: `139 pass, 0 fail`. Runs in ~170 ms. No gateway, no Chrome, no network.

---

## Layer 2: Scripted E2E (drives a real Meet)

Real Meet join → transcribe → archive → kick-bot cycle via the gateway WS
protocol. Takes ~3 minutes wall-clock. Good for a full smoke after changes
that touch plugin ↔ gateway wiring.

**Prereqs:**

1. **Gateway built + installed:** in the tek repo root, run
   `scripts/update-local.sh --no-desktop` and start the gateway
   (`~/tek/bin/tek gateway start` OR the launchd agent).
2. **Meet plugin installed + enabled:** via the desktop Plugins panel, OR
   symlinked manually:
   ```bash
   mkdir -p ~/.config/tek/plugins/meet
   cp -R ../tek-plugins/plugins/meet/* ~/.config/tek/plugins/meet/
   ```
3. **Bot Chrome profile signed into Google:** open desktop app → Plugins →
   Google Meet → "Sign bot into Google". Complete sign-in in the Chrome window
   that opens, then close it. Profile now lives at
   `~/.config/tek/meet/chrome-profile/`.
4. **Test agent configured** with any model (local or cloud — observer mode
   doesn't make LLM calls, so the model choice only matters if you extend the
   test to exercise participant mode). The harness auto-discovers the first
   agent in `~/.config/tek/config.json` if `TEK_AGENT_ID` isn't set.
5. **Live test meeting:** visit `https://meet.google.com/new` in your own
   browser, create a meeting, and keep that tab open so the meeting stays
   alive for the duration of the test.

**Run:**

```bash
export TEK_MEET_URL="https://meet.google.com/<your-test-code>"
# Optional overrides:
# export TEK_GATEWAY_PORT=3271   # auto-detected from ~/.config/tek/runtime.json
# export TEK_AGENT_ID=my-agent   # defaults to first agent in config.json
# export TEK_WAIT_MS=120000      # ms to dwell after join before kicking (default 2 min)

node test/e2e.mjs
```

**Expected output:**

```
[E2E] connecting to gateway :3271
[E2E] gateway connected
[E2E] pre-join status: connected=... meetingId=null
[E2E] invoking meet__join_observer for https://meet.google.com/abc-defg-hij
[E2E] auto-approving meet__join_observer
[E2E] chat stream ended — tool call resolved
[E2E] waiting for plugin.meet.status to report join (up to 90s)...
[E2E] plugin.meet.status → connected=true meetingId=abc-defg-hij mode=observer
[E2E] waiting 120s for audio/transcript chunks to accumulate...
[E2E] archive dir: /Users/you/.config/tek/meet-transcripts/2026-04-21_abc-defg-hij_...
[E2E] raw.jsonl has 37 chunks (12847 bytes)
[E2E] kicking bot to trigger onMeetingEnd...
[E2E] kick ok
[E2E] transcript.md exists (4271 bytes)
[E2E] summary.md exists (182 bytes)
[E2E] meta.json exists (612 bytes)
[E2E] meta.json reconciliation: pending
[E2E] E2E PASSED
```

Exit 0 on full pass. Exit 1 on assertion failure (with `[E2E] FAIL: …` line).
Exit 2 on missing env (prints usage). Exit 3 on uncaught error.

**What it asserts (MEET-17):**

1. plugin.meet.status reports connected + meetingId non-null within 90s
2. Archive dir materialises under `~/.config/tek/meet-transcripts/`
3. raw.jsonl has ≥1 chunk after the dwell window
4. plugin.meet.kick completes with ok:true
5. transcript.md, summary.md, meta.json all exist post-kick
6. meta.json has a `reconciliation` field

**Manual sanity checks while the test is running** (do these in parallel for
full MEET-10 + MEET-07 + MEET-11 coverage):

- The bot named `[Tek] <your name>` appears in the Meet participant list
- A transparency chat message was posted: "Tek assistant is attending on
  behalf of ..."
- The desktop MeetStatusChip is visible in the titlebar for the duration
- The chip's "Kick bot" button works (same effect as the scripted kick)

---

## Layer 3: Human UAT (all 17 MEET-XX + transparency + cost)

Pass/fail checklist at `test/UAT.md`. 21 items. Takes ~30-45 min for a full run.
Covers behaviours the scripted E2E can't check (audio audibility, wake-word
voice trigger, Google Doc creation, kick chip visual, reconciliation with a
Workspace tier account).

```bash
open test/UAT.md  # or: cat test/UAT.md
```

Run it end-to-end after any change that touches the extension, the desktop
chip, or the archive/reconciliation pipeline.

---

## Layer 4: Selector drift probe (maintenance tool)

Google ships Meet UI updates silently. When DOM scraping stops working, this
probe tells you WHICH selector broke.

**Prereqs:**

1. Launch the bot Chrome manually with `--remote-debugging-port=9222`:
   ```bash
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
     --user-data-dir="$HOME/.config/tek/meet/chrome-profile" \
     --remote-debugging-port=9222 \
     https://meet.google.com/new
   ```
2. Join a meeting in that Chrome so the DOM is live (you need at least one
   speaker tile visible for the active-speaker selectors to match anything).

**Run:**

```bash
node test/selector-probe.mjs
```

**Expected output:** one line per probed selector with the top-3 matched
elements' text + class + first 6 attribute names. Selectors that return `[]`
are either genuinely absent or have drifted — compare against the priority
list in `extension/speaker-selectors.js`. If the top-priority selectors
(index 0, 1) return `[]` but lower-priority ones match, add the working
ones to the top of the priority list.

Not a CI gate. Not a pass/fail test. Just a "tell me what Meet looks like
today" diagnostic.

---

## Troubleshooting

**E2E: `connect timeout ws://127.0.0.1:3271/gateway`**
→ Gateway isn't running. Check `tek gateway status` or `launchctl list | grep com.tek.gateway`.

**E2E: `no agent id available`**
→ No agents configured. Create one via the desktop app onboarding, or set
`TEK_AGENT_ID` to a known agent id.

**E2E: `meet never reached connected+meetingId`**
→ The bot didn't join. Common causes: (a) bot Chrome profile not signed in
(run "Sign bot into Google" in the desktop Plugins panel); (b) Meet URL
expired (create a fresh one); (c) bot hit a waiting room and nobody let it in
(have a second participant in the meeting admit it).

**E2E: `raw.jsonl has 0 chunks`**
→ Audio pipeline isn't producing. Speak into your own mic during the dwell
window, or check `~/.config/tek/gateway.log` for `[meet]` entries around
audio frames.

**E2E: `transcript.md missing`**
→ Kick succeeded but archive finalize didn't run. Check gateway log for
errors in the onMeetingEnd pipeline (plan 104-05 territory).

**Selector probe: `No meet.google.com tab found`**
→ The bot Chrome you launched with `--remote-debugging-port=9222` isn't on
a Meet page. Navigate to `https://meet.google.com/new` in that Chrome
before re-running the probe.
