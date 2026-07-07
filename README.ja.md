# Shepherd

Shepherd は Herdr 内で動く coding agent を監視し、worker の状態を Pi、Herdr pane、shell command から読める形で保存します。

<!-- README-I18N:START -->

[English](./README.md) | **日本語**

<!-- README-I18N:END -->

- **pane 移動に強い worker 記録:** pane が変わっても、同じ coding agent run を同じ worker として扱います。
- **読みやすい snapshot:** 要約、状態、停止理由、推奨アクション、信頼度、根拠を SQLite に保存します。
- **worker event:** 完了、停止、入力待ち、tool 失敗、要約更新、状態変化を `worker.*` event として記録します。
- **オーケストレーター通知:** 未読の worker event を CLI subscriber と Pi extension に届けます。
- **runtime bridge:** Pi extension はサニタイズ済み telemetry を送り、worker 通知を次の turn に渡します。Herdr plugin は observe action と worker dashboard pane を追加します。

## 役割

bridge を使う前に Shepherd daemon を起動します。daemon は `$SHEPHERD_HOME` 配下の SQLite database と JSON Lines socket を管理します。`SHEPHERD_HOME` が未設定なら `~/.shepherd` を使います。CLI、Pi extension、Herdr plugin はこの daemon に接続します。

Herdr は workspace、tab、pane、agent を操作します。Pi は model conversation を扱います。Shepherd は worker の状態と履歴を保存します。

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

## Herdr workspace を観測する

daemon 起動後、Herdr 管理下の pane で実行します。

```bash
OBSERVED_WORKSPACE_ID=$(node dist/src/cli/shepherd.js observe-current --json | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => console.log(JSON.parse(s).observedWorkspace.id));')
node dist/src/cli/shepherd.js snapshot "$OBSERVED_WORKSPACE_ID" --json
node dist/src/cli/shepherd.js notifications "$OBSERVED_WORKSPACE_ID" --subscriber pi-session --json
```

Pi extension も同じ daemon socket を使います。tool result と最終 message の短い抜粋を Shepherd に送り、未読の worker 通知を次の Pi turn の hidden context に追加します。

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

`node dist/src/cli/shepherd.js help` で daemon、observe、snapshot、event、notification、ack、worker command を確認できます。

## パッケージ

| Package | 役割 |
|---------|------|
| [`packages/shepherd-pi`](packages/shepherd-pi) | telemetry と worker 通知を扱う Pi extension。 |
| [`packages/shepherd-herdr-plugin`](packages/shepherd-herdr-plugin) | observe action と dashboard pane を提供する Herdr plugin。 |

## 開発

```bash
pnpm check                # typecheck、test、Biome、Drizzle、Pi package、Herdr plugin を確認
pnpm build                # dist を生成し、TS path alias を書き換える
pnpm test                 # Vitest を 1 回実行
pnpm db:generate          # Drizzle migration を生成
pnpm pi-package:check     # Pi extension package を確認
pnpm herdr-plugin:check   # Herdr plugin package を確認
```

## ライセンス

[MIT](LICENSE)
