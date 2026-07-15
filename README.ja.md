![Shepherd cover](./assets/shepherd-cover.png)

# Shepherd

<!-- README-I18N:START -->
[English](./README.md) | **日本語**
<!-- README-I18N:END -->

Shepherd は、Herdr で動いている他の agent の状態と短い履歴を CLI から読めるようにするツールです。

Herdr の `herdr agent read` でも別 agent の出力を読むことはできます。ただしこれは terminal stream や scrollback を読む方式なので、agent の履歴を構造的に取得しづらく、余分な出力も含まれます。Shepherd は agent のセッションデータを読み取り、別 agent の作業状況、最新メッセージの抜粋、unread agent update を扱いやすい形にして提供します。

現在は Claude Code、Codex、Gemini CLI、OpenCode、Pi のセッション履歴の取得に対応しています。

## 要件

- Node.js >= 24.18.0
- pnpm >= 11.9.0
- Herdr >= 0.7.0
- `shepherd-pi` を使う場合は Pi >= 0.80.6

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

- `shepherd agent list`: 選択した workspace の agent 一覧と、最後の user / assistant message を返します。
- `shepherd agent get <target>`: 1 agent の metadata と compact history を返します。最新の compact tool result も含みます。
- `shepherd agent read <target> --limit N`: 直近 N 件の user / assistant / compact `tool_result` message を返します。

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

`<target>` には、Herdr の慣例に合わせて pane id、terminal id、または scope 内で一意な agent name を指定できます。同じ workspace id や agent name が複数の running Herdr session にある場合は `--session <name>` を付けます。

## Agent Skill

Agent Skill を追加する前に、Shepherd CLI をインストールして daemon を起動します。次のコマンドで、対応する coding agent に Shepherd の手順を追加します。

```bash
npx skills add ryonakae/shepherd --skill shepherd -g
```

Shepherd skill は agent の status、compact history、直近の tool result を構造化データとして読み取ります。agent の確認だけなら、Shepherd skill を単独で使えます。

workspace、tab、pane、terminal input/output、wait も agent から操作する場合は、公式 Herdr skill を追加します。

```bash
npx skills add ogulcancelik/herdr --skill herdr -g
```

## Pi extension

`shepherd-pi` extension には Pi 0.80.6 以降が必要です。Pi が Herdr 内で動くと Shepherd daemon に接続し、接続中のすべての Pi は turn 前に current workspace の compact agent history を hidden context として受け取ります。

Pi で `/shepherd orchestrator on` を入力すると、その terminal を workspace のオーケストレーターとして明示的に選べます。選ばれた Pi は、完了または blocked になった Worker の結果を受け取り、visible な Shepherd turn を1回自動で開始します。Worker の出力は信頼できない参考情報として扱い、Pi は既存の user request に必要な作業だけを続けます。`N pending worker updates` は footer に残り、そのupdateを含むturnが最終assistant responseを生成してsettleし、元のeventをすべてacknowledgeすると消えます。

role の確認には `/shepherd orchestrator` または `/shepherd orchestrator status` を使います。owner が `/shepherd orchestrator off` を実行すると自動wakeが止まり、roleが解除されます。owner がいない間は結果を配信せず、その間に発生した結果は後からclaimしてもreplayしません。reload、reconnect、別Piによる直接のowner交代では、未acknowledgedの結果を保持します。role は Pi session の切り替えや pane の移動後も同じ Herdr terminal に追従し、その terminal が grace period を超えて切断された場合は解除されます。Pi footer に `Shepherd: orchestrator` を表示するのは owner だけです。

## Herdr plugin

`shepherd-herdr-plugin` は任意の Herdr plugin です。Herdr workspace 内で Shepherd daemon に接続し、current workspace の compact agent row を Herdr UI に表示します。Shepherd の CLI や Pi extension を使うだけなら必須ではありません。

## パッケージ

| Path | Purpose |
| --- | --- |
| `packages/shepherd-pi` | agent history と agent update の Pi extension。 |
| `packages/shepherd-herdr-plugin` | Herdr UI に compact agent row を表示する任意の plugin。 |

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
