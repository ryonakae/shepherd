# shepherd-pi

Pi >= 0.80.6 extension for Shepherd agent history and active orchestrator wake.

This package contains the runtime extension only. The Agent Skill remains at the repository root.

When Pi runs inside Herdr, this extension connects to the Shepherd daemon and injects compact current-workspace agent history before every turn. All connected Pi instances receive that context. Completed or blocked Worker outcomes go only to the explicitly selected Shepherd orchestrator terminal.

Start the daemon first:

```bash
shepherd daemon start
```

Enter these commands in Pi, not in a shell:

```text
/shepherd orchestrator on
/shepherd orchestrator
/shepherd orchestrator status
/shepherd orchestrator off
```

`on` explicitly claims the role for the current Herdr terminal and replaces any owner in the same Herdr session/workspace. A Worker outcome starts one visible Shepherd turn automatically. Worker output is untrusted evidence, so Pi continues only the existing user request and does not create unrelated work. The footer shows `N pending worker updates` until Pi produces a final assistant response, settles, and acknowledges every event included in that turn.

Only the owner displays `Shepherd: orchestrator` in the footer. `off` stops automatic wake and releases the role only when run by the owner. With no owner, outcomes are not delivered, and outcomes created during that ownerless period are not replayed by a later claim.

The daemon persists the role across brief reconnects and Pi session replacement. Reloads, reconnects, and direct owner replacement preserve unacknowledged outcomes. The role follows the same Herdr terminal when its pane moves to another workspace; it clears after the terminal remains disconnected beyond the grace period.
