# Shepherd

Shepherd は、Herdr 管理の coding agent を観測・操作する worker observability / orchestration layer です。Herdr 上の worker 状態を保存し、Pi などの orchestrator runtime に有用な signal を返します。

<!-- README-I18N:START -->

[English](./README.md) | **日本語**

<!-- README-I18N:END -->

Shepherd は LLM runtime ではなく、Herdr の薄いラッパーでもありません。Herdr は workspace、tab、pane、agent の低レベル操作を担当します。Shepherd はその上で次を提供します。

- 構造化された worker snapshot
- enriched `worker.*` event
- orchestrator への push notification

## はじめに

```bash
mise trust
mise install
pnpm install
pnpm check
pnpm build

shepherd daemon start
pi install ./packages/shepherd-pi
herdr plugin link ./packages/shepherd-herdr-plugin
```

## 要件

- Node.js 24.18.0 以上
- pnpm 11.9.0 以上
- Herdr 0.7.0 以上
- Pi runtime extension を使う場合は Pi

## 設定

Shepherd は `$SHEPHERD_HOME/config.yaml` を読みます。`SHEPHERD_HOME` が未設定の場合は `~/.shepherd` を使います。

```yaml
runtime:
  db_path: state.db
  socket_path: shepherd.sock
  pid_path: shepherd.pid
  log_path: logs/shepherd.log
observability:
  telemetry:
    max_excerpt_bytes: 4096
```

MVP では retention 設定はありません。Shepherd は sanitized worker event と snapshot を保持します。

## CLI 例

Herdr named session の workspace を観測します。

```bash
shepherd observe --herdr-session main --workspace w1 --json
```

現在の Herdr 管理 pane / workspace を観測します。

```bash
shepherd observe-current --json
```

worker snapshot を読みます。

```bash
shepherd snapshot ow_123 --json
```

cursor 以降の worker event を読みます。

```bash
shepherd events ow_123 --after 10 --json
```

notification を購読し、ack します。

```bash
shepherd notifications ow_123 --subscriber pi-session --auto-resume --json
shepherd ack --subscription ns_123 --event 42 --json
```

worker に semantic message を送り、worker state を待ちます。

```bash
shepherd message-worker wk_123 "please continue"
shepherd wait-worker wk_123 --state done --timeout-ms 600000
```

## Pi extension

`packages/shepherd-pi` は、Pi が Herdr 内で動いているときに現在の Herdr workspace を観測し、bounded runtime telemetry を Shepherd に送ります。Shepherd からの worker notification は Pi の status、widget、session entry、次 turn の hidden context に反映されます。

```bash
pi install ./packages/shepherd-pi
```

extension は excerpt、`sessionRef`、`artifactRefs` を送ります。hidden thinking や full tool result は送りません。

## Herdr plugin

`packages/shepherd-herdr-plugin` は companion plugin です。observe action と dashboard pane を提供しますが、Shepherd の主要 event stream ではありません。

```bash
herdr plugin link ./packages/shepherd-herdr-plugin
herdr plugin action invoke observe-workspace --plugin shepherd.observability
herdr plugin pane open --plugin shepherd.observability --entrypoint dashboard
```

## 開発コマンド

- `pnpm typecheck`: TypeScript check を実行します。
- `pnpm test`: Vitest unit / integration test を実行します。
- `pnpm lint`: Biome check を実行します。
- `pnpm format:check`: Biome formatting を確認します。
- `pnpm db:generate`: `src/db/schema.ts` から Drizzle migration を生成します。
- `pnpm db:check`: Drizzle migration と schema の整合性を確認します。
- `pnpm pi-package:check`: Pi extension を typecheck し、dry pack します。
- `pnpm herdr-plugin:check`: Herdr plugin を typecheck し、dry pack します。
- `pnpm check`: full quality gate を実行します。
- `pnpm build`: `dist` を生成し、TS path alias を書き換えます。

## プロジェクト構成

- `src/observability`: worker contract、telemetry normalization、rules、notification service、`WorkerStatePipeline`。
- `src/daemon`: JSON Lines RPC server/client と daemon service。
- `src/db`: SQLite connection、migration、Drizzle schema、observability store。
- `src/herdr`: Herdr socket client、session snapshot、workspace resolution helper。
- `src/cli`: `shepherd` CLI。
- `packages/shepherd-pi`: Pi extension package。
- `packages/shepherd-herdr-plugin`: Herdr companion plugin package。
- `test/unit`: pure logic / contract test。
- `test/integration`: SQLite / JSONL integration test。
- `docs/plans`: active implementation plan。完了済み plan は `docs/plans/archived` にあります。

## ライセンス

[MIT](LICENSE)
