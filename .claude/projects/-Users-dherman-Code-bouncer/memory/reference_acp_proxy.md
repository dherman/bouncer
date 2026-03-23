---
name: ACP proxy interception
description: David has a separate repo with ACP proxy implementation for tool call interception, relevant to M5-6 application-layer policies
type: reference
---

David has implemented an ACP proxy design (from an ACP committee proposal) in a separate repo. This enables intercepting agent tool calls at the protocol level — useful for application-layer policies like restricting git operations or network allowlisting that can't be enforced by OS-level sandboxing alone. Revisit when scoping Milestones 5-6.
