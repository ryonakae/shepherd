![Shepherd cover](./assets/shepherd-cover.png)

# Shepherd

<!-- README-I18N:START -->

[English](./README.md) | **日本語**

<!-- README-I18N:END -->

Shepherd は Herdr 内で動くコーディングエージェントの作業状態を保存し、人間、Herdr プラグイン、Pi、シェルコマンドから読めるようにします。

Shepherd では、**ワーカー** は追跡対象になった 1 つのコーディングエージェント実行を指します。ワーカー記録には、そのエージェントの状態、要約、停止理由、推奨アクション、根拠が残ります。

- **長く使えるワーカー記録:** Herdr のワークスペース、ペイン、実行時テレメトリを安定したワーカー記録にまとめます。
- **読みやすいスナップショット:** 状態、要約、停止理由、推奨アクション、信頼度、根拠を SQLite に保存します。
- **ワーカーイベント:** 完了、停止、入力待ち、ツール失敗、要約更新、状態変化を `worker.*` イベントとして記録します。
- **オーケストレーター通知:** 未読のワーカーイベントを CLI の購読者と Pi 拡張に届けます。
- **Runtime bridge:** Pi 拡張はサニタイズ済み telemetry を送ります。Herdr plugin は `context` action と worker dashboard pane を追加します。

## 役割

ブリッジを使う前に Shepherd デーモンを起動します。デーモンは `$SHEPHERD_HOME` 配下の SQLite データベースと JSON Lines ソケットを管理します。`SHEPHERD_HOME` が未設定なら `~/.shepherd` を使います。CLI、Pi 拡張、Herdr プラグインはこのデーモンに接続します。

Herdr はワークスペース、タブ、ペイン、エージェントを操作します。Pi はモデルとの会話を扱います。Shepherd はワーカーの状態と通知履歴を保存します。

## Shepherd を使う理由

Herdr は人間とエージェントの操作面です。ワークスペース、タブ、ペイン、エージェント状態、コマンド実行を扱います。Shepherd はそれらのエージェント実行の共有メモリとして、ワーカーのスナップショット、要約、停止理由、推奨アクション、根拠、イベント、未読通知を保存します。

Shepherd Agent Skill を入れると、エージェントは `shepherd context --json` から始められます。他のワーカーの状態を読んでから、自分が次に何をするべきか判断できます。ペインやエージェントを操作するのは Herdr、長く残る worker context を読むのは Shepherd です。

## 要件

Node.js 24.18.0 以上、pnpm 11.9.0 以上、Herdr プラグインを使う場合は Herdr 0.7.0 以上、Pi 拡張を使う場合は Pi が必要です。下の手順では mise で Node.js と pnpm を入れます。

## ソースチェックアウトから起動する

```bash
git clone https://github.com/ryonakae/shepherd.git
cd shepherd
mise trust
mise install
pnpm install
pnpm build
node dist/src/cli/shepherd.js daemon start
node dist/src/cli/shepherd.js daemon status
```

Pi や Herdr が Shepherd の情報を読む間は、デーモンを起動したままにします。

## Runtime bridge を追加する

```bash
pi install ./packages/shepherd-pi
herdr plugin install ryonakae/shepherd/packages/shepherd-herdr-plugin --ref v0.1.0
```

## ワーカーコンテキストを読む

エージェントは [`SKILL.md`](SKILL.md) を読んでください。Herdr 管理下のペインでは、最初にこの 1 コマンドを使います。

```bash
shepherd context --json
```

ソースチェックアウトでは、ビルド済み CLI から同じコマンドを実行します。

```bash
node dist/src/cli/shepherd.js context --json
```

人間が同じ現在の workspace context を見る場合は、Herdr plugin action を使えます。

```bash
herdr plugin action invoke context --plugin shepherd.observability
```

未読のワーカー通知が必要なときだけ `--subscriber shepherd-agent` を付けます。`--subscriber` を付けない場合、`context` は現在のスナップショットと `notifications: { "subscription": null, "events": [] }` を返します。

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
## パッケージ

| パッケージ | 役割 |
|------------|------|
| [`packages/shepherd-pi`](packages/shepherd-pi) | テレメトリとワーカー通知を扱う Pi 拡張。 |
| [`packages/shepherd-herdr-plugin`](packages/shepherd-herdr-plugin) | `context` action と dashboard pane を提供する Herdr plugin。 |

## ライセンス

[MIT](LICENSE)
