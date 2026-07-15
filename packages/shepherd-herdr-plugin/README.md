# shepherd-herdr-plugin

Herdr companion plugin for Shepherd agent history. Herdr installs this integration from the Shepherd GitHub repository; it is not published to npm.

Install the plugin from a release tag:

```bash
herdr plugin install ryonakae/shepherd/packages/shepherd-herdr-plugin --ref v0.3.1 --yes
```

The plugin requires the Shepherd CLI and daemon:

```bash
npm install --global @ryonakae/shepherd
shepherd daemon start
```

It shows compact rows from `shepherd agent list` for the current Herdr workspace and uses the daemon RPC method `agent.list` with `HERDR_WORKSPACE_ID`.
