# Shepherd

Shepherd は Herdr 上の agent と agent history を index し、coding agent が terminal pane を読まずに短い文脈を取得できるようにする daemon / CLI です。

Herdr は workspace、tab、pane、terminal I/O の操作面です。Shepherd は running Herdr sessions を読み、agent history file を発見し、compact history を cache し、Pi などの integration へ agent update を届けます。

## daemon を起動する

Shepherd の agent command は daemon が必要です。daemon は `herdr session list --json` に出る running session を監視し、60 秒ごとに再スキャンします。

```bash
shepherd daemon start
```

stopped Herdr session は対象外です。

## 主なコマンド

Herdr workspace 内では current workspace が自動で使われます。

```bash
shepherd agent list --json
shepherd agent get claude --json
shepherd agent read claude --limit 20 --json
```

Herdr 外から読む場合は scope を明示します。

```bash
shepherd agent list --all --json
shepherd agent list --workspace wB --json
shepherd agent get claude --workspace wB --json
shepherd agent read wB:p2 --workspace wB --limit 20 --json
```

同じ workspace id や agent name が複数の running Herdr session にある場合は `--session <name>` を付けます。

## 返す内容

- `shepherd agent list`: 選択 workspace の agent 一覧と、最後の user / assistant message。
- `shepherd agent get <target>`: 1 agent の metadata と compact history。最新の compact tool result も含みます。
- `shepherd agent read <target> --limit N`: 直近 N 件の user / assistant / compact `tool_result` messages。

`<target>` は Herdr に合わせ、pane id、terminal id、または scope 内で一意な agent name を使えます。

## Pi extension

`shepherd-pi` extension は Pi の turn 前に current workspace の compact agent history を hidden context として注入できます。daemon から unread agent update も受け取り、compact history と一緒に次 turn へ渡します。

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
