# ACP SDK API Deviations from Design/Plan Pseudocode

Discovered during Phase 2 implementation against `@agentclientprotocol/sdk` v0.16.x.

## SessionUpdate discriminator field

**Plan assumed:** `update.type` (e.g. `{ type: "agent_message_chunk", text: chunk }`)

**Actual:** `update.sessionUpdate` (e.g. `{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } }`)

The `SessionUpdate` is a discriminated union on the `sessionUpdate` field, and text content is wrapped in a `content: ContentBlock` object rather than being a flat `text` field.

## PROTOCOL_VERSION is a number

**Plan assumed:** String like `"2025-03-26"`

**Actual:** `PROTOCOL_VERSION = 1` (a number)

## Agent interface method signatures

**Plan assumed:** `loadSession`, `authenticate`, `setSessionMode` as required stubs

**Actual:** Only `initialize`, `newSession`, `prompt`, and `cancel` are required. `loadSession`, `authenticate`, `setSessionMode`, and several `unstable_*` methods are optional.

## cancel() return type

**Plan assumed:** `return {}`

**Actual:** `Promise<void>` — return nothing

## Client interface

**Plan assumed:** Many required methods (`readTextFile`, `writeTextFile`, `createTerminal`, etc.)

**Actual:** Only `requestPermission` and `sessionUpdate` are required. File and terminal methods are all optional.

## ndJsonStream argument order

**Plan noted:** `ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))`

**Actual:** Same — first arg is output (writable), second is input (readable). This is correct but counterintuitive since the agent's stdout is the _output_ it writes to, and stdin is the _input_ it reads from.

## ESM requirement

The ACP SDK is published as ESM. The project needs `"type": "module"` in package.json for tsx to handle top-level await in scripts. This also changes electron-vite's preload output from `index.js` to `index.mjs`.

## AgentCapabilities shape

**Plan assumed:** `{ streaming: true }`

**Actual:** `{ loadSession: boolean }` — there is no `streaming` capability flag. The SDK example uses `{ loadSession: false }`.
