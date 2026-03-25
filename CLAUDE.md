# Bouncer — Claude Code Project Notes

## Running the Electron app from Claude Code

Claude Code sets `ELECTRON_RUN_AS_NODE=1` in its environment, which leaks into child processes and prevents Electron apps from starting (the `electron` module returns a path string instead of the API object). To run the app from Claude Code:

```sh
ELECTRON_RUN_AS_NODE= npm run dev
```

See: https://github.com/anthropics/claude-code/issues/34836

## Container sessions need ANTHROPIC_API_KEY

Container-based agent sessions can't access the macOS keychain, so `ANTHROPIC_API_KEY` must be exported in the shell before launching the app:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
ELECTRON_RUN_AS_NODE= npm run dev
```

Without this, Claude Code sessions in containers will fail with "Authentication required".
