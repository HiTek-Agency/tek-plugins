# Chrome Control live test

Runs five isolated agent turns through the authenticated gateway and the actual
Chrome extension: screenshot, navigation/read, find/click, form input, and JS.

## Preparation

1. Run the local gateway with Chrome Control enabled and a Chrome-capable agent.
2. Serve this directory's fixture with
   `python3 -m http.server 4321 --bind 127.0.0.1 --directory test/fixtures`.
3. Open `http://127.0.0.1:4321/test-page.html` in a dedicated Chrome tab and grant
   **that tab** in the extension popup. Confirm that the popup says Connected.
4. Supply `TEK_GATEWAY_TOKEN` in the process environment through a local credential
   provider. Authentication is required even on loopback. Never put the token in
   command-line arguments, test reports, or source files.

```sh
node test/e2e.mjs --agent tek --model openai-codex:gpt-6-astra \
  --fixture-url http://127.0.0.1:4321/test-page.html
```

The test asks the agent to identify only the exact fixture URL; it does not grant
access or manipulate unrelated tabs. It approves only `chrome__` tool requests.
The optional `--gateway-port` overrides the configured local gateway port.
`--report /absolute/path/report.json` saves diagnostic tool calls, streamed text,
and errors, excluding image bytes and tab-list results. Reports may contain
fixture conversation content and are written with mode 0600. No report is needed
for the test to run. Each prompt has a 180-second timeout.

A pass requires the named tools, no reported tool failure, an image event for
screenshots, and the fixture's click/input receipts. All five prompts must pass
for exit code 0. Exit code 1 means a failure; exit code 2 means missing setup.
An agent calling a tool without completing the requested action is not a pass.

Afterward revoke the fixture tab, close it, and stop the fixture server. Test
conversations remain in gateway history for diagnosis; no email or external page
is submitted by the fixture.

## Verified locally

2026-09-07: gateway **0.6.36 build 235**, plugin/extension **0.4.3**, all **5/5**
checks passed with Astra. The screenshot also persisted in its originating
session: 60,582-byte PNG on disk and a 1,752-byte JPEG history preview. Native
popup displayed extension 0.4.3 / gateway 0.6.36. The temporary tab grant was
revoked afterward, restoring the original seven grants.

`npm test` covers permission policy, navigation, page shaping, socket replacement,
and the screenshot event format without a live gateway or browser.
