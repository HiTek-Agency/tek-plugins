# Mac Control Plugin

Control your Mac with AI — screenshots, UI element interaction, typing, window management.

Powered by [Peekaboo](https://github.com/steipete/peekaboo).

## Prerequisites

Install the Peekaboo CLI:

```bash
brew install steipete/tap/peekaboo
```

Grant permissions in System Settings:
- **Accessibility** (required for clicking, typing, window management)
- **Screen Recording** (required for screenshots and UI element discovery)

## Tools

| Tool | Description |
|------|-------------|
| `mac__see` | Capture screen + discover UI elements with IDs (see-then-act) |
| `mac__click` | Click by element ID, text label, or coordinates |
| `mac__type` | Type text into focused element |
| `mac__hotkey` | Key combos (cmd+c, cmd+v, cmd+shift+s, etc.) |
| `mac__screenshot` | Screenshot to base64 (full screen, window, or region) |
| `mac__open_app` | Launch, focus, quit, or hide apps |
| `mac__window` | List, focus, move, resize, close windows |
| `mac__system_info` | Running apps, windows, screens, permissions |

## Usage Pattern

1. Use `mac__see` to capture the screen and get annotated UI element IDs
2. Find the element you want (e.g. button "B1", text field "T3")
3. Use `mac__click` with that element ID to interact

## Security

This plugin is **disabled by default**. Enable it in Tek Settings > Plugins after granting macOS permissions.
