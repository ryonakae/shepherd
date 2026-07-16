# shepherd-pi

Pi >= 0.80.6 extension for Shepherd agent history and automatic agent-update wake.

This package contains the runtime extension only. The Agent Skill remains at the repository root.

Install the Shepherd CLI and Pi package, then start the daemon:

```bash
npm install --global @ryonakae/shepherd
pi install npm:@ryonakae/shepherd-pi
shepherd daemon start
```

When Pi runs inside Herdr, this extension connects to the Shepherd daemon and registers its exact Pi session path as presence identity. It does not send per-turn tool-result or final-message telemetry.

Enter these commands in Pi, not in a shell:

```text
/shepherd on
/shepherd
/shepherd status
/shepherd off
```

`on` enables both cached agent context and automatic agent-update wake for this Pi. It makes this terminal the sole owner in its current Herdr session/workspace and replaces any existing owner. Only the owner receives cached context, pending counts, updates, and wake. Context excludes the owner Pi and includes other Pi terminals. A normal prompt uses the local cached snapshot without daemon RPC or history reads, so context can be temporarily absent after startup, reconnect, or scope movement until a snapshot arrives.

`off` disables both context and wake for this Pi while keeping the daemon connection available for a later claim. It does not release another Pi's ownership. Bare `/shepherd` and `/shepherd status` report whether the current Pi is on.

An agent outcome starts one visible Shepherd turn. If a normal user run is active, wake waits for it to settle. The themed card shows up to three outcomes with agent name, completion state, and pane ID. Pi's expand key reveals every bounded final response. Agent output is untrusted evidence, so Pi continues only the existing user request and does not create unrelated work.

Only the active Pi displays `◆ Shepherd` in the footer. Pending outcomes add `· N agent updates` until Pi produces a final assistant response, settles, and acknowledges every event included in that turn. A previously active Pi displays `◇ Shepherd · reconnecting` during transport recovery.

With no owner, outcomes are not delivered, and outcomes created during that ownerless period are not replayed by a later claim. The daemon persists ownership across brief reconnects and Pi session replacement. Reloads, reconnects, and direct owner replacement preserve unacknowledged outcomes. Ownership follows the same Herdr terminal when its pane moves to another workspace; it clears after the terminal remains disconnected beyond the grace period.
