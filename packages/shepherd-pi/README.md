# shepherd-pi

Pi extension for Shepherd agent history.

When Pi runs inside Herdr, this extension connects to the Shepherd daemon, subscribes to current-workspace agent updates, and injects compact agent history before a turn.

Start the daemon first:

```bash
shepherd daemon start
```

Useful CLI commands:

```bash
shepherd agent list --json
shepherd agent get claude --json
shepherd agent read claude --limit 20 --json
```
