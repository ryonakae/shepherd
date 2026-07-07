# Shepherd

Shepherd は Herdr 内で動く coding agent の worker 状態を保存し、人間、Herdr plugin、Pi、shell command から読めるようにします。

<!-- README-I18N:START -->

[English](./README.md) | **日本語**

<!-- README-I18N:END -->

- **長く使える worker 記録:** Herdr workspace、pane、runtime telemetry を安定した worker record にまとめます。
- **読みやすい snapshot:** 状態、要約、停止理由、推奨アクション、信頼度、根拠を SQLite に保存します。
- **worker event:** 完了、停止、入力待ち、tool 失敗、要約更新、状態変化を `worker.*` event として記録します。
- **orchestrator notification:** 未読の worker event を CLI subscriber と Pi extension に届けます。
- **runtime bridge:** Pi extension はサニタイズ済み telemetry を送ります。Herdr plugin は `context` action と worker dashboard pane を追加します。

## 役割

bridge を使う前に Shepherd daemon を起動します。daemon は `$SHEPHERD_HOME` 配下の SQLite database と JSON Lines socket を管理します。`SHEPHERD_HOME` が未設定なら `~/.shepherd` を使います。CLI、Pi extension、Herdr plugin はこの daemon に接続します。

Herdr は workspace、tab、pane、agent を操作します。Pi は model conversation を扱います。Shepherd は worker の状態と notification 履歴を保存します。

## 要件

Node.js 24.18.0 以上、pnpm 11.9.0 以上、Herdr plugin を使う場合は Herdr 0.7.0 以上、Pi extension を使う場合は Pi が必要です。下の手順では mise で Node.js と pnpm を入れます。

## source checkout から起動する

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

Pi や Herdr が Shepherd の情報を読む間は、daemon を起動したままにします。

## runtime bridge を追加する

```bash
pi install ./packages/shepherd-pi
herdr plugin install ryonakae/shepherd/packages/shepherd-herdr-plugin --ref v0.1.0
```

開発中の local checkout を使う場合は、tag 版を install せずに `herdr plugin link ./packages/shepherd-herdr-plugin` を使います。

## worker context を読む

agent は [`SKILL.md`](SKILL.md) を読んでください。Herdr 管理下の pane では、最初にこの 1 コマンドを使います。

```bash
shepherd context --json
```

source checkout では built CLI から同じ command を実行します。

```bash
node dist/src/cli/shepherd.js context --json
```

人間が同じ current workspace context を見る場合は、Herdr plugin action を使えます。

```bash
herdr plugin action invoke context --plugin shepherd.observability
```

未読の worker notification が必要なときだけ `--subscriber shepherd-agent` を付けます。`--subscriber` を付けない場合、`context` は current snapshot と `notifications: { "subscription": null, "events": [] }` を返します。

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

`node dist/src/cli/shepherd.js help` で daemon、context、observe、snapshot、event、notification、ack、worker command を確認できます。

## パッケージ

| Package | 役割 |
|---------|------|
| [`packages/shepherd-pi`](packages/shepherd-pi) | telemetry と worker 通知を扱う Pi extension。 |
| [`packages/shepherd-herdr-plugin`](packages/shepherd-herdr-plugin) | `context` action と dashboard pane を提供する Herdr plugin。 |

## ライセンス

[MIT](LICENSE)
