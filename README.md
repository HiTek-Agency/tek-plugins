# Tek Plugins Registry

Official plugin registry for [Tek](https://github.com/HiTek-Agency/Tek-Agent-Hub) — the self-hosted AI agent gateway.

## Browse Plugins

Open the Tek desktop app → **Plugins** → **Browse** tab to discover and install plugins.

## Available Plugins

| Plugin | Category | Description |
|--------|----------|-------------|
| 🔗 URL Summarizer | Productivity | Summarize web pages, articles, YouTube videos using AI |
| 🖥️ Mac Control | Automation | Control your Mac — screenshots, clicks, typing, window management |
| 🎙️ Voice Input (STT) | Voice | Speech-to-text with local Whisper and cloud providers |
| 🔊 Voice Output (TTS) | Voice | Text-to-speech with macOS, OpenAI, ElevenLabs |
| 🗣️ Voice Conversation | Voice | Real-time voice conversation via WebRTC |

## Creating a Plugin

### Quick Start

1. Create a new repo with this structure:
```
my-plugin/
├── plugin.json        # Plugin manifest (required)
├── package.json       # npm dependencies (optional)
├── src/
│   └── index.js       # Plugin source (ES module)
└── dist/
    └── index.js       # Built entry point
```

2. Write your `plugin.json`:
```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "description": "What it does in one sentence",
  "entryPoint": "dist/index.js",
  "permissions": ["tools", "config"],
  "providesTools": ["my_plugin__my_tool"],
  "source": {
    "type": "git",
    "repo": "https://github.com/you/my-plugin"
  }
}
```

3. Write your `src/index.js`:
```javascript
export async function register(context) {
  context.addTool("my_tool", {
    description: "Does something useful",
    parameters: {
      type: "object",
      properties: {
        input: { type: "string", description: "The input" }
      },
      required: ["input"]
    },
    execute: async ({ input }) => {
      return { result: `Processed: ${input}` };
    }
  });

  context.addContextSection("My Plugin", "This plugin provides my_tool for...");
  context.logger.info("My Plugin registered");
}

export async function cleanup() {
  // Called when plugin is unloaded
}
```

4. Copy `src/index.js` to `dist/index.js` (or compile if using TypeScript)

5. Submit a PR to this repo adding your plugin to `registry.json`

### Plugin Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Lowercase hyphenated slug (e.g. `my-plugin`) |
| `name` | Yes | Human-readable name |
| `version` | Yes | Semantic version |
| `description` | Yes | One-sentence description |
| `entryPoint` | No | Entry file path (default: `dist/index.js`) |
| `permissions` | Yes | Required permissions array |
| `configSchema` | No | Settings UI fields |
| `providesTools` | No | Tool names this plugin registers |
| `providesHandlers` | No | WS handler types |
| `dependencies` | No | Plugin IDs this depends on |
| `source` | No | Origin: `{ type: "npm"\|"git", package?, repo? }` |

### Available Permissions

| Permission | Grants |
|-----------|--------|
| `tools` | Register tools for agents |
| `ws-handlers` | Register WebSocket message handlers |
| `context` | Add sections to the agent system prompt |
| `config` | Read/write plugin configuration |
| `vault-read` | Read API keys from the vault |
| `network` | Make outbound network requests |
| `filesystem` | Access plugin data directory |
| `audio-input` | Capture audio from client |
| `audio-output` | Generate audio output |
| `webhooks` | Register HTTP routes on the gateway |
| `inbound-hooks` | Intercept incoming messages |

### Plugin Context API

Plugins receive a sandboxed `context` object in `register()`:

```javascript
// Tools (requires "tools" permission)
context.addTool(name, { description, parameters, execute })

// WebSocket handlers (requires "ws-handlers" permission)
context.addWsHandler(type, async (msg) => { return response; })

// System prompt (requires "context" permission)
context.addContextSection(label, markdownContent)

// Configuration (requires "config" permission)
context.getConfig()                    // Read current config
context.updateConfig({ key: value })   // Update config

// Vault (requires "vault-read" permission)
context.getVaultKey("openai")          // Read API key by provider name

// Logging (always available)
context.logger.info("message")
context.logger.warn("message")
context.logger.error("message")
```

### Important Constraints

- Entry point must be **ES module JavaScript** (`export`, not `module.exports`)
- **Cannot import** from `@tek/core` or workspace packages
- **Can import** from npm packages listed in your `package.json`
- Use `context.*` for all gateway interaction — no direct file/network access without permissions

## Submitting to the Registry

1. Fork this repo
2. Add your plugin entry to `registry.json`
3. Open a PR with:
   - Plugin ID, name, description
   - Link to your plugin's repo
   - List of permissions with justification
4. We'll review and merge

Plugins are installed disabled by default — users must explicitly enable them.
