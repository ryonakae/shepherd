# shepherd-pi

Pi extension for Shepherd agent history and orchestrator-routed updates.

This package contains the runtime extension only. The Agent Skill remains at the repository root.

When Pi runs inside Herdr, this extension connects to the Shepherd daemon and injects compact current-workspace agent history before every turn. All connected Pi instances receive that context. Pushed unread agent updates go only to the explicitly selected Shepherd orchestrator terminal.

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

`on` claims the role for the current Herdr terminal and replaces any owner in the same Herdr session/workspace. Only the owner displays `Shepherd: orchestrator` in the footer. `off` releases the role only when run by the owner. With no owner, agent updates are not pushed.

The daemon persists the role across brief reconnects and Pi session replacement. The role follows the same Herdr terminal when its pane moves to another workspace; it clears after the terminal remains disconnected beyond the grace period.
