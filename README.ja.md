# Shepherd

Shepherd は、Herdr で動いている他の agent の状態と履歴を、terminal pane を読まずに短く取得できるようにします。

<!-- README-I18N:START -->
[English](./README.md) | **日本語**
<!-- README-I18N:END -->

Herdr は workspace、tab、pane、terminal I/O の操作を担います。Shepherd は実行中の Herdr session を追跡し、agent history file から短い履歴をキャッシュして、Pi などの連携先へ agent update を届けます。

## Shepherd を使う意味

- **CLI から agent の文脈を読む:** terminal pane を読み直さず、別 agent の作業状況を確認できます。
- **短い履歴を取得する:** 履歴全文を読み込まず、最新の user / assistant / tool-result の抜粋だけを取得できます。
- **Pi と Herdr に接続する:** current workspace の agent history と unread agent update を Pi に渡し、Herdr には短い agent row を表示できます。

## 要件

- Node.js >= 24.18.0
- pnpm >= 11.9.0
- socket API support を備えた Herdr

## ソースからインストールする

```bash
git clone https://github.com/ryonakae/shepherd.git
cd shepherd
pnpm install
pnpm build
npm install -g . --ignore-scripts
shepherd help
```

## daemon を起動する

Shepherd の agent command は daemon を必要とします。daemon は `herdr session list --json` に出る実行中の Herdr session を監視し、60 秒ごとに再スキャンします。停止した Herdr session は index しません。runtime file は標準で `~/.shepherd` に置きます。別の directory を使う場合は `SHEPHERD_HOME` を設定します。

```bash
shepherd daemon start
```

## 主なコマンド

Herdr workspace 内では、Shepherd が current workspace を自動で選びます。

```bash
shepherd agent list --json
shepherd agent get claude --json
shepherd agent read claude --limit 20 --json
```

Herdr の外から読む場合は scope を指定します。

```bash
shepherd agent list --all --json
shepherd agent list --workspace wB --json
shepherd agent get claude --workspace wB --json
shepherd agent read wB:p2 --workspace wB --limit 20 --json
```

同じ workspace id や agent name が複数の running Herdr session にある場合は `--session <name>` を付けます。

## 返す内容

- `shepherd agent list`: 選択した workspace の agent 一覧と、最後の user / assistant message。
- `shepherd agent get <target>`: 1 agent の metadata と compact history。最新の compact tool result も含みます。
- `shepherd agent read <target> --limit N`: 直近 N 件の user / assistant / compact `tool_result` message。

`<target>` には、Herdr の慣例に合わせて pane id、terminal id、または scope 内で一意な agent name を指定できます。

## Pi extension

`shepherd-pi` extension は、Pi が Herdr 内で動くと Shepherd daemon に接続します。Pi の turn 前に、current workspace の compact agent history を hidden context として注入します。daemon から unread agent update も受け取り、次の turn に含めます。

## パッケージ

| Path | Purpose |
| --- | --- |
| `packages/shepherd-pi` | agent history と agent update の Pi extension。 |
| `packages/shepherd-herdr-plugin` | compact Shepherd agent row を表示する Herdr plugin。 |

## 開発

```bash
pnpm install
pnpm check
pnpm build
```

DB schema を変えたら次も実行します。

```bash
pnpm db:generate
pnpm db:check
```

## ライセンス

[MIT](./LICENSE)
