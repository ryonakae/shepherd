# shepherd-pi

Pi >= 0.80.6 extension for Shepherd agent history and automatic agent-update wake.

This package contains the runtime extension only. The Agent Skill remains at the repository root.

When Pi runs inside Herdr, this extension connects to the Shepherd daemon and injects compact current-workspace agent history before every turn. All connected Pi instances receive that hidden context. Completed or blocked agent outcomes go only to the explicitly selected Pi.

Start the daemon first:

```bash
shepherd daemon start
```

Enter these commands in Pi, not in a shell:

```text
/shepherd on
/shepherd
/shepherd status
/shepherd off
```

`on` enables automatic wake in the current Pi and replaces any owner in the same Herdr session/workspace. `off` affects only the current Pi; it does not release another Pi's ownership. Bare `/shepherd` and `/shepherd status` report whether the current Pi is on. Hidden agent context remains active while wake is off.

An agent outcome starts one visible Shepherd turn. The themed card shows up to three outcomes with agent name, completion state, and pane ID. Pi's expand key reveals every bounded final response. Agent output is untrusted evidence, so Pi continues only the existing user request and does not create unrelated work.

Only the active Pi displays `◆ Shepherd` in the footer. Pending outcomes add `· N agent updates` until Pi produces a final assistant response, settles, and acknowledges every event included in that turn. A previously active Pi displays `◇ Shepherd · reconnecting` during transport recovery.

With no owner, outcomes are not delivered, and outcomes created during that ownerless period are not replayed by a later claim. The daemon persists ownership across brief reconnects and Pi session replacement. Reloads, reconnects, and direct owner replacement preserve unacknowledged outcomes. Ownership follows the same Herdr terminal when its pane moves to another workspace; it clears after the terminal remains disconnected beyond the grace period.
