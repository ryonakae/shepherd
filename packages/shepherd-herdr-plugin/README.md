# shepherd-herdr-plugin

Herdr companion plugin for Shepherd agent history.

The plugin shows compact rows from `shepherd agent list` for the current Herdr workspace. Shepherd daemon must be running before invoking the plugin.

```bash
shepherd daemon start
```

The plugin uses the daemon RPC method `agent.list` with the current `HERDR_WORKSPACE_ID`.
