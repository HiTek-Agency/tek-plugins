# Chrome Control E2E Test

Validates **SC-9** of Phase 101: an agent can navigate, screenshot, read, click,
type, and evaluate JS — all results observable in the chat transcript.

## Prereqs

- Tek gateway running locally (`~/tek/bin/tek gateway status` shows running)
- Chrome Control plugin installed and **enabled** in the Tek desktop
- Chrome open with the extension loaded unpacked; popup shows green "Connected"
- An agent configured with the chrome tool group enabled
  (`full` or `developer` tool profile — see `packages/gateway/src/agent/tool-profiles.ts`)
- The `ws` npm package available in this plugin dir (it is already a runtime
  dependency; run `npm install` from `plugins/chrome/` if `node_modules` is
  missing)

## Run

```bash
node test/e2e.mjs --agent <agent-id>
```

Optional flags:

- `--gateway-port 3271` — override the port read from `~/.config/tek/config.json`
  (`apiEndpoint.port`)
- `--fixture-url file:///path/to/page.html` — override the default fixture
  served from `test/fixtures/test-page.html`

## What it does

Runs 5 chat prompts sequentially, each opening a fresh WebSocket to
`ws://127.0.0.1:<port>/` (the gateway WS — loopback is pre-authenticated, no
bearer token needed). Assertions per prompt:

| # | Prompt | Asserts |
|---|--------|---------|
| 1 | Screenshot current tab | `chrome__screenshot` tool called AND `image.generated` side-channel emitted |
| 2 | Navigate to fixture + read h1 | `chrome__navigate` or `chrome__read_page` called |
| 3 | Find + click link `#target-link` | `chrome__find` or `chrome__click` called |
| 4 | Type into `#target-input` | `chrome__form_input` called |
| 5 | Evaluate `window.__tekE2E.ready` | `chrome__javascript_tool` called |

Auto-approves any `tool.approval.request` (so `chrome__javascript_tool` runs
without manual intervention even when its approval tier is `always`).

Exit code: `0` on all-pass, `1` on any failure. On failure, the test prints
per-prompt status and the assertion error.

## Manual verification

- Watch Chrome: the fixture page should appear in the active tab and the
  yellow "Tek is debugging this browser — Cancel" banner should be visible.
- Open Tek desktop chat for the agent: the screenshot from prompt 1 should
  render inline (not raw JSON).
