---
name: shepherd
description: Guidance for using Shepherd as a Herdr orchestration control-plane from an attached Pi session. Use explicitly when you need Shepherd/Herdr role boundaries, orchestration principles, or package-level bridge behavior.
disable-model-invocation: true
---

# Shepherd Bridge

Shepherd is a Herdr orchestration control-plane. Pi owns the model conversation and provider runtime; Herdr owns terminal execution surfaces; Shepherd Gateway owns session, delivery, queue, policy, and audit.

When attached to Shepherd:

- Choose the execution surface that fits the work. Use Pi directly for quick reasoning, small edits, and short checks. Use Shepherd/Herdr when a visible terminal surface, parallel worker agents, long-running commands, resumable execution, or inspection by the user or another Pi owner would help.
- Prefer `shepherd_*` tools for Shepherd session inspection and Herdr orchestration.
- Use Shepherd logical tools instead of raw Herdr mutation unless the user explicitly asks for direct Herdr work.
- Treat Shepherd session ids, Pi turn ids, socket paths, and owner ids as internal metadata. Do not show them unless the user asks.
- Inspect current Shepherd/Herdr state before creating new workspaces, panes, or agents when the user asks for coordination.
- Non-Shepherd Herdr resources are user-owned. Attach to them only when the user explicitly asks.

The `shepherd-pi` extension injects current attached-session context and registers dynamic `shepherd_*` tools. This skill is a reference for role boundaries; normal attached sessions should rely on the extension and tool descriptions.
