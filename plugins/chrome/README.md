# Chrome Control Plugin

Drive your real Chrome browser with AI — tabs, navigation, screenshots, clicks, typing, JS eval.

The gateway-side plugin runs a local WebSocket server on `127.0.0.1:52871`. A companion MV3 Chrome extension (shipped in `extension/`) connects to that server and relays commands to Chrome APIs (`chrome.debugger`, `chrome.scripting`, `chrome.tabs`, etc.).

> Phase 101 limitations: this plugin is a scaffold. Full tool behavior lands in plans 03–05. User takeover UI (pause/resume, approval gates, login handoff) lands in Phase 102. Console / network tools and Chrome Web Store distribution land in Phase 103.

## Install the Plugin

From the Tek desktop app: **Settings → Plugins → Browse** and install **Chrome Control**.

Or from the CLI:

```bash
tek plugins install chrome
```

## Load the Chrome Extension

The extension ships inside this plugin's `extension/` directory (after install it lives at `~/.config/tek/plugins/chrome/extension/`). Load it unpacked:

1. Open `chrome://extensions` in Chrome
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` directory from your Tek plugins install
5. The **Tek Chrome Control** action icon appears in the toolbar

## Pair the Extension to the Gateway

1. Open the Tek desktop app → **Settings → Plugins → Chrome Control** to copy the pairing token
2. Click the Tek Chrome Control icon in the Chrome toolbar
3. Paste the token into **Paste token from Tek desktop** and click **Save**
4. The status dot should turn green (**Connected**). Your agent can now drive Chrome.

## Tools (scaffolded; full behavior in plans 04/05)

| Tool | Purpose |
|------|---------|
| `chrome__tabs_list` | List open tabs across windows |
| `chrome__tabs_create` | Open a new tab |
| `chrome__navigate` | Navigate a tab to a URL (or go back/forward/reload) |
| `chrome__read_page` | Read page text / AX-tree snapshot |
| `chrome__find` | Locate element(s) by text, role, or selector |
| `chrome__click` | Click an element by id from a prior read/find |
| `chrome__form_input` | Type text into input / select / textarea |
| `chrome__screenshot` | Capture visible viewport as PNG (downscaled to `screenshotMaxWidth`) |
| `chrome__javascript_tool` | Evaluate JS in the page (always requires user approval) |

## Troubleshooting

**Popup shows "Not connected — paste token"**
- The extension has no auth token yet. Copy the token from Tek desktop (Plugins → Chrome Control) and paste it.
- If you reset the token from the desktop app, the extension disconnects — paste the new token.

**Popup shows "Connecting…" indefinitely**
- Gateway isn't running or the WS port is wrong. Check Tek desktop is running and that `wsPort` in the plugin config matches the port the extension is using (default `52871`).
- Check `~/.config/tek/gateway.log` for WS errors.

**Tools return `{ ok: false, reason: "not yet implemented (plan 04/05)" }`**
- Expected on Phase 101 Plan 02. Wait for plans 03–05 to land.

## Security

- WebSocket is bound to `127.0.0.1` only — no remote access.
- Handshake requires the pairing token issued by the Tek desktop app.
- `chrome__javascript_tool` is flagged **always-approve**: every call is gated by an approval prompt regardless of agent profile.
- Full takeover / login handoff UX arrives in Phase 102.
