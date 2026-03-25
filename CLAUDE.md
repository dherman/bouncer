# Bouncer — Claude Code Project Notes

## Running the Electron app from Claude Code

Claude Code sets `ELECTRON_RUN_AS_NODE=1` in its environment, which leaks into child processes and prevents Electron apps from starting (the `electron` module returns a path string instead of the API object). To run the app from Claude Code:

```sh
ELECTRON_RUN_AS_NODE= npm run dev
```

See: https://github.com/anthropics/claude-code/issues/34836

## Container sessions need ANTHROPIC_API_KEY

Claude Code authenticates via OAuth tokens stored in the macOS keychain, which Linux containers can't access. Container-based agent sessions require `ANTHROPIC_API_KEY` (a direct API key from https://console.anthropic.com):

```sh
export ANTHROPIC_API_KEY=sk-ant-api03-...
ELECTRON_RUN_AS_NODE= npm run dev
```

This only affects container sessions — safehouse (Seatbelt) sessions can access the keychain natively.
