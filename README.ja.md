# Shepherd

Herdr 管理下のコーディングエージェントを観測し、作業状態を保存して、Pi などのオーケストレーターに通知を送ります。

<!-- README-I18N:START -->

[English](./README.md) | **日本語**

<!-- README-I18N:END -->

Shepherd では、観測中の Herdr ワークスペース内で動く 1 つのコーディングエージェント実行を「ワーカー」と呼びます。エージェントがペインやタブを移動しても、Shepherd は状態、イベント、通知を同じワーカーの記録として扱います。

- **ワーカーのスナップショット:** 要約、現在の作業、完了状態、停止理由、推奨アクション、信頼度、根拠を記録します。
- **ワーカーイベント:** 完了、停止、入力要求、ツール失敗、要約更新、状態変化を `worker.*` event として保存します。
- **実行環境への通知:** 未読のワーカーイベントを CLI subscriber と Pi extension に届けます。
- **Herdr 連携:** Herdr の socket/session API でワークスペースを観測し、Herdr snapshot から live workspace / worker state を解決します。
- **実行環境ブリッジ:** Pi extension がテレメトリーと通知コンテキストを扱い、Herdr plugin が observe action と dashboard pane を提供します。

## Herdr と Shepherd

Herdr はワークスペース、ペイン、エージェントをリアルタイムに操作します。Shepherd は実行中のワーカー状態を、後から参照できるコンテキストとして保存します。

- **ワーカー記録:** Herdr session、pane、runtime telemetry を worker id に結び、タブ移動後も同じワーカーとして扱います。
- **状態スナップショット:** terminal/session の事実を snapshot に変換し、オーケストレーターが pane buffer を読まずに状態を確認できます。
- **イベント履歴:** worker event と notification cursor を保存し、別プロセスは最後に ack した event から再開できます。
- **Pi コンテキスト:** 未読のワーカーイベントを Pi status、widget、session entry、次 turn の hidden context に届けます。

## 要件

Node.js 24.18.0 以上、pnpm 11.9.0 以上、Herdr 0.7.0 以上。`packages/shepherd-pi` を使う場合は Pi も必要です。

## はじめに

```bash
mise trust
mise install
pnpm install
pnpm check
pnpm build

node dist/src/cli/shepherd.js daemon start
pi install ./packages/shepherd-pi

# 公開 GitHub repository から release install する場合:
herdr plugin install ryonakae/shepherd/packages/shepherd-herdr-plugin --ref v0.1.0

# ローカル checkout を開発用に使う場合:
herdr plugin link ./packages/shepherd-herdr-plugin
```

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

Shepherd はサニタイズ済みのワーカーイベントとスナップショットを保存します。保持期間の設定は将来のスキーマ変更で追加します。

## CLI 使用例

```bash
node dist/src/cli/shepherd.js observe --herdr-session main --workspace w1 --json
node dist/src/cli/shepherd.js observe-current --json
node dist/src/cli/shepherd.js snapshot ow_123 --json
node dist/src/cli/shepherd.js events ow_123 --after 10 --json
node dist/src/cli/shepherd.js notifications ow_123 --subscriber pi-session --auto-resume --json
node dist/src/cli/shepherd.js ack --subscription ns_123 --event 42 --json
node dist/src/cli/shepherd.js message-worker wk_123 "please continue"
node dist/src/cli/shepherd.js wait-worker wk_123 --state done --timeout-ms 600000
```

後続コマンドでは `observe`、`snapshot`、`notifications` が返す id を使います。

## パッケージ

| Package | 役割 |
|---------|------|
| [`packages/shepherd-pi`](packages/shepherd-pi) | サニタイズ済みテレメトリーを送り、ワーカー通知を受け取る Pi extension。 |
| [`packages/shepherd-herdr-plugin`](packages/shepherd-herdr-plugin) | observe action と dashboard pane を提供する Herdr companion plugin。 |

## よく使うコマンド

```bash
pnpm test                 # Vitest test
pnpm check                # full quality gate
pnpm build                # dist 生成と TS path alias rewrite
pnpm db:generate          # Drizzle migration を生成
pnpm pi-package:check     # Pi extension package を確認
pnpm herdr-plugin:check   # Herdr plugin package を確認
```

## ライセンス

[MIT](LICENSE)
