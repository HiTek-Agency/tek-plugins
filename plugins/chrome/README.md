# Chrome Control Plugin

Drive user-granted tabs in your real Chrome browser through Tek — navigation, screenshots, clicks, typing, forms, waits, and JavaScript. The control protocol is model/provider neutral, so the same extension works with every agent runtime Tek supports.

The gateway-side plugin runs a local WebSocket server on `127.0.0.1:52871`. A companion MV3 Chrome extension (shipped in `extension/`) connects to that server and relays commands to Chrome APIs (`chrome.debugger`, `chrome.scripting`, `chrome.tabs`, etc.).

Control starts paused. Granting the active tab resumes agents; **Take over** pauses every agent and detaches debugger sessions immediately. Existing browsing tabs can only be granted from the local extension popup; a new tab opened through `chrome__tabs_create` joins the lease automatically while control is already resumed.

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
4. The status dot should turn green (**Connected**).
5. Visit the tab you want to share and choose **Allow this tab**. Repeat only for tabs agents should be able to see.

Use **Take over** whenever you want exclusive control. **Resume agents** restores the existing tab grants; **Revoke tab** removes the active tab from the lease.

## Tools

| Tool | Purpose |
|------|---------|
| `chrome__control_status` | Read paused state and grant counts without exposing ungranted tab metadata |
| `chrome__tabs_list` | List only tabs explicitly granted by the user |
| `chrome__tabs_create` | Open a new tab |
| `chrome__navigate` | Navigate a tab to a URL (or go back/forward/reload) |
| `chrome__read_page` | Read page text / AX-tree snapshot |
| `chrome__find` | Locate element(s) by text, role, or selector |
| `chrome__click` | Click an element by id from a prior read/find |
| `chrome__form_input` | Type text into input / select / textarea |
| `chrome__form_fill` | Fill several form fields in one round trip |
| `chrome__wait_for` | Wait for an element or text to appear or disappear |
| `chrome__screenshot` | Capture visible viewport as PNG (downscaled to `screenshotMaxWidth`) |
| `chrome__javascript_tool` | Evaluate JS in the page (always requires user approval) |

## Troubleshooting

**Popup shows "Not connected — paste token"**
- The extension has no auth token yet. Copy the token from Tek desktop (Plugins → Chrome Control) and paste it.
- If you reset the token from the desktop app, the extension disconnects — paste the new token.

**Popup shows "Connecting…" indefinitely**
- Gateway isn't running or the WS port is wrong. Check Tek desktop is running and that `wsPort` in the plugin config matches the port the extension is using (default `52871`).
- Check `~/.config/tek/gateway.log` for WS errors.

**Tools report that control is paused or a tab is not granted**
- Open the extension popup on the intended tab and select **Allow this tab**.
- The restriction belongs to the user-controlled extension, so switching models or providers cannot bypass it.

## Security

- WebSocket is bound to `127.0.0.1` only — no remote access.
- Handshake requires the pairing token issued by the Tek desktop app.
- Agents can enumerate and act on granted tabs only. Ungranted tab titles and URLs are not returned to agent tools.
- **Take over** is a local, provider-neutral kill switch and detaches active debugger sessions.
- `chrome__javascript_tool` is flagged **always-approve**: every call is gated by an approval prompt regardless of agent profile.
