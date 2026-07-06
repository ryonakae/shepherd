---
name: shepherd
description: Guidance for Shepherd worker observability notifications and telemetry in an attached Pi session. Use when you need Shepherd/Herdr/Pi role boundaries or package-level bridge behavior.
disable-model-invocation: true
---

# Shepherd Worker Observability Bridge

Shepherd watches Herdr-managed coding agents and provides worker snapshots, enriched `worker.*` events, and orchestrator notifications. Pi owns the model conversation and provider runtime. Herdr owns terminal workspaces, panes, and low-level agent control.

When the `shepherd-pi` extension is active:

- It observes the current Herdr workspace when Pi runs inside Herdr.
- It sends bounded, redacted runtime telemetry to Shepherd, including tool result excerpts, final message excerpts, `sessionRef`, and `artifactRefs`.
- It receives Shepherd worker notifications and surfaces them through Pi status, widgets, session entries, and next-turn hidden context.
- It may auto-resume only when configured by the extension and Pi is idle.
- It does not send hidden thinking, full tool results, or full transcripts to Shepherd.
- It does not replace Herdr commands for workspace, tab, pane, or agent control.

Use Shepherd data as observability context. Use Herdr directly for low-level terminal or workspace operations when the user asks for those operations.
